# tabyo

An aligned, apparatus-bearing reader for an editable biblical edition —
static output (Astro + TypeScript, no backend), MIT-licensed.

tabyo renders a **Greek text beside an English translation**, verse row by
verse row, with the editor's adopted readings and notes overlaid on top of
whatever base texts you choose. Anchored phrases open apparatus/rationale
notes; everything is validated against a strict data contract at build time.

The bundled **demo edition** is Mark 1: SBLGNT (Greek) and Berean Standard
Bible (English) as base texts, plus a handful of sample overrides and notes so
you can see the apparatus, popovers, and mention anchoring working end to end.
The demo data does not represent real editorial decisions — it exists to be
replaced by yours.

## Repo layout

```
data/
  base/
    greek/<BOOK>/<chapter>.json      # base text (generated; never hand-edited)
    english/<BOOK>/<chapter>.json
  mine/
    greek/<BOOK>.yaml                # the editor's Greek overrides (and additions)
    english/<BOOK>.yaml              # the editor's English overrides
  notes/<BOOK>.yaml                  # notes: Greek (apparatus) and English
  layout/<BOOK>.yaml                 # rows per chapter (generated, hand-tunable)
  attribution.yaml                   # licence/attribution per base source
src/
  schemas.ts                         # the central Zod data contract (start here)
  config.ts                          # site metadata + reader-setting defaults
  lib/books.ts                       # USFM book table: code, display name, order, chapters
  lib/data.ts                        # loader: reads + validates, typed accessors
  lib/text.ts                        # NFC anchor matching (shared by validator + renderer)
  lib/routes.ts                      # URL helpers: slugs, hrefs, base-path aware
  lib/pages.ts                       # markdown-page discovery (src/pages-md/)
  lib/render.ts                      # row assembly + note-anchor <mark> wrapping
  layouts/BaseLayout.astro           # header/footer chrome, pre-paint settings script
  layouts/PageLayout.astro           # shared layout for static markdown pages
  components/*.astro                 # Verse, Note, BookPicker, ReadingToolbar, ChapterBody
  pages/index.astro                  # /          (hero + default chapter)
  pages/[book]/index.astro           # /<book>/   (chapter list)
  pages/[book]/[chapter].astro       # /<book>/<chapter>/
  pages/[...slug].astro              # /<slug>/    (walks src/pages-md/*.md)
  pages/sources.astro                # /sources/   (from data/attribution.yaml)
  pages-md/about.md                  # sample static page
  styles/site.css                    # all styling (themes, settings, popover, print)
public/fonts/                        # self-hosted Gentium Plus (OFL)
public/js/reader.js                  # all reader behaviour, vanilla JS
scripts/
  validate.ts                        # npm run validate
  make-layout.ts                     # npm run make-layout -- <BOOK> [--force]
  ingest-sblgnt.ts                   # SBLGNT drop → base files (see data-prep/ below)
  ingest-bsb.ts                      # BSB drop → English base files
  smoke-loader.ts                    # tiny manual sanity check of the loader
README.md
.github/workflows/deploy-gh-pages.yml  # optional GitHub Pages deploy (manual)
```

## Quick start

```
npm install
npm run dev        # http://localhost:3061 — the demo edition, Mark 1
npm run build      # validates the data contract, then builds dist/
npm run validate   # data-contract check alone
```

To start your edition: replace `data/` with your own base texts, overrides,
and notes (the contract is below), change `src/config.ts` (`site` metadata,
`readerDefaults`, `site.home`), and you have a static edition.

## The data contract in plain language

### Books & references

- Books are identified by **USFM 3-letter codes** (`MAT`, `MRK`, `LUK`, `JHN`, …).
  The full 66-book table (code, display name, canonical order, chapter count)
  lives in `src/lib/books.ts`. Everything under `data/` is per-book file named
  after the code.
- Verse references inside a book file are **`"chapter:verse"`**, e.g. `"1:4"`.
- Verse numbers are **plain integers**. A source that carries verse parts such
  as `4a` violates the contract on purpose: that is flagged as an error rather
  than silently absorbed into a numbering scheme.
- All Greek text is **NFC-normalised**; base chapter files are refused otherwise.

### Base text — `data/base/<greek|english>/<BOOK>/<chapter>.json`

One JSON file per book + chapter:

