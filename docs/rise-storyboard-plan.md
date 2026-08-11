# Storyboard → Rise: build plan

> **STATUS (2026-08-10): phases 1–4 BUILT** (`core/storyboard/` + review tab
> `entrypoints/storyboard/` + panel button; 686 tests green, extension builds).
> Verified against the real VAS SD: **44 of 45 rows parse** into 73 blocks
> across 7 lessons; the one unparsed row (slide 7) genuinely carries no items
> in the SD (content expected from the preceding video) — honest demotion.
> Run it: side panel → **Storyboard ↗** → pick the .docx → review → approve;
> the course then appears in Import → C. Re-run the real-file check any time:
> `SD_DOCX=/path/to/SD.docx pnpm vitest run core/storyboard/real-docx`.
> **Phase 5 (pilot import into a test account) is NOT done** — the empty-video
> donor shape remains the one unverified block (pilot eyeballs it).
> **Donor round 2 (2026-08-10, operator's "Quick Test" export):** Note now maps
> to the real `impact/note` (impact/b fallback gone), and link/resource rows
> (slides 5, 17) map to real `buttons/button stack` blocks — the SD writes each
> button as `[label]` with the hyperlink inside the brackets; a bracketed line
> WITH a link is a button, without one it stays navigation.
>
> Conventions learned from the real file during the build (now in the parser):
> - **Bold `[…]` paragraphs are clickable ITEMS** (accordion panels / tabs /
>   cards); only NON-bold `[…]` paragraphs are buttons/navigation.
> - A timeline bracket without a `date:` colon is a button, not an event.
> - Sorting cells keep italics (piles/cards are italic by SD habit); the
>   standalone italic remark above them is still dropped as a designer note.
> - **HIDDEN (`w:vanish`) text renders nowhere and consumes NO list number** —
>   the VAS SD's first slide cell holds a hidden numbered paragraph; counting
>   it shifted every slide number by +1 (operator caught it: Note is slide 29,
>   not 30). Hidden paragraphs/runs are now skipped everywhere.

**Goal:** convert an INTEA scenario document (SD `.docx`) into an editable Rise
course, reusing the migration import pipeline unchanged. First target: the VAS
M1 chapter-1 SD (`260803_2180_VAS_…_M1_1-nodala_SD_v1.docx`), text-only, Latvian.

**Architecture decision (agreed 2026-08-10):** the converter is a third mode in
the SAME extension whose output is a **synthetic source archive** (`course.json`
+ `manifest.json`, empty `assets/`) in the exact layout the exporter produces.
The existing import phase then runs on it verbatim — creation handshake, paced
writes, `freshClientIds`, flags, read-back, reports. No forked build path.
Parse + review need no auth; only the build step touches Rise.

## SD format spec (from the VAS sample; conventions are page-1 of every SD)

- One `Heading1` = the chapter; single-cell table rows (`Tēma x.y.z`) = lessons.
- Content table columns: `Slaida nr. | Mācību pieredze | Audio teksts | Teksts uz ekrāna | Komentāri`.
- **`Slaida nr.` is Word AUTO-numbering** (empty paragraphs, `numId=4`,
  decimal, one continuous 1–46 sequence, no restarts): the parser computes the
  rendered number by counting `numId=4` paragraphs in document order — never
  by table-row index (the sample's first content row holds TWO numbered
  paragraphs, so rows and slide numbers diverge from slide 2 on). All
  operator/client-facing references (placeholders, production report,
  `unparsed[]`) cite this rendered slide number.
- `Mācību pieredze` names the Rise block ("Accordion", "Tabs", "Timeline",
  "Process", "Flipcards", "Labeled Graphic", "Note", "Knowledge check",
  "sorting activity", "Rise Mighty", "Storyline quiz?") → deterministic lookup.
- In `Teksts uz ekrāna`: **bold** paragraphs delimit items/questions; list
  paragraphs are answer options; **green `00B050` = correct answer** —
  OFFICIAL convention (client-confirmed 2026-08-10; capture-verified: exactly
  one per question in the sample KC); *italics* (e.g. `Atgriezeniskā saite:`)
  are designer notes / feedback, never screen text; `[BRACKETS]` are
  buttons/clickables. Blue `0070C0` occurs ONLY inside `Audio teksts` (row 43's
  animation script — term emphasis for the animators), never in screen text:
  irrelevant to conversion.
- `Audio teksts` = filming script for experts, NEVER course content → goes to a
  per-lesson production report (expert name + duration from `Mācību pieredze`).
- Word fragments runs arbitrarily (spell-check/rsid splits) — the parser must
  coalesce adjacent identically-formatted runs before applying conventions.

## Phases

**0. Decisions (all resolved with operator, 2026-08-10).**
1. Blue `0070C0`: production-side emphasis inside one video script; not a
   screen-text convention. Parser ignores color outside `Teksts uz ekrāna`.
2. Green-marks-correct is OFFICIAL spec across all SDs.
3. Storyline/Mighty rows (13, 39, 51): auto-insert a flagged TEXT placeholder
   block — "Aizvietot ar Storyline/Mighty aktivitāti — skat. slaidu nr. {n}" —
   citing the rendered `Slaida nr.` (see spec above); full source text goes to
   the production report. No native-KC substitution.
4. Course granularity: WHOLE DOC = ONE course (title from `Heading1`); every
   single-cell divider row (`Par šo e-mācību kursu`, each `Tēma x.y.z`) = one
   lesson. Append-to-existing-course stays out of scope.
5. Video rows: insert Rise's normal EMPTY `multimedia/video` block (native
   placeholder by design) — donor shape to be confirmed at build time (mine
   from scrapes or capture one hand-made empty block; verify it survives
   `CREATE_BLOCKS`). Labeled Graphic (text-only): map to flashcard/flipcards
   for now — client may change this in the next SD version, so the mapping is
   a per-format-version table entry, not hardcoded.

