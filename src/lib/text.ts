/**
 * NFC text-matching helpers for note anchors.
 *
 * This is the one place anchor phrases are matched against verse text —
 * `scripts/validate.ts` uses it to report bad anchors and the page renderers
 * use it to locate the exact span to wrap in <mark>. Both normalise both
 * sides to NFC (the contract guarantees base Greek text is NFC; English and
 * hand-written overrides are normalised here so note authors need not care).
 */

/** Exact-phrase occurrence count; both sides NFC-normalised before matching. */
export function countOccurrences(verse: string, phrase: string): number {
  const hay = verse.normalize("NFC");
  const needle = phrase.normalize("NFC");
  let count = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    count++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return count;
}

/**
 * Character span of the `occurrence` (1-based) of `phrase` inside `text`,
 * all NFC-normalised first.
 *
 * Returns null when the phrase occurs zero times; throws when `occurrence`
 * exceeds the count — mirroring the validator's two error cases, so callers
 * report one consistent story (occurrence must be given if a phrase occurs
 * more than once, and must point at something that exists).
 */
export function locateNfc(text: string, phrase: string, occurrence = 1): { start: number; end: number } | null {
  const hay = text.normalize("NFC");
  const needle = phrase.normalize("NFC");
  let count = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    count++;
    if (count === occurrence) return { start: i, end: i + needle.length };
    i = hay.indexOf(needle, i + needle.length);
  }
  if (count === 0) return null;
  throw new Error(
    `anchor phrase occurs ${count}x but occurrence ${occurrence} was requested` +
      (occurrence === 1 && count > 1 ? " — add anchor.occurrence to the note" : "")
  );
}
