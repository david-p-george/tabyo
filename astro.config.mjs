// @ts-check
import { defineConfig } from "astro/config";

// Static output only: no server, no backend. Data is read at build time.
//
// Cloudflare Pages (primary): no changes needed — the site builds at a domain
// root, and dist/ is served as-is.
//
// GitHub Pages project pages (optional alt): set PUBLIC_BASE to the repo path
// when building, e.g.
//   $env:PUBLIC_BASE="/tabyo"; npm run build     (PowerShell)
//   PUBLIC_BASE=/tabyo npm run build             (bash)
// Every internal URL goes through src/lib/routes.ts withBase()/basePath and
// the built stylesheet uses ../fonts/ URLs, so links keep working under the
// sub-path. A custom domain (see README) makes this unnecessary.
const base = process.env.PUBLIC_BASE;

export default defineConfig({
  output: "static",
  // Local ports: dev server and preview both serve on 3061.
  server: { port: 3061 },
  // preview: { port: 3061 },
  ...(base ? { base } : {}),
});
