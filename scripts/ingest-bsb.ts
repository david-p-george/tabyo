/**
 * npm run ingest-bsb -- <mat|mrk|luk|jhn> [--force] [--dry-run]
 *
 * Converts a BSB source file into contract-compliant English base files:
 *
 *   data-prep/<slug>/<slug>.json       e.g. data-prep/mrk/mrk.json (the source drop)
 *   → data/base/english/<BOOK>/<chapter>.json with { book, chapter, source: "bsb",
 *     verses, headings?, paragraphs? }
 *
 * Source format (per .agent/samplebsb.json): { id: "MAT", numberOfChapters,
 * chapters: [{ numberOfVerses, chapter: { number, content: [...] } }] } where
 * content items are `verse` (number/text/footnotes/poem), `heading` (text), and
 * `line_break` (ignored).
 *
 * Transformations:
 * - verse text is whitespace-flattened (\n and runs of whitespace → single space,
 *   no poetry-aware display) and NFC-normalised;
 * - footnotes and poem ranges are DROPPED, but counted and reported;
 * - headings become BaseChapter.headings: [{ verse, text }] — verse = the first
 *   verse under the heading; consecutive/trailing headings are errors;
 * - paragraphs are copied (start/end only) from the already-ingested Greek base
 *   for the same book/chapter, since BSB has no paragraph data; a Greek
 *   paragraph referencing a verse absent from the English text is an error.
 *
 * Nothing is written on --dry-run; without --force, a run that would replace an
 * existing base file aborts before writing anything; any parse error also
 * aborts before the first write.
 */
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BaseChapter } from "../src/schemas.ts";
import { getBookMeta } from "../src/lib/books.ts";
import { loadBaseChapter, DATA_DIR } from "../src/lib/data.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREP_DIR = path.join(ROOT, "data-prep");
const OUT_ROOT = path.join(DATA_DIR, "base", "english");

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let errorCount = 0;
let warnCount = 0;

function error(msg: string): void {
  errorCount++;
  console.error(`${RED}[error]${RESET} ${msg}`);
}
function warn(msg: string): void {
  warnCount++;
  console.error(`${YELLOW}[warning]${RESET} ${msg}`);
}

const GOSPELS: Record<string, { code: string; name: string }> = {
  mat: { code: "MAT", name: "Matthew" },
  mrk: { code: "MRK", name: "Mark" },
  luk: { code: "LUK", name: "Luke" },
  jhn: { code: "JHN", name: "John" },
};

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** \n and whitespace runs become single spaces; leading/trailing space is removed. */
function flattenText(text: string): { text: string; flattened: boolean } {
  const flattened = /\r?\n/.test(text);
  const flat = text
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
  return { text: flat, flattened };
}

/* Source parsing ---------------------------------------------------- */

interface ChapterParsed {
  number: number;
  /** verse → flattened, NFC-normalised text (ascending insertion). */
  verses: Map<number, string>;
  /** heading text → (buffered) attached verse number, in encounter order. */
  headings: Array<{ verse: number; text: string }>;
  /** Bookkeeping for the report. */
  droppedFootnotes: number;
  droppedPoemVerses: number;
}

interface SourceParsed {
  id?: string;
  numberOfChapters?: number;
  chapters: Map<number, ChapterParsed>;
}

