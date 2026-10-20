/**
 * npm run ingest-sblgnt -- <mat|mrk|luk|jhn> [--force] [--dry-run]
 *
 * Converts a data-prep source drop into contract-compliant base files:
 *
 *   data-prep/<slug>/<slug>.txt                    e.g. data-prep/mrk/mrk.txt
 *   data-prep/<slug>/para-rows/<c>-para-rows.json  e.g. …/para-rows/1-para-rows.json
 *
 *   → data/base/greek/<BOOK>/<chapter>.json with { book, chapter, source: "sblgnt",
 *     verses, paragraphs: [{ start, end }] }
 *
 * Source format (per .agent/samplesblgnt.txt): one verse per line,
 * "<Prefix> <chapter>:<verse>\t<verse text>", no other line types. Verse text is
 * NFC-normalised and whitespace-trimmed on the way through; SBLGNT critical
 * signs (⸀, ⸂⸃ …) are kept verbatim. The paragraph-rows arrays must exactly
 * cover the verses in the text, contiguously and in ascending order.
 *
 * Nothing is written on --dry-run; without --force, a run that would replace an
 * existing base file aborts before writing anything.
 */
import { readFile, readdir, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BaseChapter } from "../src/schemas.ts";
import { getBookMeta } from "../src/lib/books.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREP_DIR = path.join(ROOT, "data-prep");
const OUT_ROOT = path.join(ROOT, "data", "base", "greek");

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

/** slug (lowercase file stem) → USFM code + the verse-line prefix used in the txt. */
const GOSPELS: Record<string, { code: string; prefix: string; name: string }> = {
  mat: { code: "MAT", prefix: "Mt", name: "Matthew" },
  mrk: { code: "MRK", prefix: "Mk", name: "Mark" },
  luk: { code: "LUK", prefix: "Lk", name: "Luke" },
  jhn: { code: "JHN", prefix: "Jn", name: "John" },
};

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/* Text parsing ------------------------------------------------------ */

interface ParsedText {
  /** chapter → (verse → text) in the order encountered. */
  chapters: Map<number, Map<number, string>>;
}

async function parseText(textFile: string, prefix: string): Promise<ParsedText> {
  const raw = await readFile(textFile, "utf8");
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  const pattern = new RegExp(`^${prefix} (\\d+):(\\d+)\\t(.*)$`);
  const chapters = new Map<number, Map<number, string>>();
  const seenRefs = new Set<string>();
  const lastVerse = new Map<number, number>();

  for (const [i, line] of lines.entries()) {
    const lineNo = i + 1;
    if (line.trim() === "") continue;
    const m = pattern.exec(line);
    if (!m) {
      error(`${textFile}:${lineNo}: not a verse line (expected "${prefix} <chapter>:<verse>\\t<text>"): ${JSON.stringify(line.slice(0, 80))}`);
      continue;
    }
    const chapter = Number(m[1]);
    const verse = Number(m[2]);
    let text = m[3].trim();
    if (text === "") {
      error(`${textFile}:${lineNo}: verse ${prefix} ${chapter}:${verse} has empty text`);
      continue;
    }
    const ref = `${chapter}:${verse}`;
    if (seenRefs.has(ref)) {
      error(`${textFile}:${lineNo}: duplicate verse reference ${ref}`);
      continue;
    }
    seenRefs.add(ref);
    text = text.normalize("NFC");

    const chapterMap = chapters.get(chapter) ?? new Map<number, string>();
    const prev = lastVerse.get(chapter);
    if (prev !== undefined && verse <= prev) {
      error(`${textFile}:${lineNo}: verses out of order in chapter ${chapter} (${verse} after ${prev})`);
    }
    lastVerse.set(chapter, verse);
    chapterMap.set(verse, text);
    chapters.set(chapter, chapterMap);
  }
  return { chapters };
}

/* Paragraph-rows parsing & cross-checks ----------------------------- */

