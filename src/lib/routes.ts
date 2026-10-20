/**
 * URL helpers. Books get readable slugs derived from the display name
 * ("Mark" → mark, "1 Samuel" → 1-samuel); chapters are plain integers, so
 * routes are /<slug>/ and /<slug>/<chapter>/.
 *
 * Every URL this module (and BaseLayout) emits passes through withBase(), so
 * a deploy under a sub-path (GitHub Pages project pages: astro.config sets
 * `base: "/<repo>"`) works with no per-link edits. At a domain root
 * (Cloudflare Pages) BASE_URL is "/" and links are unchanged.
 */
import { BOOKS, type BookMeta, getBookMeta } from "./books.ts";

/** Site base path without trailing slash: "" at a domain root, "/<repo>" otherwise. */
export const basePath = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");

/** Prefix an absolute-site path ("/sources/") with the deploy base. */
export const withBase = (sitePath: string): string => `${basePath}${sitePath}`;

export function bookSlug(code: string): string {
  const meta = getBookMeta(code);
  if (!meta) throw new Error(`Unknown USFM book code "${code}"`);
  return meta.name.toLowerCase().replaceAll(" ", "-");
}

/** Inverse of bookSlug, over the known book table. */
export function codeFromSlug(slug: string): string | undefined {
  const target = slug.toLowerCase();
  return BOOKS.find((b) => b.name.toLowerCase().replaceAll(" ", "-") === target)?.code;
}

export const hrefBook = (code: string) => withBase(`/${bookSlug(code)}/`);
export const hrefChapter = (code: string, chapter: number) => `${hrefBook(code)}${chapter}/`;
export const hrefRoot = () => withBase("/");

/** Gospels always surface first (they are the only books with data for now). */
const GOSPELS = new Set(["MAT", "MRK", "LUK", "JHN"]);

/** Sort key putting Gospels first, then canonical order. */
export function bookListRank(meta: BookMeta): [number, number] {
  return [GOSPELS.has(meta.code) ? 0 : 1, meta.order];
}