async function parseSource(file: string): Promise<SourceParsed | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      error(`missing ${file}`);
      return null;
    }
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (err) {
    error(`${file}: cannot parse JSON: ${(err as Error).message}`);
    return null;
  }

  const root = data as {
    id?: unknown;
    numberOfChapters?: unknown;
    chapters?: unknown;
  };
  const chapters = new Map<number, ChapterParsed>();

  // Top level
  if (typeof root.id !== "string") error(`${file}: missing/invalid "id"`);
  if (!Array.isArray(root.chapters)) error(`${file}: missing/invalid "chapters" array`);
  if (typeof root.numberOfChapters !== "number") warn(`${file}: no usable "numberOfChapters" declared by the source`);
  if (errorCount > 0) return null;
  const chapterList = root.chapters as unknown[];

  for (const [ci, entry] of chapterList.entries()) {
    const e = entry as { numberOfVerses?: unknown; chapter?: unknown };
    if (typeof e.chapter !== "object" || e.chapter === null) {
      error(`${file}: chapters[${ci}] has no "chapter" object`);
      continue;
    }
    const ch = e.chapter as { number?: unknown; content?: unknown };
    const chapterNo = ch.number;
    if (typeof chapterNo !== "number" || !Number.isInteger(chapterNo) || chapterNo < 1) {
      error(`${file}: chapters[${ci}].chapter.number is invalid`);
      continue;
    }
    if (chapters.has(chapterNo)) {
      error(`${file}: chapter ${chapterNo} appears more than once`);
      continue;
    }
    if (!Array.isArray(ch.content)) {
      error(`${file}: chapter ${chapterNo} has no "content" array`);
      continue;
    }

    const chapter: ChapterParsed = {
      number: chapterNo,
      verses: new Map(),
      headings: [],
      droppedFootnotes: 0,
      droppedPoemVerses: 0,
    };
    const bufferedHeadings: string[] = [];
    let lastVerse = 0;

    for (const [ii, item] of (ch.content as Array<Record<string, unknown>>).entries()) {
      const type = item.type;
      if (type === "line_break") continue;
      if (type === "heading") {
        if (bufferedHeadings.length > 0) {
          error(`${file}: chapter ${chapterNo} content[${ii}]: heading directly after another heading`);
          continue;
        }
        const text = typeof item.text === "string" ? item.text.trim() : "";
        if (text === "") {
          error(`${file}: chapter ${chapterNo} content[${ii}]: heading with empty text`);
          continue;
        }
        bufferedHeadings.push(text);
        continue;
      }
      if (type === "verse") {
        const verse = item.number;
        const rawText = item.text;
        if (typeof verse !== "number" || !Number.isInteger(verse) || verse < 1) {
          error(`${file}: chapter ${chapterNo} content[${ii}]: verse number is not an integer (${JSON.stringify(verse)})`);
          continue;
        }
        if (verse <= lastVerse) {
          error(`${file}: chapter ${chapterNo} content[${ii}]: verse ${verse} is out of order or duplicated (last was ${lastVerse})`);
          continue;
        }
        if (typeof rawText !== "string" || rawText.trim() === "") {
          error(`${file}: chapter ${chapterNo} content[${ii}]: verse ${verse} has empty/invalid text`);
          continue;
        }
        if (bufferedHeadings.length > 0) {
          for (const text of bufferedHeadings) {
            chapter.headings.push({ verse, text: text.normalize("NFC") });
          }
          bufferedHeadings.length = 0;
        }
        const footnotes = Array.isArray(item.footnotes) ? item.footnotes.length : 0;
        chapter.droppedFootnotes += footnotes;
        if (Array.isArray(item.poem) && item.poem.length > 0) chapter.droppedPoemVerses++;
        const { text } = flattenText(rawText);
        if (text === "") {
          error(`${file}: chapter ${chapterNo} content[${ii}]: verse ${verse} text flattens to empty`);
          continue;
        }
        chapter.verses.set(verse, text);
        lastVerse = verse;
        continue;
      }
      if (typeof type === "string") {
        // be strict about the types we agreed to; an unknown type means our
        // assumptions about this format are wrong, not that we skip quietly.
        error(`${file}: chapter ${chapterNo} content[${ii}]: unknown content type "${type}"`);
        continue;
      }
    }
    if (bufferedHeadings.length > 0) {
      for (const text of bufferedHeadings) {
        error(`${file}: chapter ${chapterNo}: heading "${text}" trails the chapter without a following verse`);
      }
    }

    if (typeof e.numberOfVerses === "number" && e.numberOfVerses !== chapter.verses.size) {
      error(`${file}: chapter ${chapterNo} declares ${e.numberOfVerses} verses but contains ${chapter.verses.size}`);
    }
    chapters.set(chapterNo, chapter);
  }

  // id / chapter-count agreement is checked by the caller
  return { id: root.id as string, numberOfChapters: root.numberOfChapters as number, chapters };
}

/* Paragraph reuse from the Greek side -------------------------------- */

async function greekParagraphs(book: string, chapter: number, englishVerses: Set<number>): Promise<Array<{ start: number; end: number }> | null> {
  const greek = await loadBaseChapter(book, "greek", chapter);
  if (greek === null) {
    warn(`no Greek base chapter for ${book} ${chapter} — paragraphs omitted`);
    return null;
  }
  const paragraphs = greek.paragraphs ?? [];
  if (paragraphs.length === 0) {
    warn(`Greek base chapter ${book} ${chapter} has no paragraph data — paragraphs omitted`);
    return null;
  }
  const out: Array<{ start: number; end: number }> = [];
  const missing: number[] = [];
  for (const p of paragraphs) {
    for (let n = p.start; n <= p.end; n++) {
      if (!englishVerses.has(n)) missing.push(n);
    }
    out.push({ start: p.start, end: p.end });
  }
  if (missing.length > 0) {
    const shown = missing.slice(0, 8).map(String).join(", ") + (missing.length > 8 ? `, … (${missing.length} total)` : "");
    error(
      `${book} chapter ${chapter}: Greek paragraph range(s) reference verse(s) with no English text (${shown}) — BSB/SBLGNT verse numbering differs here; resolve before ingesting.`
    );
    return null;
  }
  return out;
}

/* Main --------------------------------------------------------------- */