interface ParsedRows {
  /** Paragraphs as { start, end }, derived from contiguous ascending runs. */
  paragraphs: Array<{ start: number; end: number }>;
  verses: Set<number>;
}

async function parseRows(rowsFile: string): Promise<ParsedRows> {
  const raw = await readFile(rowsFile, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    error(`${rowsFile}: cannot parse JSON: ${(err as Error).message}`);
    return { paragraphs: [], verses: new Set() };
  }
  if (!Array.isArray(data) || data.length === 0) {
    error(`${rowsFile}: expected a non-empty array of rows`);
    return { paragraphs: [], verses: new Set() };
  }
  const paragraphs: Array<{ start: number; end: number }> = [];
  const verses = new Set<number>();
  let prevRowEnd = 0;
  for (const [ri, row] of (data as unknown[]).entries()) {
    if (!Array.isArray(row) || row.length === 0) {
      error(`${rowsFile}: row ${ri + 1} is not a non-empty verse array`);
      return { paragraphs, verses };
    }
    const nums = row.map((v) => Number(v));
    if (nums.some((n) => !Number.isInteger(n) || n < 1)) {
      error(`${rowsFile}: row ${ri + 1} contains a non-integer verse number: ${JSON.stringify(row)}`);
      return { paragraphs, verses };
    }
    for (let k = 1; k < nums.length; k++) {
      if (nums[k] !== nums[k - 1] + 1) {
        error(`${rowsFile}: row ${ri + 1} is not a contiguous ascending run (${nums[k - 1]} then ${nums[k]})`);
        return { paragraphs, verses };
      }
    }
    if (nums[0] <= prevRowEnd) {
      error(`${rowsFile}: row ${ri + 1} starts at ${nums[0]}, which overlaps/precedes the previous row (ending at ${prevRowEnd})`);
    }
    prevRowEnd = nums[nums.length - 1];
    for (const n of nums) verses.add(n);
    paragraphs.push({ start: nums[0], end: nums[nums.length - 1] });
  }
  return { paragraphs, verses };
}

/* Main -------------------------------------------------------------- */

