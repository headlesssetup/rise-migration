# Rise Block Catalog (living document)

The documented understanding of Rise block types and their options. **Seeded from `rise-api-reference.md` §11; grown by the tool's novelty review.** The tool keeps a machine-readable source of truth (per block: shape signature, fields, media paths, cross-refs, versions seen, provenance) and regenerates this human-readable view. Every accepted novelty (new variant, new field/option, new version shape) adds or updates an entry here — that is the project's documentation side-product.

**Status legend:** `documented` (fields understood) · `seen` (captured, fields partially understood) · `pending` (expected to exist, not yet captured) · `review` (auto-captured, awaiting operator classification).

---

## Confirmed variants (`family/variant`)

| family/variant | Description | Key item fields / options | Media paths | Cross-refs | Versions seen | Status |
|---|---|---|---|---|---|---|
| `text/*` | Text blocks (paragraph etc.) | rich HTML in `items[]`; `data-editor-id`, `mighty-type-style-*` font classes | — | — | _TODO_ | documented |
| `list/numbered` | Numbered list | list items (HTML) | — | — | _TODO_ | seen |
| `image/hero` | Hero image | media ref | image key | — | _TODO_ | documented |
| `multimedia/video` | Video block | media ref | video key (transcoded) | — | _TODO_ | documented |
| `flashcard/flashcard` | Flashcard grid | card items | per-card media keys | — | _TODO_ | seen |
| `interactive-fullscreen/labeledgraphic` | Labeled graphic | markers w/ positions | base + per-marker media | — | _TODO_ | seen |
| `interactive-fullscreen/process` | Process | step items | per-step media | — | _TODO_ | seen |
| `interactive-fullscreen/sorting` | Sorting activity | cards/buckets | per-card media | — | _TODO_ | seen |
| `continue/continue` | Continue / gating | settings | — | — | _TODO_ | documented |
| `divider/numbered divider` | Divider | — | — | — | _TODO_ | seen |
| `html/inline` | Embedded code (inline) | raw HTML | — | — | _TODO_ | seen |
| `html/cdn` | Embedded code (CDN) | reference | possibly CDN | — | _TODO_ | seen |
| `360/storyline` | Storyline block | `items[0].media.storyline{contentPrefix,src,meta}` | bundle under contentPrefix | **Review 360 item** (project_id/title) | _TODO_ | documented |
| `knowledgeCheck/draw from question bank` | Draw from bank | `items[].type:DRAW_FROM_QUESTION_BANK` | — | **question-bank id** | _TODO_ | documented |
| `text/heading` | Heading text | rich HTML; optional `background`, `settings.customPadding*` | — | — | _TODO_ | seen |
| `text/heading paragraph` | Heading + paragraph | as `text/*`; optional `background`, padding settings | — | — | _TODO_ | seen |
| `list/bulleted` | Bulleted list | list items (HTML) | — | — | _TODO_ | seen |
| `list/checkboxes` | Checkbox list | list items (HTML) | — | — | _TODO_ | seen |
| `image/text aside` | Image beside text | media ref + text | image key | — | _TODO_ | seen |
| `image/text overlay` | Text over image | media ref + text | image key | — | _TODO_ | seen |
| `gallery/three column` | 3-column gallery | image items | per-image keys | — | _TODO_ | seen |
| `buttons/button` | Single button | `items[]` button (title, link/href) | — | — | _TODO_ | seen |
| `buttons/button stack` | Button stack | multiple button items | — | — | _TODO_ | seen |
| `impact/b` | Impact block (style b) | `items[].heading`; optional `settings.customPadding*`, `settings.v` | optional bg image | — | _TODO_ | seen |
| `interactive/accordion` | Accordion | `items[]` panels; optional `items[].media.image{dimensions,…}` | per-panel image | — | _TODO_ | seen |
| `multimedia/embed` | Embed (YouTube/Vimeo) | `items[].embed.url` | — (embed URL kept as-is) | — | _TODO_ | seen |
| `knowledgeCheck/multiple response` | Multiple-response KC block | `answers[]` carry `correct` | — | — | _TODO_ | seen |

## Confirmed via 579-course scrape (2026-06-19)

Accepted from novelty review; the full per-variant field profiles (core/optional)
are recorded in `core/census/catalog.fields.json`. "Frequency" = block instances /
courses across that library.

