/**
 * Loader for everything under `data/`.
 *
 * Every file is validated against the central Zod schemas on read (see
 * `src/schemas.ts`), parsed results are cached, and accessors return merged,
 * typed view data — e.g. final verse text with per-verse "overridden"/addition
 * flags. This module owns file IO and nothing else; rendering rows or matching
 * note anchors is NOT implemented here yet.
 *
 * Runs under Node (scripts + Astro static build), so plain `node:fs` IO is fine.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  Attribution,
  BaseChapter,
  LayoutBook,
  MineOverrides,
  NotesBook,
} from "../schemas.ts";
import type {
  LayoutRowData,
  MineOverridesData,
  NotesBookData,
  BaseChapterData,
  AttributionData,
  LayoutBookData,
} from "../schemas.ts";
import { getBookMeta, type BookMeta, BOOKS } from "./books.ts";

/** This file is src/lib/data.ts → repo root is two levels up. */
export const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");

/** Tells the user exactly which file failed and why. */
function fail(file: string, err: unknown): never {
  const detail = err instanceof Error ? err.message : String(err);
  throw new Error(`Invalid data file ${file}: ${detail}`);
}

const jsonCache = new Map<string, Promise<unknown>>();
const yamlCache = new Map<string, Promise<unknown>>();

async function readJsonCached<T>(file: string): Promise<T | null> {
  let p = jsonCache.get(file);
  if (p === undefined) {
    p = readFile(file, "utf8")
      .then((raw) => JSON.parse(raw) as T)
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw fail(file, err);
        });
    jsonCache.set(file, p);
  }
  return (await p) as T | null;
}

async function readYamlCached<T>(file: string): Promise<T | null> {
  let p = yamlCache.get(file);
  if (p === undefined) {
    p = readFile(file, "utf8")
      .then((raw) => parseYaml(raw) as T)
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw fail(file, err);
      });
    yamlCache.set(file, p);
  }
  return (await p) as T | null;
}

type Lang = "greek" | "english";
const baseFile = (book: string, lang: Lang, chapter: number) =>
  path.join(DATA_DIR, "base", lang, book, `${chapter}.json`);
const mineFile = (book: string, lang: Lang) => path.join(DATA_DIR, "mine", lang, `${book}.yaml`);
const notesFile = (book: string) => path.join(DATA_DIR, "notes", `${book}.yaml`);
const layoutFile = (book: string) => path.join(DATA_DIR, "layout", `${book}.yaml`);
const attributionFile = () => path.join(DATA_DIR, "attribution.yaml");

/* ------------------------------------------------------------------ */
/* Schemas on top of the raw reader                                    */
/* ------------------------------------------------------------------ */

export async function loadBaseChapter(book: string, lang: Lang, chapter: number): Promise<BaseChapterData | null> {
  const file = baseFile(book, lang, chapter);
  const raw = await readJsonCached<unknown>(file);
  if (raw === null) return null;
  return BaseChapter.safeParse(raw).success ? (raw as BaseChapterData) : fail(file, BaseChapter.safeParse(raw).error);
}

export async function loadMine(book: string, lang: Lang): Promise<MineOverridesData | null> {
  const file = mineFile(book, lang);
  const raw = await readYamlCached<unknown>(file);
  if (raw === null) return null;
  const parsed = MineOverrides.safeParse(raw);
  if (!parsed.success) return fail(file, parsed.error);
  return parsed.data;
}

export async function loadNotes(book: string): Promise<NotesBookData | null> {
  const file = notesFile(book);
  const raw = await readYamlCached<unknown>(file);
  if (raw === null) return null;
  const parsed = NotesBook.safeParse(raw);
  if (!parsed.success) return fail(file, parsed.error);
  return parsed.data;
}

export async function loadLayout(book: string): Promise<LayoutBookData | null> {
  const file = layoutFile(book);
  const raw = await readYamlCached<unknown>(file);
  if (raw === null) return null;
  const parsed = LayoutBook.safeParse(raw);
  if (!parsed.success) return fail(file, parsed.error);
  return parsed.data;
}

export async function loadAttribution(): Promise<AttributionData | null> {
  const raw = await readYamlCached<unknown>(attributionFile());
  if (raw === null) return null;
  const parsed = Attribution.safeParse(raw);
  if (!parsed.success) return fail(attributionFile(), parsed.error);
  return parsed.data;
}

/* ------------------------------------------------------------------ */
/* Typed view accessors                                                */
/* ------------------------------------------------------------------ */

export interface VerseUnit {
  /** Verse number within the chapter, e.g. 4. Parsed at the loader boundary. */
  verse: number;
  /** Final merged verse text (mine overrides base). */
  text: string;
  /** True if this verse's text was replaced through data/mine/. */
  overridden: boolean;
  /** True if this verse exists only in data/mine/, not in the base text. */
  addition: boolean;
}

