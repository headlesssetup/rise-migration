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

## Question types (inline quiz / knowledge-check blocks)

| type | Answer shape | Notes | Status |
|---|---|---|---|
| `MATCHING` | `answers:[{id,title,matchTitle}]` | — | documented |
| `MULTIPLE_CHOICE` | answers carry `correct` flag | — | documented |
| `MULTIPLE_RESPONSE` | answers carry `correct` flag | — | seen |
| `FILL_IN_BLANK` | _TODO_ | — | seen |

## Lesson types

| type | Meaning | Status |
|---|---|---|
| `blocks` | Normal content lesson | documented |
| `section` | Module header (no content) | documented |
| `quiz` | Graded quiz lesson (`{type:"quiz", icon:"Quiz"}`) | documented |

## Pending capture (expected, not individually confirmed)

These are known Rise block types not yet captured in our traffic. Copy-faithful handles them on sight, but each should be promoted to `documented` once a real example is scanned: `statement`, `quote`, `tabs`, `scenario`, `timeline`, `chart`, `table`, `attachment`, `audio` (and any others surfaced by novelty review). (`gallery` and `accordion` were captured in the 2026-06-19 scrape — see Confirmed.)

> **Field profiles.** A scrape writes `catalog.json`/`catalog.csv` — per-variant field profiles (each field tagged **core**/**optional** with presence %). That is the scalable knowledge base this table summarizes; `novelty.csv` surfaces only **new variants** and (once a variant has a recorded field baseline) **new fields**.

## Review queue (auto-captured, awaiting classification)

_Tool appends here: shape signature, classification hypotheses (new block / version diff / code fault), example courseId + path, raw snippet. Operator classifies → entry moves up + catalog updates._
