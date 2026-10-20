/**
 * Central data contract for the whole site.
 *
 * Everything that lives under `data/` — base text, my overrides, my notes, layout
 * rows, attribution — is described here with Zod, and the TypeScript types are the
 * inferred ones. Change note/verse structures here and every consumer (validation
 * script, layout generator, loader, pages) picks it up.
 *
 * Conventions encoded here, on purpose:
 * - Books are USFM 3-letter codes (MAT, MRK, ...). See `src/lib/books.ts` for the
 *   name/order/chapter-count table.
 * - Verses are plain integers, no leading zeros. A source with verse parts like
 *   "4a" violates this schema — that is a decision to revisit with new sources,
 *   not a scheme to invent quietly (see README "Verse numbering").
 * - Verse refs are "chapter:verse" inside a book file ("1:4"); ranges are "a-b" or
 *   a bare verse ("1-3" | "4"); refs in layout/note files are book-relative.
 * - All Greek text must be NFC. Base chapter files are refined on this here so a
 *   non-NFC source file fails loudly at validation/load time.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** USFM 3-letter book code, e.g. MAT, MRK, 2SA, 3JN. */
export const BookCode = z
  .string()
  .regex(/^[1-3]?[A-Z]{3}$/, "expected a USFM 3-letter code (MAT, MRK, 2SA, …)");

/** A verse number as a key: integer, no leading zeros ("1", "23"). */
export const VerseNumber = z.string().regex(/^[1-9]\d*$/, "verse number must be an integer (no leading zeros, no '4a' parts)");

/** A verse reference within a book: "chapter:verse", e.g. "1:4". */
export const VerseRef = z.string().regex(/^(?:[1-9]\d*):(?:[1-9]\d*)$/, 'verse ref must be "chapter:verse", e.g. "1:4"');

/**
 * A verse range within one chapter: "1-3" or a single verse "4".
 * Ranges never cross chapter boundaries; layout rows are chapter-scoped.
 */
export const VerseRange = z
  .string()
  .regex(/^(?:[1-9]\d*)(?:-(?:[1-9]\d*))?$/, 'a range is "a-b" or a bare verse, e.g. "1-3" or "4"');

/** A chapter number key: integer, no leading zeros ("1"). */
export const ChapterNumber = z.string().regex(/^[1-9]\d*$/, "chapter number must be an integer");

/* Small parsing helpers shared by scripts and the loader (not schemas). */

/** "4" → { start: 4, end: 4 }; "1-3" → { start: 1, end: 3 }. Returns null if malformed or inverted. */
export function parseVerseRange(range: string): { start: number; end: number } | null {
  const m = /^(?:([1-9]\d*))(?:-([1-9]\d*))?$/.exec(range);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (end < start) return null;
  return { start, end };
}

/** "1:4" → { chapter: 1, verse: 4 }. Returns null if malformed. */
export function parseVerseRef(ref: string): { chapter: number; verse: number } | null {
  const m = /^([1-9]\d*):([1-9]\d*)$/.exec(ref);
  if (!m) return null;
  return { chapter: Number(m[1]), verse: Number(m[2]) };
}

/* ------------------------------------------------------------------ */
/* Base text (generated, never hand-edited)                            */
/*                                                                    */
/* data/base/greek/<BOOK>/<chapter>.json                                */
/* data/base/english/<BOOK>/<chapter>.json                              */
/* ------------------------------------------------------------------ */

/** A paragraph description in a base text. `end` may equal `start` for single-verse paragraphs. */
const BaseParagraph = z.object({
  /** First verse of the paragraph (inclusive). */
  start: z.number().int().min(1),
  /** Last verse of the paragraph (inclusive). */
  end: z.number().int().min(1),
  /** Optional pericope/section heading printed when the paragraph starts. */
  heading: z.string().optional(),
});

/** A standalone section heading placed before `verse` (e.g. BSB pericopes). */
const BaseHeading = z.object({
  /** The first verse the heading applies to. */
  verse: z.number().int().min(1),
  text: z.string().min(1),
});