async function main(argv: string[]): Promise<number> {
  const slugArg = argv.find((a) => !a.startsWith("--"))?.toLowerCase();
  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");
  const gospel = slugArg ? GOSPELS[slugArg] : undefined;
  if (!gospel) {
    console.error("usage: npm run ingest-sblgnt -- <mat|mrk|luk|jhn> [--force] [--dry-run]");
    return 2;
  }
  if (dryRun) warn("dry run: nothing will be written");

  const textFile = path.join(PREP_DIR, slugArg!, `${slugArg}.txt`);
  const rowsDir = path.join(PREP_DIR, slugArg!, "para-rows");

  // 1. Text
  if (!(await exists(textFile))) {
    error(`missing ${textFile}`);
    return 1;
  }
  const { chapters: textChapters } = await parseText(textFile, gospel.prefix);
  if (textChapters.size === 0) {
    error(`${textFile}: no verses parsed — aborting`);
    return 1;
  }

  // 2. Chapter sanity against the book table
  const meta = getBookMeta(gospel.code);
  for (const chapter of textChapters.keys()) {
    if (meta && chapter > meta.chapters) {
      error(`${gospel.name} has ${meta.chapters} chapters but the text contains chapter ${chapter}`);
    }
  }
  for (let c = 1; meta && c <= meta.chapters; c++) {
    if (!textChapters.has(c)) {
      const next = [...textChapters.keys()].find((n) => n > c);
      warn(`chapter ${c} is missing from the text${next ? ` (next present: ${next})` : ""}`);
    }
  }

  // 3. Paragraph rows + cross-check with the text
  const rowsByChapter = new Map<number, ParsedRows>();
  for (const chapter of textChapters.keys()) {
    const rowsFile = path.join(rowsDir, `${chapter}-para-rows.json`);
    if (!(await exists(rowsFile))) {
      error(`missing paragraph rows for chapter ${chapter}: ${rowsFile}`);
      continue;
    }
    const rows = await parseRows(rowsFile);
    rowsByChapter.set(chapter, rows);

    const textVerses = new Set(textChapters.get(chapter)!.keys());
    const missing = [...textVerses].filter((n) => !rows.verses.has(n));
    const extra = [...rows.verses].filter((n) => !textVerses.has(n));
    if (missing.length > 0 || extra.length > 0) {
      const fmt = (arr: number[]) => arr.slice(0, 10).map(String).join(", ") + (arr.length > 10 ? `, … (${arr.length} total)` : "");
      if (missing.length > 0) error(`chapter ${chapter}: verse(s) in text but not in any paragraph row: ${fmt(missing)}`);
      if (extra.length > 0) error(`chapter ${chapter}: verse(s) in paragraph rows but not in text: ${fmt(extra)}`);
    }
  }
  // Rows files for chapters that the text does not contain at all.
  for (const name of ((await exists(rowsDir)) ? await readdir(rowsDir) : []).filter((n) => n.endsWith("-para-rows.json"))) {
    const c = Number(name.replace(/-para-rows\.json$/, ""));
    if (!textChapters.has(c)) {
      error(`${path.join(rowsDir, name)} covers chapter ${c}, which has no verses in the text`);
    }
  }

  // 4. Build, schema-check, and (unless dry-run) write each chapter file
  const outDir = path.join(OUT_ROOT, gospel.code);
  const targets: Array<{ chapter: number; file: string }> = [...textChapters.keys()]
    .sort((a, b) => a - b)
    .filter((c) => rowsByChapter.has(c))
    .map((c) => ({ chapter: c, file: path.join(outDir, `${c}.json`) }));

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
  if (!dryRun && errorCount > 0) {
    error(`aborting before write: ${errorCount} error(s) in the source must be fixed first`);
    return 1;
  }

  if (dryRun) {
    for (const c of textChapters.keys()) {
      const rows = rowsByChapter.get(c);
      const status = rows ? `✓ rows match text` : `✗ (see errors above)`;
      console.log(
        `chapter ${c}: ${textChapters.get(c)!.size} verse(s), ${rows?.paragraphs.length ?? 0} paragraph(s) — ${status}`
      );
    }
    console.log(
      `\n(dry run) ${textChapters.size} chapter(s), ${[...textChapters.values()].reduce((n, m) => n + m.size, 0)} verse(s)` +
        ` → ${outDir}/<chapter>.json (${errorCount} error(s), ${warnCount} warning(s))`
    );
  } else {
    await mkdir(outDir, { recursive: true });
    for (const t of targets) {
      const data = {
        book: gospel.code,
        chapter: t.chapter,
        source: "sblgnt",
        verses: Object.fromEntries(textChapters.get(t.chapter)!), // numeric keys => JSON keys sorted per our Map order? JSON sorts nothing; Map iteration is encounter order
        paragraphs: rowsByChapter.get(t.chapter)!.paragraphs,
      };
      const check = BaseChapter.safeParse(data);
      if (!check.success) {
        error(`${t.file}: generated file would NOT match the schema — aborting before write`);
        for (const issue of check.error.issues) {
          error(`  ${issue.path.map(String).join(".")}: ${issue.message}`);
        }
        return 1;
      }
      await writeFile(t.file, JSON.stringify(data, null, 2) + "\n", "utf8");
      console.log(`${GREEN}wrote${RESET} ${t.file} (${Object.keys(data.verses).length} verses, ${data.paragraphs.length} paragraphs)`);
    }
    console.log(
      `\n✓ ${gospel.name} ingested: ${targets.length} chapter(s) → data/base/greek/${gospel.code}/\n` +
        `  next: npm run validate`
    );
  }

  return errorCount > 0 ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