async function main(argv: string[]): Promise<number> {
  const slugArg = argv.find((a) => !a.startsWith("--"))?.toLowerCase();
  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");
  const gospel = slugArg ? GOSPELS[slugArg] : undefined;
  if (!gospel) {
    console.error("usage: npm run ingest-bsb -- <mat|mrk|luk|jhn> [--force] [--dry-run]");
    return 2;
  }
  if (dryRun) warn("dry run: nothing will be written");

  const srcFile = path.join(PREP_DIR, slugArg!, `${slugArg}.json`);
  const parsed = await parseSource(srcFile);
  if (parsed === null) return 1;
  const chapters = parsed.chapters;

  // Top-level agreement: id and numberOfChapters vs what the file actually contains.
  if (parsed.id !== gospel.code) error(`${srcFile}: "id" is ${JSON.stringify(parsed.id)}, expected "${gospel.code}"`);
  if (typeof parsed.numberOfChapters === "number") {
    for (let c = 1; c <= parsed.numberOfChapters; c++) {
      if (!chapters.has(c)) error(`${srcFile}: chapter ${c} of ${parsed.numberOfChapters} is missing`);
    }
    for (const c of chapters.keys()) {
      if (c > parsed.numberOfChapters) {
        error(`${srcFile}: chapter ${c} exceeds the declared numberOfChapters (${parsed.numberOfChapters})`);
      }
    }
  }

  const meta = getBookMeta(gospel.code);
  for (const c of chapters.keys()) {
    if (meta && c > meta.chapters) {
      error(`${gospel.name} has ${meta.chapters} chapters but the source contains chapter ${c}`);
    }
  }

  // Paragraph reuse (pulled from the already-ingested Greek base)
  const paragraphsByChapter = new Map<number, Array<{ start: number; end: number }>>();
  for (const c of chapters.keys()) {
    const greek = await greekParagraphs(gospel.code, c, new Set(chapters.get(c)!.verses.keys()));
    if (greek !== null) paragraphsByChapter.set(c, greek);
  }

  // Build contract objects (schema-checked) and write — all-or-nothing.
  const outDir = path.join(OUT_ROOT, gospel.code);
  const targets = [...chapters.keys()].sort((a, b) => a - b).map((c) => ({ chapter: c, file: path.join(outDir, `${c}.json`) }));

  const existing = [];
  for (const t of targets) {
    if (await exists(t.file)) existing.push(t.file);
  }
  if (existing.length > 0) {
    const msg = `${existing.length} target file(s) already exist, e.g. ${existing[0]}`;
    if (dryRun) {
      warn(`${msg} — --force would overwrite them.`);
    } else if (!force) {
      error(`${msg} — pass --force to overwrite (a run never partially writes).`);
      return 1;
    }
  }

  const built = [];
  for (const t of targets) {
    const chapter = chapters.get(t.chapter)!;
    const data: Record<string, unknown> = {
      book: gospel.code,
      chapter: t.chapter,
      source: "bsb",
      verses: Object.fromEntries(chapter.verses),
    };
    if (chapter.headings.length > 0) data.headings = chapter.headings;
    const paragraphs = paragraphsByChapter.get(t.chapter);
    if (paragraphs !== undefined && paragraphs.length > 0) data.paragraphs = paragraphs;

    const check = BaseChapter.safeParse(data);
    if (!check.success) {
      error(`${t.file}: generated file would NOT match the schema — aborting before write`);
      for (const issue of check.error.issues) {
        error(`  ${issue.path.map(String).join(".")}: ${issue.message}`);
      }
      return 1;
    }
    built.push({ t, text: JSON.stringify(data, null, 2) + "\n" });
  }

  if (!dryRun && errorCount > 0) {
    error(`aborting before write: ${errorCount} error(s) in the source must be fixed first`);
    return 1;
  }

  if (dryRun) {
    for (const t of targets) {
      const chapter = chapters.get(t.chapter)!;
      const paragraphs = paragraphsByChapter.get(t.chapter);
      console.log(
        `chapter ${t.chapter}: ${chapter.verses.size} verse(s), ${chapter.headings.length} heading(s), ` +
          `${chapter.droppedFootnotes} footnote(s) dropped, ${chapter.droppedPoemVerses} poem-marked verse(s) dropped — ` +
          `paragraphs: ${paragraphs === undefined ? "none available (warned)" : `${paragraphs.length} copied from Greek`}`
      );
    }
    const totalVerses = [...chapters.values()].reduce((n, ch) => n + ch.verses.size, 0);
    const totalFootnotes = [...chapters.values()].reduce((n, ch) => n + ch.droppedFootnotes, 0);
    console.log(
      `\n(dry run) ${chapters.size} chapter(s), ${totalVerses} verse(s), ${totalFootnotes} footnote(s) to drop` +
        ` → ${outDir}/<chapter>.json (${errorCount} error(s), ${warnCount} warning(s))`
    );
  } else {
    await mkdir(outDir, { recursive: true });
    for (const { t, text } of built) {
      await writeFile(t.file, text, "utf8");
      const chapter = chapters.get(t.chapter)!;
      console.log(
        `${GREEN}wrote${RESET} ${t.file} (${chapter.verses.size} verses, ${chapter.headings.length} heading(s), ` +
          `${paragraphsByChapter.get(t.chapter)?.length ?? 0} paragraphs)`
      );
    }
    const totalFootnotes = [...chapters.values()].reduce((n, ch) => n + ch.droppedFootnotes, 0);
    console.log(
      `\n✓ ${gospel.name} ingested: ${built.length} chapter(s) → data/base/english/${gospel.code}/` +
        `${totalFootnotes > 0 ? ` (${totalFootnotes} footnote(s) dropped by decision, not silently)` : ""}\n` +
        `  next: npm run validate`
    );
  }

  return errorCount > 0 ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
