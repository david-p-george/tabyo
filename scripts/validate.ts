/**
 * npm run validate — checks every data file against the central Zod schemas
 * (src/schemas.ts) plus the cross-file data contract:
 *
 *  ERROR: an override refers to nothing (no base chapter for that ref);
 *         duplicate note ids in a book; layout ranges that overlap, are out of
 *         order, or reference verses absent from base/mine; an anchor phrase
 *         that is not found in the final merged verse text, or is ambiguous
 *         (found more than once) without an `occurrence` disambiguator.
 *  WARN:  an override that is an addition (verse absent from base); an override
 *         identical to its base text; a base verse not covered by the layout; a
 *         base source slug missing from attribution.yaml; a base heading not
 *         carried by any layout row's heading; a verse that differs from base
 *         but has no note anchored in it.
 *
 * Prints file+ref-specific messages and a summary; exits non-zero on ERRORs.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { ZodError, ZodType } from "zod";

import {
  Attribution,
  BaseChapter,
  LayoutBook,
  MineOverrides,
  NotesBook,
  parseVerseRef,
  parseVerseRange,
} from "../src/schemas.ts";
import { getBookMeta } from "../src/lib/books.ts";
import { countOccurrences } from "../src/lib/text.ts";

/* ------------------------------------------------------------------ */
/* Plumbing                                                            */
/* ------------------------------------------------------------------ */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

type Severity = "ERROR" | "WARN";

interface Problem {
  severity: Severity;
  file: string; // relative to repo root, forward slashes
  ref?: string; // "1:4" or chapter/anchor detail
  message: string;
}

const problems: Problem[] = [];

function problem(severity: Severity, file: string, message: string, ref?: string): void {
  problems.push({ severity, file, message, ref });
}

function rel(file: string): string {
  return path.relative(ROOT, file).replaceAll("\\", "/");
}

async function readYaml(file: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return parseYaml(raw);
  } catch (err) {
    problem("ERROR", rel(file), `cannot parse YAML: ${(err as Error).message.split("\n")[0]}`);
    return null;
  }
}

async function readJson(file: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    problem("ERROR", rel(file), `cannot parse JSON: ${(err as Error).message}`);
    return null;
  }
}

/** Read a data file, validate it against a schema; problems land in the list. */
async function loadValidated(schema: ZodType<unknown>, file: string): Promise<unknown | null> {
  const data = await (file.endsWith(".json") ? readJson(file) : readYaml(file));
  if (data === null) return null; // missing or unparseable — readYaml/readJson already reported
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    reportZod(parsed.error, rel(file));
    return null;
  }
  return parsed.data;
}

/** One problem per Zod issue, with the issue path attached. */
function reportZod(err: ZodError, file: string): void {
  for (const issue of err.issues) {
    const where = issue.path.length > 0 ? issue.path.map(String).join(".") : "";
    problem("ERROR", file, where ? `${where}: ${issue.message}` : issue.message);
  }
}

/* ------------------------------------------------------------------ */
/* In-memory views used for cross-checks                               */
/* ------------------------------------------------------------------ */

function checkCode(file: string, code: string): void {
  if (!getBookMeta(code)) {
    problem("ERROR", file, `unknown USFM book code "${code}" (see src/lib/books.ts)`);
  }
}

const LANGS = ["greek", "english"] as const;
type Lang = (typeof LANGS)[number];
const other = (lang: Lang): Lang => (lang === "greek" ? "english" : "greek");

/* ------------------------------------------------------------------ */
/* In-memory views used for cross-checks                               */
/* ------------------------------------------------------------------ */

interface BaseChapterView {
  verses: Record<string, string>;
  paragraphs?: Array<{ start: number; end: number; heading?: string }>;
  headings?: Array<{ verse: number; text: string }>;
}

const base: Record<Lang, Map<string, Map<number, BaseChapterView>>> = {
  greek: new Map(),
  english: new Map(),
};
const mine: Record<Lang, Map<string, Record<string, string>>> = {
  greek: new Map(),
  english: new Map(),
};
const notes = new Map<string, { greek?: NoteShape[]; english?: NoteShape[] }>();
const layout = new Map<string, { chapters: Record<string, LayoutRowShape[]> }>();

interface NoteShape {
  id: string;
  ref: string;
  anchor: { phrase: string; occurrence?: number };
  apparatus?: Array<{ reading: string; adopted?: boolean }>;
}
interface LayoutRowShape {
  greek: string | null;
  english: string | null;
  heading?: string;
}