/**
 * One chapter of a base text. `source` identifies the third-party source and must
 * map to a key in `data/attribution.yaml` (e.g. "sblgnt", "bsb"); the validator
 * warns if it doesn't.
 */
export const BaseChapter = z
  .object({
    book: BookCode,
    chapter: z.number().int().min(1),
    /** Attribution slug, e.g. "sblgnt" or "bsb". */
    source: z.string().min(1),
    /** Map of verse number → full verse text, all Greek NFC-normalised. */
    verses: z.record(VerseNumber, z.string()),
    /** Optional verse/paragraph structure. Absent if the source has none. */
    paragraphs: z.array(BaseParagraph).optional(),
    /** Standalone section headings (e.g. BSB pericopes); independent of `paragraphs`. */
    headings: z.array(BaseHeading).optional(),
  })
  .superRefine((file, issues) => {
    // Enforce NFC here, not just in the validation script, so any consumer of base
    // data fails loudly on non-normalised Greek.
    for (const [verse, text] of Object.entries(file.verses)) {
      const nfc = text.normalize("NFC");
      if (nfc !== text) {
        issues.addIssue({
          code: "custom",
          path: ["verses", verse],
          message: "text is not NFC-normalised",
        });
      }
    }
    const maxVerse = Object.keys(file.verses)
      .map(Number)
      .reduce((a, b) => Math.max(a, b), 0);
    (file.paragraphs ?? []).forEach((p, i) => {
      if (p.end < p.start) {
        issues.addIssue({ code: "custom", path: ["paragraphs", i], message: `paragraph end ${p.end} is before start ${p.start}` });
      } else if (p.end > maxVerse) {
        issues.addIssue({ code: "custom", path: ["paragraphs", i], message: `paragraph ${p.start}-${p.end} exceeds last verse (${maxVerse})` });
      }
    });
    (file.headings ?? []).forEach((h, i) => {
      if (h.text.normalize("NFC") !== h.text) {
        issues.addIssue({ code: "custom", path: ["headings", i, "text"], message: "text is not NFC-normalised" });
      }
      if (!file.verses[String(h.verse)]) {
        issues.addIssue({ code: "custom", path: ["headings", i], message: `heading points at verse ${h.verse}, which has no verse text` });
      }
    });
  });

export type BaseChapterData = z.infer<typeof BaseChapter>;

/* ------------------------------------------------------------------ */
/* My overrides                                                        */
/*                                                                    */
/* data/mine/greek/<BOOK>.yaml, data/mine/english/<BOOK>.yaml           */
/* Only overridden verses appear. A key may point at a verse that does   */
/* not exist in the base — an addition; the validator warns on those.    */
/* ------------------------------------------------------------------ */

/** Map of "chapter:verse" → full replacement verse text for one book & language. */
export const MineOverrides = z.record(VerseRef, z.string());

export type MineOverridesData = z.infer<typeof MineOverrides>;

/* ------------------------------------------------------------------ */
/* Notes                                                               */
/*                                                                    */
/* data/notes/<BOOK>.yaml = { greek: [...], english: [...] }            */
/* Anchors match exactly against the *final* (merged) verse text, after */
/* NFC normalisation — so a note may anchor a base verse un-overridden.  */
/* ------------------------------------------------------------------ */

/** Anchor: exact phrase within one verse; `occurrence` is 1-based, default 1. */
export const Anchor = z.object({
  /** Exact substring of the final verse text (Greek is matched after NFC). */
  phrase: z.string().min(1),
  /** 1-based occurrence of `phrase` in the verse; default 1. */
  occurrence: z.number().int().min(1).optional(),
});

/**
 * One textual-criticism reading in a Greek apparatus. An entry marked
 * `kind: "omission"` represents a reading where the phrase is absent — such an
 * entry may leave `reading` empty (and then renders as an omission marker).
 */
