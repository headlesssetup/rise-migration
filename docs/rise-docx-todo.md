# Rise → Docx (prose) — deferred content-coverage TODO

_Parked 2026-08-20 after the Marlink GDPR audit (v0.9.3 shipped course +
lesson descriptions, block-type highlighting, accordion indentation).
Return here after Marlink._

## 1. Media placeholders in prose (the big one)

The model puts media chips (`⟦media:video #hash⟧`) into `row.notes`, but the
prose writer never emits `notes` — so audio/video/attachment/storyline
references are INVISIBLE in a prose export. Wanted: a human placeholder
built from the media object, e.g. `video: intro.mp4` (+ `subtitles: intro.vtt`
when present). Every uploaded media object carries **`originalUrl` = the
original upload filename** ("01 baner (3).jpg", "mountains.jpg"), so this
needs no assets manifest.

- VERIFY FIRST: where subtitle/caption `.vtt` references live on
  `media.video` — needs one video-bearing course (Marlink GDPR has none).
- Unresolved images (no CDN bytes) should also fall back to a filename
  placeholder instead of vanishing.

## 2. Gallery / collage: only the primary image is embedded

`extractPrimaryImage` returns the FIRST image of a block; a gallery or
mondrian collage shows 1 of N. Embed all (or placeholder-list the rest by
filename via `originalUrl`).

## 3. Edit-renderer blocks drop media captions/altText

RO blocks pick up `caption`/`altText` via the generic extractor, but blocks
with edit renderers (accordion, tabs, process, flashcards…) emit only their
main fields — an image caption inside an accordion item is dropped.

## 4. Scenario blocks — probably near-empty in docx (VERIFY)

`interactive-fullscreen/scenario` has no edit renderer and the RO extractor
skips `settings` entirely; scenario dialogue is likely settings-resident.
Census: 267 blocks / 79 courses. Needs one archived scenario course to
confirm where the text lives, then a dedicated renderer.

## 5. RO extractor limits

- Allowlist keys only (`title, heading, paragraph, description, caption,
  altText, label, text, url, date, matchTitle, completeHint, author, name,
  quote`) — chart data labels / table cell text likely fall outside it.
- Capped at 12 paragraphs per block ("+N text fields omitted").

## 6. SBDOC (table format) parity

v0.9.3 added course/lesson descriptions to the PROSE writer only. The SBDOC
table writer ignores the new model fields — adding them there touches the
format contract (`docs/rise-storyboard-format.md`) and its round-trip parser.

## Explicitly out of scope (operator decision 2026-08-20)

- `continue` blocks' `completeHint` — label-set/course-settings territory,
  not SME content.
- Custom label sets (course UI strings) — not storyboard content.