/** Final merged verse text (base, with mine override/addition applied). */
function finalText(lang: Lang, code: string, ref: string): string | undefined {
  const { chapter, verse } = parseVerseRef(ref)!;
  const mineEntry = mine[lang].get(code)?.[ref];
  if (mineEntry !== undefined) return mineEntry;
  return base[lang].get(code)?.get(chapter)?.verses[verse];
}

/* ------------------------------------------------------------------ */
/* Attribution                                                         */
/* ------------------------------------------------------------------ */

let attributionSources: Record<string, unknown> | null = null;

async function validateAttribution(): Promise<void> {
  const data = await loadValidated(Attribution, path.join(DATA, "attribution.yaml"));
  if (data !== null) attributionSources = (data as { sources: Record<string, unknown> }).sources;
}

/* ------------------------------------------------------------------ */
/* Base text                                                           */
/* ------------------------------------------------------------------ */

async function listBaseDirs(lang: Lang): Promise<string[]> {
  try {
    const entries = await readdir(path.join(DATA, "base", lang), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function validateBase(): Promise<void> {
  for (const lang of LANGS) {
    for (const code of await listBaseDirs(lang)) {
      const dir = path.join(DATA, "base", lang, code);
      checkCode(`${rel(dir)} (directory)`, code);
      const chapters = new Map<number, BaseChapterView>();
      base[lang].set(code, chapters);
      for (const name of (await readdir(dir)).filter((n) => n.endsWith(".json"))) {
        const file = path.join(dir, name);
        const chapterNo = Number(name.replace(/\.json$/, ""));
        const data = await loadValidated(BaseChapter, file);
        if (data === null) continue;
        const chapter = data as { book: string; chapter: number; source: string; verses: Record<string, string>; paragraphs?: Array<{ start: number; end: number; heading?: string }>; headings?: Array<{ verse: number; text: string }> };
        if (chapter.book !== code) {
          problem("ERROR", rel(file), `internal "book" is "${chapter.book}" but file lives under base/${lang}/${code}/`);
        }
        if (chapter.chapter !== chapterNo) {
          problem("ERROR", rel(file), `internal "chapter" is ${chapter.chapter} but filename is ${name}`);
        }
        chapters.set(chapterNo, { verses: chapter.verses, paragraphs: chapter.paragraphs, headings: chapter.headings });
        if (attributionSources !== null && !(chapter.source in attributionSources)) {
          problem("WARN", rel(file), `source "${chapter.source}" has no entry in data/attribution.yaml`);
        }
      }
    }
  }
  // A chapter that exists on one side but not the other is probably a prep gap.
  for (const lang of LANGS) {
    for (const [code, chapters] of base[lang]) {
      const otherChapters = base[other(lang)].get(code);
      const others = new Set(otherChapters?.keys() ?? []);
      for (const n of chapters.keys()) {
        if (!others.has(n)) {
          problem("WARN", `data/base/${other(lang)}/${code}/`, `chapter ${n} exists in ${lang} base but has no ${other(lang)} base text`, `${n}`);
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Overrides (mine)                                                    */
/* ------------------------------------------------------------------ */

async function validateMine(): Promise<void> {
  for (const lang of LANGS) {
    const dir = path.join(DATA, "mine", lang);
    const names = await readdirSafe(dir);
    for (const name of names.filter((n) => n.endsWith(".yaml") && !n.startsWith("."))) {
      const code = name.replace(/\.yaml$/, "");
      const file = path.join(dir, name);
      checkCode(rel(file), code);
      const meta = getBookMeta(code);
      const data = await loadValidated(MineOverrides, file);
      if (data === null) continue;
      const entries = data as Record<string, string>;
      mine[lang].set(code, entries);

      for (const [ref, text] of Object.entries(entries)) {
        const { chapter, verse } = parseVerseRef(ref)!;
        if (meta && chapter > meta.chapters) {
          problem("ERROR", rel(file), `${ref}: chapter is beyond ${code}'s ${meta.chapters} chapters`, ref);
        }
        const baseChapter = base[lang].get(code)?.get(chapter);
        if (!baseChapter) {
          problem("ERROR", rel(file), `${ref}: override refers to nothing — there is no ${lang} base chapter ${chapter}, and an override cannot create one`, ref);
          continue;
        }
        const baseText = baseChapter.verses[String(verse)];
        if (baseText === undefined) {
          problem("WARN", rel(file), `${ref} is not in the base — treated as an addition to the ${lang} text; if this was meant to replace a base verse, check the ref`, ref);
          continue;
        }
        if (baseText === text) {
          problem("WARN", rel(file), `${ref} is identical to the base text — drop the override or change the text`, ref);
        }
      }
    }
  }
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Notes                                                               */
/* ------------------------------------------------------------------ */

async function validateNotes(): Promise<void> {
  const dir = path.join(DATA, "notes");
  for (const name of (await readdirSafe(dir)).filter((n) => n.endsWith(".yaml") && !n.startsWith("."))) {
    const code = name.replace(/\.yaml$/, "");
    const file = path.join(dir, name);
    checkCode(rel(file), code);
    const meta = getBookMeta(code);
    const data = await loadValidated(NotesBook, file);
    if (data === null) continue;
    const byLang = data as { greek?: NoteShape[]; english?: NoteShape[] };
    notes.set(code, byLang);

    const ids = new Map<string, string>();
    for (const lang of ["greek", "english"] as const) {
      for (const note of byLang[lang] ?? []) {
        const firstUse = ids.get(note.id);
        if (firstUse !== undefined) {
          problem("ERROR", rel(file), `duplicate note id "${note.id}" (already used in ${firstUse})`, note.ref);
        } else {
          ids.set(note.id, `${lang}/${note.id}`);
        }

        const { chapter } = parseVerseRef(note.ref)!;
        if (meta && chapter > meta.chapters) {
          problem("ERROR", rel(file), `${note.id}: ${note.ref} is beyond ${code}'s ${meta.chapters} chapters`, note.ref);
        }
        const text = finalText(lang, code, note.ref);
        if (text === undefined) {
          problem("ERROR", rel(file), `${note.id}: ${note.ref} is not a verse in the ${lang} base or mine text`, note.ref);
          continue;
        }
        const count = countOccurrences(text, note.anchor.phrase);
        if (count === 0) {
          problem("ERROR", rel(file), `${note.id}: anchor phrase not found in final ${lang} text of ${code} ${note.ref}`, note.ref);
        } else if (count > 1 && note.anchor.occurrence === undefined) {
          problem("ERROR", rel(file), `${note.id}: anchor phrase occurs ${count}x in ${code} ${note.ref} — add anchor.occurrence`, note.ref);
        } else if (note.anchor.occurrence !== undefined && note.anchor.occurrence > count) {
          problem("ERROR", rel(file), `${note.id}: anchor.occurrence ${note.anchor.occurrence} exceeds ${count} occurrence(s) in ${code} ${note.ref}`, note.ref);
        }
        // At most one apparatus reading should be adopted in my text.
        if (lang === "greek") {
          const adopted = (note.apparatus ?? []).filter((r) => r.adopted === true);
          if (adopted.length > 1) {
            problem("WARN", rel(file), `${note.id}: ${adopted.length} apparatus readings are marked adopted`, note.ref);
          }
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

async function validateLayout(): Promise<void> {
  const dir = path.join(DATA, "layout");
  for (const name of (await readdirSafe(dir)).filter((n) => n.endsWith(".yaml") && !n.startsWith("."))) {
    const code = name.replace(/\.yaml$/, "");
    const file = path.join(dir, name);
    checkCode(rel(file), code);
    const meta = getBookMeta(code);
    const data = await loadValidated(LayoutBook, file);
    if (data === null) continue;
    const byChapter = data as { chapters: Record<string, LayoutRowShape[]> };
    layout.set(code, byChapter);

    for (const [chapterKey, rows] of Object.entries(byChapter.chapters)) {
      const chapter = Number(chapterKey);
      if (meta && chapter > meta.chapters) {
        problem("ERROR", rel(file), `chapter ${chapterKey} is beyond ${code}'s ${meta.chapters} chapters`, chapterKey);
      }

      // Verse universe for this chapter per side: base ∪ mine additions.
      const union: Record<Lang, Set<string>> = { greek: new Set(), english: new Set() };
      for (const lang of LANGS) {
        for (const v of Object.keys(base[lang].get(code)?.get(chapter)?.verses ?? {})) union[lang].add(v);
        for (const ref of Object.keys(mine[lang].get(code) ?? {})) {
          const { chapter: c, verse } = parseVerseRef(ref)!;
          if (c === chapter) union[lang].add(String(verse));
        }
      }

      const covered: Record<Lang, Set<string>> = { greek: new Set(), english: new Set() };
      const prevEnd: Record<Lang, number> = { greek: 0, english: 0 };

      for (const [i, row] of rows.entries()) {
        if (row.greek === null && row.english === null) continue; // schema already rejects
        for (const lang of LANGS) {
          const range = row[lang];
          if (range === null) continue;
          const rowLoc = `chapter ${chapterKey} row ${i + 1} (${lang})`;
          const parsed = parseVerseRange(range);
          if (!parsed) {
            problem("ERROR", rel(file), `${rowLoc}: malformed range "${range}"`, range);
          }
          if (parsed && parsed.start <= prevEnd[lang]) {
            problem("ERROR", rel(file), `${rowLoc}: range "${range}" overlaps or precedes the previous row (which ends at verse ${prevEnd[lang]})`, range);
          }
          if (parsed) {
            prevEnd[lang] = Math.max(prevEnd[lang], parsed.end);
            const missing: string[] = [];
            for (let n = parsed.start; n <= parsed.end; n++) {
              if (finalText(lang, code, `${chapterKey}:${n}`) === undefined) missing.push(String(n));
              covered[lang].add(String(n));
            }
            if (missing.length > 0) {
              const shown = missing.slice(0, 5).join(", ") + (missing.length > 5 ? `, … (${missing.length} verses)` : "");
              problem("ERROR", rel(file), `${rowLoc}: range "${range}" references verse(s) absent from the ${lang} base/mine text: ${shown}`, range);
            }
          }
        }
      }

      // Coverage lint (WARN): every verse in the merged text must sit in some row.
      for (const lang of LANGS) {
        const uncovered = [...union[lang]]
          .map(Number)
          .sort((a, b) => a - b)
          .filter((n) => !covered[lang].has(String(n)));
        if (uncovered.length > 0) {
          const shown = uncovered.slice(0, 10).map(String).join(", ") + (uncovered.length > 10 ? `, … (${uncovered.length} verses)` : "");
          problem("WARN", rel(file), `chapter ${chapterKey} ${lang} verse(s) not covered by any row: ${shown}`, chapterKey);
        }
      }

      // Coverage lint (WARN): a base heading must be carried by some layout row
      // (the generator copies base headings onto rows; hand edits must keep them).
      for (const lang of LANGS) {
        for (const h of base[lang].get(code)?.get(chapter)?.headings ?? []) {
          if (!rows.some((r) => r.heading === h.text)) {
            problem("WARN", rel(file), `chapter ${chapterKey}: base ${lang} heading "${h.text}" (verse ${h.verse}) is not carried by any layout row's heading`, chapterKey);
          }
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Unexpected files + quiet-change lint                                */
/* ------------------------------------------------------------------ */

async function warnUnexpectedFiles(): Promise<void> {
  for (const dir of [path.join(DATA, "notes"), path.join(DATA, "layout")]) {
    for (const n of await readdirSafe(dir)) {
      if (n.startsWith(".")) continue;
      if (!n.endsWith(".yaml")) {
        problem("WARN", rel(path.join(dir, n)), "unexpected file; expected <USFMCODE>.yaml");
      }
    }
  }
  for (const lang of LANGS) {
    const dir = path.join(DATA, "mine", lang);
    for (const n of await readdirSafe(dir)) {
      if (n.startsWith(".")) continue;
      if (!n.endsWith(".yaml")) {
        problem("WARN", rel(path.join(dir, n)), "unexpected file; expected <USFMCODE>.yaml");
      }
    }
  }
}

/** Lint: a verse differs from base but no note is anchored in that verse. */
async function lintSilentChanges(): Promise<void> {
  for (const lang of LANGS) {
    for (const [code, entries] of mine[lang]) {
      for (const [ref, text] of Object.entries(entries)) {
        const { chapter, verse } = parseVerseRef(ref)!;
        const baseText = base[lang].get(code)?.get(chapter)?.verses[verse];
        if (baseText === undefined || baseText === text) continue;
        const bookNotes = notes.get(code);
        const anchored = (["greek", "english"] as const).some((l) => (bookNotes?.[l] ?? []).some((n) => n.ref === ref));
        if (!anchored) {
          problem("WARN", `data/notes/${code}.yaml`, `${code} ${ref} differs from the ${lang} base but no note is anchored in it`, ref);
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  await validateAttribution();
  await validateBase();
  await validateMine();
  await validateNotes();
  await validateLayout();
  await warnUnexpectedFiles();
  await lintSilentChanges();

  problems.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.severity !== b.severity) return a.severity === "ERROR" ? -1 : 1;
    const ra = a.ref ?? "";
    const rb = b.ref ?? "";
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });

  for (const p of problems) {
    const color = p.severity === "ERROR" ? RED : YELLOW;
    const ref = p.ref ? ` ${DIM}[${p.ref}]${RESET}` : "";
    console.log(`${color}${p.severity.padEnd(5)}${RESET} ${p.file}${ref}`);
    console.log(`        ${p.message}`);
  }

  const errors = problems.filter((p) => p.severity === "ERROR").length;
  const warns = problems.length - errors;
  console.log(`${problems.length} problem(s): ${errors} error(s), ${warns} warning(s)`);
  console.log(errors === 0 ? "✓ data is valid" : "✗ fix the errors above");
  return errors > 0 ? 1 : 0;
}

process.exitCode = await main();
