# Rise Migration

Internal Chrome MV3 extension for loss-conscious Articulate Rise migration,
document export, and local course-package creation.

## Main actions

The side-panel home is four cards (v0.9.0):

- **Rise to Docx** — generate either a flowing prose DOCX or a structured
  storyboard DOCX from a course. Three sources: **From archive** (a course in
  the connected folder), **From account** (paced live search of the logged-in
  account, 16/page), and **Current tab** (the course open in the active Rise
  editor tab). Live sources are transient: one paced GET_COURSE at generate
  time, prose images downloaded in-memory from the public CDN, nothing written
  to the archive.
- **Rise AI Creator** — a local-only two-page flow that turns pasted Course
  Blueprint JSON into a ready-to-import package. An external AI chat interprets
  the source document; Creator never reads it. Only the programmatic AI-provider
  API mode is deferred.
- **Export Data** — save courses, question banks, folders, account data,
  fonts, assets, and Storyline packages to a local folder. Legacy Storyline
  packages are preserved to `storyline-legacy/` and never uploaded. Listing
  courses is a pure search; the course inventory is written only by the
  explicit **Save visible course list (inventory)** button in step C.
- **Import Data** — validate a local archive, dry-run, then recreate it in a
  confirmed target account with sequential paced writes and live read-back.

Creator never contacts Rise. It writes files to the operator-selected folder;
the side-panel importer is the only path that creates courses in Rise.

## Local archive

New exports and Creator builds use `rise-local-archive` format version 1:

```text
<folder>/
  manifest.json
  courses/<courseId>.json
  courses/<courseId>.assets.json     # when assets were exported
  assets/<sha256>.<extension>
  question-banks/                    # Rise exports when present
  account/                           # Rise exports when present
  storyline/                         # Rise exports when present
  storyline-legacy/                  # quarantined legacy Storyline zips, never uploaded
  _metadata/                         # export reports
  _creator/                          # blueprint/build artifacts
  _import/                           # import reports and resume state
```

The manifest records building/ready state, file locations, and export-time
SHA-256 provenance. Import readiness checks file presence, not historical byte
identity: operators may intentionally replace local assets. Before network work,
the selected courses are parsed and their media references must be covered by
present files or recorded source-side failures. Existing legacy archives remain
readable with a visible warning and are never upgraded merely by reading them.

For Rise exports, fetching courses leaves the archive in `building` state;
**Download assets** promotes it to `ready` after the byte set is complete.

## Rise-format rules

- Exported Rise JSON remains copy-faithful and raw course files are immutable.
- Rise API envelopes and synthesized block shapes come from captures/donors,
  never memory or guesses.
- Creator has no source parsers: the neutral Course Blueprint arrives as
  pasted JSON and passes strict closed-schema validation. A deterministic,
  registry-backed compiler is the only code that emits synthesized Rise JSON.
- Typed local asset references must be eliminated before import and are checked
  again after live GET_COURSE read-back.
- Live writes are sequential, human-paced, pinned to one target tab/account/
  plane, and never auto-delete a failed target course.

See [v0.8.0 rebuild plan](docs/v0.8.0-rebuild-plan.md),
[AI Creator design](docs/creator-ai-design.md), and
[Rise import protocol](docs/rise-import-protocol.md).

## Operator workflow

### Export and migrate

1. Open and log into the source Rise account.
2. Open the extension side panel and choose a local folder.
3. Export account data, banks, courses, assets, and required Storyline packages.
4. Open/log into the target account.
5. Choose **Import Data**, inspect archive status, confirm the target, and
   dry-run the required steps.
6. Run account settings, question banks, and courses in order.
7. Review the saved fidelity/read-back reports under `_import/`.

### Create locally and import

1. Prepare an empty or dedicated Creator output folder.
2. Open Rise AI Creator, copy the prompt pack into an external AI chat together
   with the source deck, then paste the returned Course Blueprint JSON (or pick
   a `.json` file) and validate.
3. **Review blueprint →** opens the review page in a new tab: stats, source
   references, unresolved items (gated behind an acknowledgement checkbox),
   placeholders, and registry warnings.
4. Approve the build. Creator writes one course plus `manifest.json` and
   `_creator/` artifacts.
5. Point the side panel at that folder and import via the normal course workflow.

An interrupted Creator write leaves `_creator/build.lock`; the next build warns
but does not block.

The Creator/review pages keep their **own** folder handle (with a one-click
"Use panel folder" seed) and never silently re-point the side panel's archive.
A build **merges** into an existing creator-origin manifest — successive builds
accumulate in `courses[]`, a same-id rebuild refreshes its entry — and
**refuses**, before writing anything, a folder holding a rise-export or
legacy/unknown manifest: a Creator manifest would replace it and hide those
courses from Import. Use an empty folder or a dedicated Creator folder.

## Development

```bash
pnpm install
pnpm compile
pnpm test
pnpm build
```

Load `.output/chrome-mv3` as an unpacked extension in Chrome. The test suite is
local, but full release certification also requires the named US/EU live matrix
in `docs/v0.8.0-rebuild-plan.md`.

## Project map

| Area | Role |
| --- | --- |
| `entrypoints/sidepanel/` | Four-card home UI, export/import orchestration, local folder handling |
| `entrypoints/creator/` | Rise AI Creator entry page: prompt pack, paste/validate, review handoff |
| `entrypoints/review/` | Blueprint review page: re-validate, preview, acknowledge, approve/write |
| `entrypoints/background/` | Service-worker relay (rise-fetch, tabs, reauth, storyline handlers) |
| `core/local-archive/` | Versioned manifest builders, strict/legacy inspection, id-row merging |
| `core/creator/` | Course Blueprint validation, prompt pack, and deterministic compiler |
| `core/rise-format/` | Donor provenance and template verification registry |
| `core/import/` | Proven plan/executor, remapping, pacing inputs, fidelity/read-back logic |
| `core/storyboard/` | Rise→docx rendering (SBDOC + prose) and the Creator compiler's donor mapper (`map.ts`); `docx.ts`/`xml.ts` remain as the SBDOC writer's round-trip test oracle |
| `docs/` | Capture-backed protocol, findings, status, and release plans |
