/**
 * Render-time helpers the pages use, sitting on top of the loader:
 *
 * - building the row structure for a chapter (from data/layout/<BOOK>.yaml,
 *   or an in-memory one-row-per-verse fallback when a book has no layout file);
 * - turning final verse text + note anchors into safe HTML with <mark> tags.
 *
 * Row extraction reuses the same range semantics as the validator
 * (src/lib/text.ts for anchors, schemas.ts parse helpers for ranges) — the
 * matching rules themselves are never duplicated here.
 */
import type { MergedChapter, MergedSide, VerseUnit } from "./data.ts";
import type { LayoutRowData, GreekNoteData, EnglishNoteData } from "../schemas.ts";
import { parseVerseRange } from "../schemas.ts";
import { locateNfc } from "./text.ts";

/* ------------------------------------------------------------------ */
/* Rows                                                               */
/* ------------------------------------------------------------------ */

/** One side of a row: the verse range plus its merged verse units. */
export interface RowSide {
  start: number;
  end: number;
  verses: VerseUnit[];
}

export interface RowView {
  /** Verse number of the first verse on either side (row id "v<this>"). */
  firstVerse: number;
  /** Heading spans both columns if the layout row carries one. */
  heading?: string;
  greek: RowSide | null;
  english: RowSide | null;
}

/** Greek or English note (they are shaped alike at the anchor level). */
export type AnyNote = GreekNoteData | EnglishNoteData;

function unitsInRange(side: MergedSide, book: string, lang: string, chapter: number, start: number, end: number): VerseUnit[] {
  const units: VerseUnit[] = [];
  for (let n = start; n <= end; n++) {
    const unit = side.verses.find((v) => v.verse === n);
    if (!unit) {
      throw new Error(
        `layout row ${book} ${chapter} references ${lang} verse ${start}-${end} but verse ${n} is missing from the merged text — run npm run validate`
      );
    }
    units.push(unit);
  }
  return units;
}

/**
 * Chapter rows for rendering. With a layout file, each row pulls the merged
 * verse units for its ranges (errors loudly if a range references a missing
 * verse); the row heading is whatever the layout says — base headings are
 * copied into layout rows by the generator, so no inference happens here.
 * Without a layout file, warn once and fall back to one row per verse over
 * the union of both sides' verses.
 */
export function buildRows(merged: MergedChapter, layoutRows: LayoutRowData[] | null): RowView[] {
  const { book, chapter } = merged;

  if (layoutRows === null) {
    console.warn(
      `[tabyo] ${book} ${chapter}: no layout rows found — generating rows in memory (one row per verse); prepare data/layout/${book}.yaml to silence this`
    );
    const verses = new Set<number>();
    for (const u of merged.greek.verses) verses.add(u.verse);
    for (const u of merged.english.verses) verses.add(u.verse);
    const sorted = [...verses].sort((a, b) => a - b);
    return sorted.map((v) => {
      const greek = merged.greek.verses.find((u) => u.verse === v) ?? null;
      const english = merged.english.verses.find((u) => u.verse === v) ?? null;
      return {
        firstVerse: v,
        // Schema forbids both sides null on a real row; a verse can only be
        // here because one side has it.
        greek: greek ? { start: v, end: v, verses: [greek] } : null,
        english: english ? { start: v, end: v, verses: [english] } : null,
      };
    });
  }

  return layoutRows.map((row: LayoutRowData) => {
    const sides: { greek: RowSide | null; english: RowSide | null } = { greek: null, english: null };
    for (const lang of ["greek", "english"] as const) {
      const range = row[lang];
      if (range === null) continue;
      const parsed = parseVerseRange(range);
      if (!parsed) throw new Error(`malformed row range "${range}" in ${book} chapter ${chapter}`);
      sides[lang] = {
        start: parsed.start,
        end: parsed.end,
        verses: unitsInRange(merged[lang], book, lang, chapter, parsed.start, parsed.end),
      };
    }
    const firstVerse = Math.min(
      ...([sides.greek?.start, sides.english?.start].filter((n): n is number => n !== undefined))
    );
    return {
      firstVerse,
      heading: row.heading,
      greek: sides.greek,
      english: sides.english,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Anchor marking                                                      */
/* ------------------------------------------------------------------ */

/** A located note anchor inside one verse, ready for wrapping. */
export interface AnchorMark {
  noteId: string;
  /** Inclusive start, exclusive end, in NFC text coordinates. */
  start: number;
  end: number;
  /**
   * Optional chapter-wide note order label (1, 2, …) shared with the
   * end-of-chapter note list; rendered as an invisible superscript that only
   * the print stylesheet reveals (print footnote references).
   */
  label?: string;
}

export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replaceAll('"', "&quot;");
}

/**
 * All note anchors for one FRAGMENT of verse text (Greek or English).
 * Throws with the note id attached when an anchor can't be located — the
 * build fails, exactly as the validator would.
 */
export function locateNoteAnchors(
  book: string,
  chapter: number,
  lang: "greek" | "english",
  text: string,
  notes: AnyNote[]
): AnchorMark[] {
  const marks: AnchorMark[] = [];
  for (const note of notes) {
    const occurrence = note.anchor.occurrence ?? 1;
    let span: { start: number; end: number } | null = null;
    try {
      span = locateNfc(text, note.anchor.phrase, occurrence);
    } catch (err) {
      throw new Error(`${book} ${chapter}:${note.ref.slice(note.ref.indexOf(":") + 1)} note ${note.id}: ${(err as Error).message}`);
    }
    if (span === null) {
      throw new Error(
        `${book} ${note.ref} note ${note.id}: anchor phrase not found in final ${lang} verse text — run npm run validate`
      );
    }
    marks.push({ noteId: note.id, start: span.start, end: span.end });
  }
  return marks;
}

/**
 * Verse text → HTML string. Contained spans nest (<mark> inside <mark>,
 * deepest first); overlapping-but-crossing spans are emitted as sequential
 * split marks (the earlier note's mark is closed and reopened around the
 * other), which is valid HTML. Text between marks is escaped; only anchored
 * spans are ever marked.
 */
export function markVerseHtml(nfcText: string, marks: AnchorMark[], kind: "greek" | "english"): string {
  const list = [...marks].sort((a, b) => a.start - b.start || b.end - a.end);
  if (list.length === 0) return escapeHtml(nfcText);

  const cuts = new Set<number>([0, nfcText.length]);
  for (const m of list) {
    cuts.add(m.start);
    cuts.add(m.end);
  }
  const boundaries = [...cuts].sort((a, b) => a - b);

  let out = "";
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const covering = list.filter((m) => m.start <= start && m.end >= end);
    const segment = nfcText.slice(start, end);
    if (covering.length === 0) {
      out += escapeHtml(segment);
    } else {
      out += covering.map((m) => `<mark data-kind="${kind}" data-note="${escapeAttr(m.noteId)}" tabindex="0">`).join("");
      out += escapeHtml(segment);
      // Print footnote references live at the innermost closing edge; the
      // screen stylesheet keeps them invisible (aria-hidden in any case).
      out += covering.map((m) => (m.label ? `<span class="print-ref" aria-hidden="true">${escapeHtml(m.label)}</span>` : "")).join("");
      out += "</mark>".repeat(covering.length);
    }
  }
  return out;
}
