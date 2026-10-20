/**
 * Static pages: any Markdown file in `src/pages-md/` becomes a route at
 * /<filename> (e.g. pages-md/philosophy.md → /philosophy), rendered through
 * a shared layout (src/layouts/PageLayout.astro, which wraps BaseLayout).
 *
 * Frontmatter contract: `title` (required), `order` (optional number — pages
 * sort by it in nav lists), `nav` (boolean, default true — hide from nav).
 * The book index ("/") is not nav-generated from here, it is the main route.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const PAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "pages-md");

/** Absolute path of src/pages-md/ for other callers (the [...slug] rest route). */
export const MD_PAGES_DIR = PAGES_DIR;

export interface StaticPageMeta {
  slug: string;
  title: string;
  order: number | null;
}

async function frontmatterOf(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(file, "utf8");
    // Cheap frontmatter extraction: the pages are tiny; a full parser is
    // unnecessary only because Astro itself will parse the real file later.
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!m) return null;
    return parseYaml(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Meta (slug, title, order) for every markdown page under src/pages-md/. */
export async function listStaticPages(): Promise<StaticPageMeta[]> {
  let names: string[];
  try {
    names = await readdir(PAGES_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: StaticPageMeta[] = [];
  for (const name of names) {
    const m = /^(.+)\.md$/.exec(name);
    if (!m) continue;
    const fm = await frontmatterOf(path.join(PAGES_DIR, name));
    const nav = fm?.nav !== false;
    if (!nav) continue;
    const title = typeof fm?.title === "string" ? fm.title : m[1];
    const order = typeof fm?.order === "number" ? fm.order : null;
    out.push({ slug: m[1], title, order });
  }
  // Sorted by `order` when present; pages without it keep file name order after.
  return out.sort((a, b) => {
    if (a.order !== null && b.order !== null) return a.order - b.order;
    if (a.order !== null) return -1;
    if (b.order !== null) return 1;
    return a.slug.localeCompare(b.slug);
  });
}
