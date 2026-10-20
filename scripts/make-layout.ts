/**
 * npm run make-layout <BOOK> [--force] — generate data/layout/<BOOK>.yaml.
 *
 * Row boundaries are the union of paragraph starts from both base texts (greek
 * + english); within each row each side takes the verses it has (narrowed to
 * the verses it actually contains); if a side has no verse in the range, that
 * side is null. A side without paragraph data contributes one boundary per
 * verse (i.e. the fallback: one row per verse). Rows are chapter-scoped, so
 * nothing here ever crosses a chapter boundary.
 *
 * Never overwrites an existing layout file unless --force is passed.
 */
import path from "node:path";
import { access, mkdir, writeFile } from "node:fs/promises";
import { stringify as stringifyYaml } from "yaml";

import { loadBaseChapter, loadMine, DATA_DIR } from "../src/lib/data.ts";
import { parseVerseRef, type LayoutRowData } from "../src/schemas.ts";
import { getBookMeta } from "../src/lib/books.ts";

const LANGS = ["greek", "english"] as const;
type Lang = (typeof LANGS)[number];

interface SideData {
  /** Verse numbers present on this side for the chapter (base ∪ mine additions). */
  verses: Set<number>;
  /** Paragraphs of the base text; empty when the source has none. */
  paragraphs: Array<{ start: number; end: number; heading?: string }>;
  /** Standalone section headings (e.g. BSB pericopes), independent of paragraphs. */
  headings: Array<{ verse: number; text: string }>;
}

async function sideData(book: string, lang: Lang, chapter: number): Promise<SideData | null> {
  const chapterBase = await loadBaseChapter(book, lang, chapter);
  if (chapterBase === null) return null;
  const verses = new Set(Object.keys(chapterBase.verses).map(Number));
  const mineOverrides = await loadMine(book, lang);
  if (mineOverrides !== null) {
    for (const ref of Object.keys(mineOverrides)) {
      const { chapter: c, verse } = parseVerseRef(ref)!;
      if (c === chapter) verses.add(verse);
    }
  }
  return { verses, paragraphs: chapterBase.paragraphs ?? [], headings: chapterBase.headings ?? [] };
}

/** "4" if single verse, "1-3" if a range of the verses the side actually has. */
function rangeFor(verses: Set<number> | undefined, start: number, end: number): string | null {
  if (!verses) return null;
  const have = [...verses].filter((n) => n >= start && n <= end).sort((a, b) => a - b);
  if (have.length === 0) return null;
  const a = have[0];
  const b = have[have.length - 1];
  return a === b ? String(a) : `${a}-${b}`;
}

async function main(argv: string[]): Promise<number> {
  const book = argv.find((a) => !a.startsWith("--"));
  const force = argv.includes("--force");
  if (!book) {
    console.error("usage: npm run make-layout -- <BOOK> [--force]   e.g. npm run make-layout -- MRK");
    return 2;
  }
  const meta = getBookMeta(book);
  if (!meta) {
    console.error(`Unknown USFM book code "${book}" (see src/lib/books.ts).`);
    return 1;
  }

  const outFile = path.join(DATA_DIR, "layout", `${book}.yaml`);
  try {
    await access(outFile);
    if (!force) {
      console.error(`${outFile} already exists — refusing to overwrite. Pass --force to overwrite.`);
      return 1;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // Collect per-side data; the chapters to lay out are those present on either side.
  const sides: Record<Lang, Map<number, SideData>> = { greek: new Map(), english: new Map() };
  const chaptersPresent = new Set<number>();
  for (const lang of LANGS) {
    for (let chapter = 1; chapter <= meta.chapters; chapter++) {
      const side = await sideData(book, lang, chapter);
      if (side !== null) {
        sides[lang].set(chapter, side);
        chaptersPresent.add(chapter);
      }
    }
  }
  if (chaptersPresent.size === 0) {
    console.error(`No base text found for ${book} under data/base/greek/${book}/ or data/base/english/${book}/.`);
    return 1;
  }

  const outChapters: Record<string, LayoutRowData[]> = {};
  for (const chapter of [...chaptersPresent].sort((a, b) => a - b)) {
    const greek = sides.greek.get(chapter);
    const english = sides.english.get(chapter);
    const maxVerse = Math.max(...[greek, english].flatMap((s) => (s ? [...s.verses] : [])));

    // Boundary contributions: this side's paragraph starts if it has any,
    // otherwise one boundary per verse (the "one row per verse" fallback).
    const bounds = new Set<number>();
    for (const side of [greek, english]) {
      if (!side) continue;
      if (side.paragraphs.length > 0) {
        for (const p of side.paragraphs) if (p.start >= 1 && p.start <= maxVerse) bounds.add(p.start);
      } else {
        for (let n = 1; n <= maxVerse; n++) bounds.add(n);
      }
    }
    const starts = [...bounds].sort((a, b) => a - b);
    if (starts.length === 0) continue;

    const rows: LayoutRowData[] = [];
    for (const [i, start] of starts.entries()) {
      const end = i + 1 < starts.length ? starts[i + 1] - 1 : maxVerse;
      const row: LayoutRowData = {
        greek: rangeFor(greek?.verses, start, end),
        english: rangeFor(english?.verses, start, end),
      };
      // Heading: a paragraph heading (either side) that starts exactly on this
      // boundary wins; then the base texts' standalone headings (e.g. BSB
      // pericopes), English first. Attach only at row starts — a heading verse
      // that is not any row start stays unattached and the validator warns.
      {
        const p = [greek, english]
          .map((side) => side?.paragraphs.find((pp) => pp.start === start && pp.heading !== undefined))
          .find((pp) => pp !== undefined);
        if (p !== undefined) {
          row.heading = p.heading;
        } else {
          const h = [
            english?.headings.find((hh) => hh.verse === start),
            greek?.headings.find((hh) => hh.verse === start),
          ].find((hh) => hh !== undefined);
          if (h !== undefined) row.heading = h.text;
        }
      }
      rows.push(row);
    }
    outChapters[String(chapter)] = rows;

    // Report base headings that could not be attached to any row start.
    const attached = new Set(rows.map((r) => r.heading));
    for (const side of [greek, english]) {
      for (const h of side?.headings ?? []) {
        if (!attached.has(h.text)) {
          console.warn(
            `${book} ${chapter}: base heading "${h.text}" (verse ${h.verse}) does not sit on a row start; it is not copied into the layout. Split the row at verse ${h.verse} or hand-set the heading.`
          );
        }
      }
    }
  }

  const header =
    `# Layout for ${meta.name} (${book}).\n` +
    `# Generated by scripts/make-layout.ts; safe to regenerate (it refuses to\n` +
    `# overwrite without --force). Null rows create single-language rows.\n`;
  const yaml = header + stringifyYaml({ chapters: outChapters }, { indent: 2 }).trimEnd() + "\n";

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, yaml, "utf8");

  const rowCount = Object.values(outChapters).reduce((n, rs) => n + rs.length, 0);
  console.log(`Wrote ${outFile}: ${Object.keys(outChapters).length} chapter(s), ${rowCount} row(s)`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
