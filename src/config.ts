/**
 * Site-level configuration the editor may change freely.
 *
 * `readerDefaults` are the reader settings used until the reader changes
 * something (persisted afterwards in localStorage). They are read by:
 * - an inline pre-paint script in BaseLayout (define:vars) so saved settings
 *   (or these defaults when nothing is saved) apply before first paint, and
 * - the stylesheet's default rules, which MUST stay in sync for the no-JS
 *   case (see the sync note in src/styles/site.css).
 */

export const site = {
  /** Site name shown in the header and <title> suffix. */
  title: "tabyo",
  /** Default meta description when a page does not provide one. */
  description:
    "Your Greek New Testament text beside your English translation, with notes on the readings.",
  /**
   * Absolute site origin used for <link rel="canonical">. SET THIS TO THE REAL
   * DOMAIN BEFORE LAUNCH (e.g. "https://tabyo.example") — wrong canonicals
   * point crawlers off-site. The homepage renders the chapter below; its
   * canonical points at the corresponding /<book>/<chapter>/ URL.
   */
  url: "https://tabyo.example",
  /**
   * The book + chapter the homepage (/) loads ("read us landing on text").
   * USFM book code + integer chapter; must have data on disk.
   */
  home: {
    book: "MRK",
    chapter: 1,
  },
} as const;

export type HighlightStyle = "underline" | "dotted" | "tint" | "dot" | "none";
export type FontSize = "s" | "m" | "l";

export interface ReaderSettings {
  highlightGreek: HighlightStyle;
  highlightEnglish: HighlightStyle;
  highlights: "on" | "off";
  muteUntouched: "on" | "off";
  fontSize: FontSize;
}

export const readerDefaults: ReaderSettings = {
  highlightGreek: "underline",
  highlightEnglish: "underline",
  highlights: "on",
  muteUntouched: "off",
  fontSize: "m",
};