| family/variant | Frequency | Fields (core) | Media | Cross-refs | Versions | Status |
|---|---|---|---|---|---|---|
| `image/full` | 2989 blk / 325 crs | 102 (18 core) | image | — | _TODO_ | seen |
| `impact/note` | 1618 blk / 369 crs | 96 (11 core) | — | — | _TODO_ | seen |
| `knowledgeCheck/multiple choice` | 1258 blk / 214 crs | 135 (16 core) | — | — | _TODO_ | seen |
| `impact/d` | 1174 blk / 141 crs | 49 (11 core) | — | — | _TODO_ | seen |
| `interactive/tabs` | 835 blk / 214 crs | 345 (13 core) | per-tab media | — | _TODO_ | seen |
| `divider/divider` | 496 blk / 123 crs | 37 (11 core) | — | — | _TODO_ | seen |
| `divider/spacing divider` | 429 blk / 196 crs | 36 (9 core) | — | — | _TODO_ | seen |
| `interactive-fullscreen/timeline` | 308 blk / 193 crs | 135 (15 core) | per-item media | — | _TODO_ | seen |
| `interactive-fullscreen/scenario` | 267 blk / 79 crs | 542 (148 core) | image (characters, bg) | — | _TODO_ | seen |
| `gallery/four column` | 181 blk / 86 crs | 90 (19 core) | image | — | _TODO_ | seen |
| `gallery/two column` | 169 blk / 87 crs | 73 (17 core) | image | — | _TODO_ | seen |
| `mondrian/mondrian` | 148 blk / 30 crs | 39 (7 core) | image (collage) | — | _TODO_ | seen |
| `knowledgeCheck/matching` | 141 blk / 55 crs | 84 (17 core) | — | — | _TODO_ | seen |
| `multimedia/attachment` | 135 blk / 80 crs | 65 (15 core) | attachment | — | _TODO_ | seen |
| `impact/c` | 95 blk / 48 crs | 49 (11 core) | — | — | _TODO_ | seen |
| `quote/a` | 83 blk / 31 crs | 78 (22 core) | image (bg, avatar) | — | _TODO_ | seen |
| `quote/carousel` | 75 blk / 30 crs | 71 (22 core) | image (bg, avatar) | — | _TODO_ | seen |
| `multimedia/audio` | 68 blk / 25 crs | 66 (14 core) | audio | — | _TODO_ | seen |
| `multimedia/code` | 65 blk / 5 crs | 36 (14 core) | — | — | _TODO_ | seen |
| `impact/a` | 60 blk / 21 crs | 32 (11 core) | — | — | _TODO_ | seen |
| `quote/d` | 53 blk / 19 crs | 76 (19 core) | image (avatar) | — | _TODO_ | seen |
| `gallery/centered` | 49 blk / 32 crs | 68 (17 core) | image | — | _TODO_ | seen |
| `image/banner` | 35 blk / 13 crs | 47 (23 core) | image | — | _TODO_ | seen |
| `flashcard/stack` | 34 blk / 27 crs | 81 (24 core) | image (front/back) | — | _TODO_ | seen |
| `quote/b` | 25 blk / 12 crs | 66 (24 core) | image (bg, avatar) | — | _TODO_ | seen |
| `quote/c` | 18 blk / 10 crs | 68 (23 core) | image (bg, avatar) | — | _TODO_ | seen |
| `chart/pie` | 16 blk / 11 crs | 43 (19 core) | — (data) | — | _TODO_ | seen |
| `quote/background` | 16 blk / 8 crs | 88 (21 core) | image (bg, avatar) | — | _TODO_ | seen |
| `chart/bar` | 5 blk / 4 crs | 35 (21 core) | — (data) | — | _TODO_ | seen |
| `knowledge/knowledge` | 5 blk / 1 crs | 28 (28 core) | image | — | _TODO_ | seen |
| `knowledgeCheck/fillin` | 4 blk / 4 crs | 55 (16 core) | — | — | _TODO_ | seen |
| `chart/line` | 3 blk / 3 crs | 40 (22 core) | — (data) | — | _TODO_ | seen |

## Question types (inline quiz / knowledge-check blocks)

Counts from the 581-course library scan.

| type | Answer shape | Count | Status |
|---|---|---|---|
| `MULTIPLE_CHOICE` | answers carry `correct` flag | 291 | documented |
| `MULTIPLE_RESPONSE` | answers carry `correct` flag | 209 | documented |
| `MATCHING` | `answers:[{id,title,matchTitle}]` | 67 | documented |
| `FILL_IN_THE_BLANK` | text answer(s); blanks in `title` | 6 | seen |

> The earlier `FILL_IN_BLANK` was a guess — the real type string is
> **`FILL_IN_THE_BLANK`**.

## Lesson types

Counts from the 581-course library scan. Beyond the three core types, a handful
of lessons report a block-like `type` (a single fullscreen interaction filling
the lesson) — kept here for completeness; copy-faithful handles them.

| type | Meaning | Count | Status |
|---|---|---|---|
| `blocks` | Normal content lesson | 559 | documented |
| `section` | Module header (no content) | 225 | documented |
| `quiz` | Graded quiz lesson (`{type:"quiz", icon:"Quiz"}`) | 156 | documented |
| `embed` / `map` / `process` / `timeline` / `video` | Single-interaction lessons | 1 each | seen |

## Library census (581 courses, 2026-06-19)

- **65 distinct `family/variant`**, all documented above; full per-variant field
  profiles in `core/census/catalog.fields.json` (5,435 field-paths).
- **Reference distribution:** `media-image` 56,026 · `cdn` 11,061 ·
  `media-storyline` 1,021 · `media-audio` 714 · `media-video` 713 ·
  `storyline-crossref` 450 · `embed` 209 · `media-other` 135 ·
  `draw-from-bank-crossref` 29.
- **Version signal — Rise DOES expose one.** `course.version` carries values like
  `3.100.34725.0`, `3.101.34961.0`, `3.102.35072.0` (Rise build/schema), plus
  legacy `0`/`1` on older courses. Use it for Tier-2 version-difference hints
  (PRD §8 / §15 resolved: a per-course version id exists).

## Pending capture (expected, not individually confirmed)

These are known Rise block types not yet captured in our traffic. Copy-faithful handles them on sight, but each should be promoted to `documented` once a real example is scanned: `statement`, `quote`, `tabs`, `scenario`, `timeline`, `chart`, `table`, `attachment`, `audio` (and any others surfaced by novelty review). (`gallery` and `accordion` were captured in the 2026-06-19 scrape — see Confirmed.)

> **Field profiles.** A scrape writes `catalog.json`/`catalog.csv` — per-variant field profiles (each field tagged **core**/**optional** with presence %). That is the scalable knowledge base this table summarizes; `novelty.csv` surfaces only **new variants** and (once a variant has a recorded field baseline) **new fields**.

## Review queue (auto-captured, awaiting classification)

_Tool appends here: shape signature, classification hypotheses (new block / version diff / code fault), example courseId + path, raw snippet. Operator classifies → entry moves up + catalog updates._