export const ApparatusReading = z
  .object({
    /** Reading text; empty only when `kind: "omission"`. */
    reading: z.string(),
    /** Special reading kinds. `"omission"` = the phrase is absent from these witnesses. */
    kind: z.enum(["omission"]).optional(),
    /** Witnesses, free text, e.g. "א B D" — no schema imposed. */
    witnesses: z.string().min(1),
    /** Whether I adopt this reading in my displayed text. Default: not adopted. */
    adopted: z.boolean().optional(),
  })
  .superRefine((r, issues) => {
    if (r.kind !== "omission" && r.reading.trim() === "") {
      issues.addIssue({
        code: "custom",
        path: ["reading"],
        message: `empty reading must set kind: "omission"`,
      });
    }
  });

/** A Greek note: external/editorial note with a witness-level apparatus. */
export const GreekNote = z.object({
  /** Note id, unique within the book (across greek AND english notes). */
  id: z.string().min(1),
  /** Verse the note is anchored to, "chapter:verse" within this book. */
  ref: VerseRef,
  /** Exact-text anchor into the final (merged) verse text. */
  anchor: Anchor,
  /**
   * The base text's reading for the anchored span, when it differs from my
   * displayed text and is not already a line of the apparatus. Rendered as a
   * small "SBLGNT reads: …" line above the apparatus. Optional.
   */
  baseReading: z.string().min(1).optional(),
  /** Why the note exists / why the reading was adopted. Markdown. */
  rationale: z.string().min(1),
  /** Witness apparatus; an entry with `kind: "omission"` may have an empty reading. */
  apparatus: z.array(ApparatusReading).min(1),
});

/** An English-translation note: rationale only, no apparatus. */
export const EnglishNote = z.object({
  id: z.string().min(1),
  ref: VerseRef,
  anchor: Anchor,
  rationale: z.string().min(1),
});

export const NotesBook = z.object({
  greek: z.array(GreekNote).optional(),
  english: z.array(EnglishNote).optional(),
});

export type AnchorData = z.infer<typeof Anchor>;
export type ApparatusReadingData = z.infer<typeof ApparatusReading>;
export type GreekNoteData = z.infer<typeof GreekNote>;
export type EnglishNoteData = z.infer<typeof EnglishNote>;
export type NotesBookData = z.infer<typeof NotesBook>;

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/*                                                                    */
/* data/layout/<BOOK>.yaml — rows per chapter. Each row aligns a Greek   */
/* verse range with an English verse range; either side may be null.     */
/* Rows are chapter-scoped: paragraphs crossing a chapter boundary are   */
/* split at it, so a range always lies inside one chapter.               */
/* ------------------------------------------------------------------ */

/** One layout row. At least one side must be present. */
export const LayoutRow = z
  .object({
    /** Greek verse range "a-b" or "4", or null if the row is not Greek-first. */
    greek: VerseRange.nullable(),
    /** English verse range, or null if the row is Greek-only. */
    english: VerseRange.nullable(),
    /** Optional heading shown at the row (e.g. a pericope title). */
    heading: z.string().optional(),
  })
  .superRefine((row, issues) => {
    if (row.greek === null && row.english === null) {
      issues.addIssue({ code: "custom", message: "a row cannot have both greek and english null" });
    }
  });

export const LayoutBook = z.object({
  chapters: z.record(ChapterNumber, z.array(LayoutRow)),
});

export type LayoutRowData = z.infer<typeof LayoutRow>;
export type LayoutBookData = z.infer<typeof LayoutBook>;

/* ------------------------------------------------------------------ */
/* Attribution                                                         */
/*                                                                    */
/* data/attribution.yaml — licence/attribution per base source.         */
/* Keys must match the `source` slug in base chapter files.             */
/* ------------------------------------------------------------------ */

export const AttributionSource = z.object({
  /** Human-readable source name, e.g. "SBL Greek New Testament". */
  name: z.string().min(1),
  /** Licence name/abbrev., e.g. "CC BY 4.0" — filled in by me. */
  licence: z.string().min(1),
  /** Reader-facing attribution/permission text shown on the site. */
  attribution: z.string().min(1),
});

export const Attribution = z.object({
  /** Map of source slug (matching base files' `source`, e.g. "sblgnt") → attribution. */
  sources: z.record(z.string().min(1), AttributionSource),
});

export type AttributionData = z.infer<typeof Attribution>;
