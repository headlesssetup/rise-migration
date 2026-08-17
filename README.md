# Rise Migration

Internal Chrome MV3 extension for loss-conscious Articulate Rise migration,
document export, and local course-package creation.

## Main actions

- **Export from Rise** — save courses, question banks, folders, account data,
  fonts, assets, and Storyline packages to a local folder.
- **Import into Rise** — validate a local archive, dry-run, then recreate it in a
  confirmed target account with sequential paced writes and live read-back.
- **Save course to document** — generate either a flowing prose DOCX or a
  structured storyboard DOCX from an exported course.
- **Launch Rise Creator** — open a local-only page that reviews a source document
  and writes a ready-to-import package. v0.8.0 exposes the deterministic INTEA
  storyboard converter; the generic AI pipeline is deferred.

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
- Creator/source parsers produce a neutral Course Blueprint. A deterministic,
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
5. Choose **Import into Rise**, inspect archive status, confirm the target, and
   dry-run the required steps.
6. Run account settings, question banks, and courses in order.
7. Review the saved fidelity/read-back reports under `_import/`.

### Create locally and import

1. Prepare an empty output folder (operator responsibility).
2. Launch Rise Creator and choose one supported source file.
3. Review the course proposal, source references, unresolved rows, placeholders,
   and registry warnings.
4. Approve the build. Creator writes one course plus `manifest.json` and
   `_creator/` artifacts.
5. Point the side panel at that folder and import via the normal course workflow.

An interrupted Creator write leaves `_creator/build.lock`; the next build warns
but does not block.

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
| `entrypoints/sidepanel/` | Four-mode UI, export/import orchestration, local folder handling |
| `entrypoints/storyboard/` | Rise Creator extension page (legacy internal entrypoint name) |
| `core/local-archive/` | Versioned manifest builders and strict/legacy inspection |
| `core/creator/` | Course Blueprint and deterministic compiler |
| `core/rise-format/` | Donor provenance and template verification registry |
| `core/import/` | Proven plan/executor, remapping, pacing inputs, fidelity/read-back logic |
| `core/storyboard/` | INTEA DOCX parser/profile and DOCX rendering code |
| `docs/` | Capture-backed protocol, findings, status, and release plans |