export interface MergedSide {
  /** Attribution slug of the base source, or null if the side has no base data. */
  source: string | null;
  /** Verses in ascending numeric order, base + mine merged. */
  verses: VerseUnit[];
  /** Standalone section headings from the base (BSB), if any. */
  headings?: Array<{ verse: number; text: string }>;
}

export interface MergedChapter {
  book: string;
  chapter: number;
  greek: MergedSide;
  english: MergedSide;
  /** Layout rows for this chapter, or [] when no layout exists yet. */
  rows: LayoutRowData[];
}

/** Book metadata plus the chapters that actually have data on disk. */
export interface BookOverview {
  meta: BookMeta;
  /** Chapters with base data (greek ∪ english), ascending. */
  chapters: number[];
}

/** Merge one chapter's base verses with the mine-override entries for that chapter. */
function mergeSide(base: BaseChapterData | null, mineForChapter: MineOverridesData | null): MergedSide {
  const units: VerseUnit[] = [];
  if (base) {
    for (const [verse, text] of Object.entries(base.verses)) {
      units.push({ verse: Number(verse), text, overridden: false, addition: false });
    }
  }
  if (mineForChapter) {
    for (const [ref, text] of Object.entries(mineForChapter)) {
      const verse = Number(ref.slice(ref.indexOf(":") + 1));
      const existing = units.find((v) => v.verse === verse);
      if (existing) {
        existing.text = text;
        existing.overridden = true;
      } else {
        units.push({ verse, text, overridden: false, addition: true });
      }
    }
  }
  units.sort((a, b) => a.verse - b.verse);
  if (base?.headings !== undefined) {
    return { source: base.source ?? null, verses: units, headings: base.headings };
  }
  return { source: base?.source ?? null, verses: units };
}

/** Load my overrides for one book+language, scoped to a chapter, or null if none. */
export async function getMine(book: string, lang: Lang, chapter: number): Promise<MineOverridesData | null> {
  const mine = await loadMine(book, lang);
  if (!mine) return null;
  const out: MineOverridesData = {};
  for (const [ref, text] of Object.entries(mine)) {
    if (Number(ref.slice(0, ref.indexOf(":"))) === chapter) out[ref] = text;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Merged chapter view: base text with my overrides applied per verse, plus
 * layout rows if a layout file exists for the book.
 * Throws only if neither language has a base chapter file for the chapter.
 */
export async function getChapter(book: string, chapter: number): Promise<MergedChapter> {
  const [greekBase, englishBase, mineGreek, mineEnglish] = await Promise.all([
    loadBaseChapter(book, "greek", chapter),
    loadBaseChapter(book, "english", chapter),
    getMine(book, "greek", chapter),
    getMine(book, "english", chapter),
  ]);
  if (greekBase === null && englishBase === null) {
    throw new Error(
      `No base text found for ${book} chapter ${chapter} (expected data/base/greek/${book}/${chapter}.json or data/base/english/${book}/${chapter}.json)`
    );
  }
  const rows = (await loadLayout(book))?.chapters[String(chapter)] ?? [];
  return {
    book,
    chapter,
    greek: mergeSide(greekBase, mineGreek),
    english: mergeSide(englishBase, mineEnglish),
    rows,
  };
}

/** Book metadata plus the chapters that exist on disk. */
export async function getBook(code: string): Promise<BookOverview> {
  const meta = getBookMeta(code);
  if (!meta) throw new Error(`Unknown USFM book code "${code}". See src/lib/books.ts for the table.`);
  const chapters = new Set<number>();
  for (const lang of ["greek", "english"] as const) {
    let names: string[];
    try {
      names = await readdir(path.join(DATA_DIR, "base", lang, code));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const n of names) {
      const m = /^(\d+)\.json$/.exec(n);
      if (m) chapters.add(Number(m[1]));
    }
  }
  return { meta, chapters: [...chapters].sort((a, b) => a - b) };
}

/** Every book that has at least one chapter of base data on disk. */
export interface BookDataOverview extends BookOverview {
  chapters: number[];
}

export async function listBooksWithData(): Promise<BookDataOverview[]> {
  const out: BookDataOverview[] = [];
  for (const meta of BOOKS) {
    const overview = await getBook(meta.code);
    if (overview.chapters.length > 0) out.push(overview as BookDataOverview);
  }
  return out;
}

/** Attribution data as written in data/attribution.yaml, or null while it is not yet filled in. */
export async function getAttribution(): Promise<AttributionData | null> {
  return (await loadAttribution()) ?? { sources: {} };
}

/** Notes for a book with arrays normalised to []. */
export async function getNotes(book: string): Promise<NotesBookData> {
  return (await loadNotes(book)) ?? { greek: [], english: [] };
}

/** Types re-exported for consumers of this loader. */
export type { BaseChapterData, MineOverridesData, NotesBookData, LayoutBookData, AttributionData };