**1. Parser — `core/storyboard/` (pure, no auth, Vitest).**
Unzip docx (existing inflate util) → parse `word/document.xml` → coalesce runs
→ apply the conventions engine → group rows into chapter/lessons → emit
`PlannedCourse` JSON: typed block intents with per-row provenance (row index +
raw cell text) and an explicit `unparsed[]` list. **Nothing unclassified passes
silently** — same posture as novelty review. Fixture: the VAS docx (client
content — keep the fixture out of the public repo if that ever matters; extract
minimal synthetic fixtures for unit tests).

**2. Block mapper — `PlannedCourse` → synthetic archive.**
Donor payload templates mined from the catalog field profiles (`catalog.json`)
/ archived scraped courses for: paragraph/heading/list text, accordion, tabs,
flashcard, timeline, process, sorting, note, multiple choice/response,
matching, buttons/links, dividers. Client ids minted cuid-style (import re-mints
anyway via `freshClientIds`). Validation: run the existing generic media-key /
cross-ref scan over the output and assert BOTH are empty (text-only guarantee),
plus schema-shape checks against the catalog profiles.

**3. Review UI — full extension TAB (not the side panel).**
Lesson tree + block cards color-coded auto / placeholder / unparsed, source
cell text beside each block. Approve → write the synthetic archive into the
archive folder + the production report (audio scripts) + the review artifact
(doubles as client sign-off). The preview is the ONLY gate to import.

**4. Wire-up — side-panel "Create from storyboard" mode.**
Pick docx → parse → open review tab → on approval the archive appears in the
normal import list. Import itself: zero changes expected; run report lists
placeholders needing hand-authoring (videos, Mighty).

**5. Pilot.** This SD into a test course on the EU account; operator eyeballs
every block type in the Rise editor; client validates against the storyboard.
Novelty/round-trip machinery stays active on the write path throughout.

## Non-goals (v1)

Images/media upload (this case is text-only); Mighty/Storyline authoring
(placeholders by design); append-to-existing-course (see Q4); non-INTEA
storyboard formats (the parser is format-versioned; a second format is a new
conventions profile, not a rewrite); l10n/stacks.

## Risks

- **SD drift between authors/clients** — conventions engine is versioned;
  anything off-spec lands in `unparsed[]`, loudly, never guessed.
- **Donor template fidelity** — blocks of these families already imported
  successfully during migration (copy-faithful), so the schema shapes are
  proven; the new risk is only in text we synthesize INTO them, covered by the
  catalog field-profile checks + the pilot eyeball pass.
- **Quiz answer marking absent in a future SD** — parser demotes that KC to
  `unparsed` (operator decides), never guesses a correct answer.

Relative sizes: parser ≈ mapper > review UI ≫ wire-up ≈ 0 (import unchanged).