```json
{
  "book": "MRK",
  "chapter": 1,
  "source": "sblgnt",
  "verses": { "1": "Ἀρχὴ τοῦ εὐαγγελίου Ἰησοῦ Χριστοῦ υἱοῦ θεοῦ.", "2": "…" }
}
```

- `verses` maps verse numbers to verse text (Greek NFC-normalised; English
  whitespace-flattened). `source` is a slug key into `data/attribution.yaml`.
- Optional, from sources that provide them:
  - `paragraphs`: `[{ "start": 1, "end": 3 }, …]` — inclusive, non-overlapping,
    never crossing a chapter.
  - `headings`: `[{ "verse": 1, "text": "…" }]` — pericope titles.
- These files are machine-generated from a source drop (see
  [Ingesting a source drop](#ingesting-a-source-drop)); never hand-edit them.

### My text (the editor's overrides) — `data/mine/<greek|english>/<BOOK>.yaml`

```yaml
"1:7": καὶ ἐκήρυσσεν λέγων· …
```

- Only overridden verses appear, as `"chapter:verse"` → **full replacement**
  verse text, merged over the base at load time.
- A key may also point at a verse that does not exist in the base — an
  *addition*. The validator warns on additions so a typo'd ref cannot
  masquerade as intent.

### Notes — `data/notes/<BOOK>.yaml`

```yaml
greek:
  - id: mrk-1-7-iskuros          # unique within the book (both languages share the space)
    ref: "1:7"
    anchor:
      phrase: "ἱκανὸς κύψας"     # matched against the FINAL merged verse text
      occurrence: 1              # 1-based; required if the phrase occurs more than once
    baseReading: "ὁ ἰσχυρότερός μου"   # optional: the base reading, shown when it differs
    rationale: |
      Markdown explanation of why this note / reading exists.
    apparatus:                   # Greek notes only
      - reading: "ἱκανὸς κύψας"
        witnesses: "Byz (RP); Θ*; 565"
        adopted: true            # the reading the displayed text follows
      - reading: "ἱκανόν"
        witnesses: "NA28 main text"
      - reading: ""
        kind: omission           # omission: the phrase is absent; `reading` may be empty
english:
  - id: mrk-1-4-baptizer
    ref: "1:4"
    anchor: { phrase: "Baptizer" }
    rationale: "…"               # English notes: rationale only, no apparatus
```

- Anchors match the **final (merged)** verse text — the editor's override when
  one exists, otherwise the base verse. Note ids are unique per book across
  both language lists.
- If an anchor can't be found or is ambiguous, the validator **fails the
  build** with the book/ref/id so nothing reaches readers unexplained.

### Layout — `data/layout/<BOOK>.yaml`

```yaml
chapters:
  "1":
    - greek: "1-3"     # "a-b" range or a single verse; null = no Greek content here
      english: "1-3"
      heading: "The Beginning"
    - greek: "9"
      english: null    # a Greek-only row
```

Every row aligns a Greek verse range with an English verse range (either side
may be `null`, not both). Generated by `npm run make-layout`, then
hand-tunable. A book with **no** layout file still renders — rows are
generated in memory, one per verse, with a console warning.

### Attribution — `data/attribution.yaml`

```yaml
sources:
  sblgnt:
    name: "SBL Greek New Testament"
    licence: "…"       # licence text/abbrev
    attribution: "…"   # reader-facing attribution
```

The `/sources/` page renders from this file; the footer of every page links to
it. Fill in real texts — the licence conditions of your base sources (CC BY 4.0
for SBLGNT, public domain for BSB) are the only legal constraints on what
tabyo shows.

## Ingesting a source drop

The ingest scripts convert raw source drops into base files. Make a
`data-prep/` folder (git-ignored) holding your drops — one folder per book:

```
data-prep/mrk/
  mrk.txt                      # one verse per line: "Jn 1:1\t<text>" style (SBLGNT)
  para-rows/1-para-rows.json   # paragraph bounds as arrays of verse numbers
  mrk.json                     # BSB source (English)
```

```
npm run ingest-sblgnt -- MRK [--dry-run] [--force]
npm run ingest-bsb -- MRK [--dry-run] [--force]
npm run make-layout -- MRK [--force]      # then hand-tune data/layout/MRK.yaml
npm run validate
```

Both ingests harness the leave-nothing-behind principle: verse text is
NFC-normalised, critical signs kept verbatim, paragraph arrays must exactly
cover each chapter's verses, and any error aborts before a single file is
written. Keep the raw drops out of version control (third-party licences vary
by file).

## The site

### Routes

- `/` — hero + reading toolbar + the default chapter (`site.home` in
  `src/config.ts`), canonicalized to the chapter route.
- `/<book>/` — chapter list (`<book>` = dashed display name, e.g. `mark`).
- `/<book>/<chapter>/` — the chapter, two-column aligned rows, endnote list
  for the no-JS case.
- `/<slug>/` — every Markdown file in `src/pages-md/` becomes a static page.
- `/sources/` — attribution, generated from `data/attribution.yaml`.

### Notes: popovers, bottom sheets, print endnotes

Every anchored phrase is a `<mark tabindex="0">` trigger. Clicking or
Enter/Space opens its note — anchored popover on desktop, bottom sheet on
narrow screens. Opening one updates the hash to `#note-ID` (shareable); Esc,
Close, and outside clicks dismiss. With JavaScript off, the notes remain a
readable list at the end of the chapter. Print renders numbered footnotes.

### Reader settings ("Aa")

Each setting is a data attribute on `<html>`, driven by `src/config.ts`
defaults, persisted in localStorage, applied before first paint:

| config key | data attribute | values |
| --- | --- | --- |
| `readerDefaults.highlightGreek` | `data-hl-greek` | `underline \| dotted \| tint \| dot \| none` |
| `readerDefaults.highlightEnglish` | `data-hl-english` | `underline \| dotted \| tint \| dot \| none` |
| `readerDefaults.highlights` | `data-highlights` | `on \| off` |
| `readerDefaults.muteUntouched` | `data-mute-untouched` | `on \| off` |
| `readerDefaults.fontSize` | `data-font-size` | `s \| m \| l` |

`muteUntouched: "on"` dims verses the editor has not overridden (off by
default). Light/dark follows the OS; both palettes are designed.

## Validation — `npm run validate`

Walks every file under `data/`, checks the schemas plus cross-file rules, and
exits non-zero if any ERROR occurred. **Builds fail the same way** — validate
runs as part of `npm run build`.

Errors: overrides that refer to nothing; duplicate note ids; layout ranges
that overlap, are out of order, or reference verses absent from both texts;
apparatus readings empty without `kind: "omission"`; anchors not found in the
final merged text. Warnings: additions, identical-to-base overrides, base
verses uncovered by layout rows, and verses that differ from base with no note
anchored in them (author-only lint: nothing reaches readers unexplained).

## Typography

Greek renders in **Gentium Plus** (SIL, OFL licence), self-hosted in
`public/fonts/` (Regular + Italic, woff2 with woff fallback). English uses the
system UI font.

## Deployment

Static output (`dist/`, one HTML file per route). No server code, no
environment variables, no database.

**Cloudflare Pages (primary):** connect the repo, build command
`npm run build`, output directory `dist`, and set `NODE_VERSION` to your Node
major. Before launch, set `site.url` in `src/config.ts` to the real site
origin — every `<link rel="canonical">` is built from it.

**GitHub Pages (optional):** for project pages (`/<repo>/…` sub-path), the
build needs `PUBLIC_BASE` — the included workflow
`.github/workflows/deploy-gh-pages.yml` does this; run it from the Actions tab
or set its trigger to push-based.

## Licence

- **Engine code:** MIT (see `LICENSE`).
- **Base texts inside `data/` are governed by their own licences** (SBLGNT:
  CC BY 4.0 — attributed in `data/attribution.yaml`; BSB: public domain). If
  you swap a base source, record it in `attribution.yaml`; the licence is
  yours to satisfy.
- The sample overrides and notes in `data/mine/` and `data/notes/MRK.yaml` are
  demo scaffolding — replace them with your own decisions, which are yours to
  licence as you see fit.

## Commands

```
npm install
npm run validate                 # data contract check (non-zero exit on errors)
npm run make-layout -- MRK       # generate data/layout/MRK.yaml (--force to overwrite)
npm run ingest-sblgnt -- MRK     # convert a data-prep/ SBLGNT drop to base files
npm run ingest-bsb -- MRK        # convert a data-prep/ BSB drop to English base files
npm run dev                      # astro dev (http://localhost:3061)
npm run build                    # validate data first, then astro build
npm run preview                  # preview the built site in dist/ (port 3061)
npx tsc --noEmit                 # typecheck
```
