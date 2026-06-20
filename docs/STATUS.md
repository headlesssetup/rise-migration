# Project Status

_Last updated: 2026-06-19. Keep this current at each phase boundary._

The authoritative protocol is `docs/rise-api-reference.md`; invariants are in
`CLAUDE.md`. Block/question/folder schemas: `docs/rise-block-catalog.md`,
`docs/rise-question-banks.md`, `docs/rise-folders.md`.

## Where we are

**Phase 0 (read-only exploration) + 0.1 + Tier-2 novelty: DONE, merged to `master`** (PR #1).
A Chrome MV3 (WXT + React) side-panel extension that rides a logged-in Rise
session and, **strictly sequential + human-paced**, extracts:

- **Courses** — `GET /manage/api/content/search` (paged 16/page) → `GET_COURSE`
  ducks RPC; raw docs saved verbatim to `courses/<id>.json`.
- **Question banks** — `GET /api/rise-authoring/question_banks` (questions inline)
  → `question-banks/<id>.json`.
- **Folders** — `GET /manage/api/folders` (course) + bank folders inline.

API calls run **inside the live Rise tab** via `chrome.scripting.executeScript`
(first-party cookies; catalog is cookie-authed). Plane-agnostic (US + EU) via
relative URLs. Account identity from the header avatar.

**Outputs** (to a user-picked folder, persisted via IndexedDB). Layout: root
holds `manifest.json` + content dirs `courses/`, `question-banks/`, `assets/`;
raw account source in `account/` (`folders.json`, `block-templates.json`,
`typefaces.json`, `review-items.json`); all derived reports in `_metadata/`
(`inventory.*`, `census.*`, `catalog.*` (per-variant field profiles), `novelty.*`,
`folders-inventory.*`, `question-banks-catalog.*` (per-type schema) +
`question-banks-inventory.*` (per-bank decision table), `block-templates-inventory.*`,
`typefaces-inventory.*`, `review-items-inventory.*`, `assets-summary.json`).
(Older runs wrote these at root; stale root files are harmless — delete them.)
The account exports + their endpoint map are documented in `docs/rise-account-exports.md`.

**Tier-1 loud-fail gating and the novelty accept-UI are intentionally deferred** —
catalog curation is done **by hand** (send a run's `catalog.json`; we regenerate
`core/census/catalog.fields.json`). This works well; no automation needed.

**Phase 2 (asset extraction + account exports): DONE** — see below. The export
side is complete: courses + banks + folders + uploaded media + **account extras**
(block templates, custom typefaces incl. font files, Review-360 items inventory)
all captured into a self-sufficient archive. **Mighty** content is treated as
Storyline (reference only): the review-items inventory flags `mighty` bundles
(empty Review packages); bundle bytes are intentionally not grabbed yet.

Stats: 101 Vitest tests; `corepack pnpm test` / `compile` / `build` all green.
Phase 0 validated against a live 579-course account + mitm captures.

## Known schema (captured)

- **Blocks:** 65 `family/variant` documented with full field profiles
  (`catalog.fields.json`, 5,435 paths). Media split image/video/audio/storyline.
- **Questions:** MC / MR / MATCHING / FILL_IN_THE_BLANK; full schema incl. the
  feedback model (`feedback_type` = ANY | CORRECT_INCORRECT | CHOICE) — see
  `rise-question-banks.md`.
- **Version signal:** Rise exposes `course.version` (e.g. `3.100.34725.0`).
- **Media:** course keys `rise/courses/{id}/…` (camelCase); bank keys
  `rise/questionBanks/{id}/…` (snake_case). CDN (`cdn.articulate.com`) + embeds
  kept as references.

## Phase 2 — asset extraction (finish the export side): DONE

The archive is now self-sufficient for import: uploaded binaries are downloaded
from the public CDN and stored content-addressed.

- `core/assets/keys.ts` — reuses `scanRefs` (untruncated) to enumerate media
  occurrences, then `extractUploadedKeys` pulls clean keys out of each value.
  A whole-value fast path takes a bare key / usercontent URL verbatim (incl.
  `(n)`, `%2520`, unicode); a bounded regex handles keys embedded in HTML.
  `collectAssetKeys` keeps `media-image/video/audio/other`, deduped by key.
- `core/assets/download.ts` — `downloadAssetsFor` runs a bounded parallel pool
  (`runPool`, default 4), hashes bytes (`sha256Hex`), writes each blob once via
  an injected `AssetSink`, and builds the manifest. `keyPathCandidates` yields
  verbatim → single-encoded (fixes `%2520`) → NFC (fixes NFD unicode) URL forms.
  `priorAssets` lets a re-run reuse downloaded keys without re-fetching (resume).
- `core/assets/manifest.ts` — per-owner `AssetManifest` + `findUndownloadedKeys`
  (assertion: every collected key resolves to a stored asset) + `isOrphanStatus`
  (403/404 ⇒ missing at source). `core/assets/locate.ts` resolves a key's JSON
  path → `lessonTitle / family/variant / blockId` so a missing asset is findable.
- Panel: `orchestrator/assets.ts` (`cdnDownload` tries the encoding variants +
  retries transient 429/5xx; `downloadAllAssets` resumes incomplete owners and
  splits failures into `orphaned` (403/404 — missing at source, tagged with
  course title + location) vs retryable) + the "Assets (Phase 2)" card.

**Resume:** re-running "Download assets" skips owners whose manifest is already
complete, reuses successful keys for incomplete ones, and retries only the
failures — so a re-run is cheap and self-healing. (An early full-library run hit
1,498 failures from a `)`-truncation + double-encoding bug, since fixed; the
~500 residual were all **403/AccessDenied = deleted at source** — S3 returns 403
for absent keys on a bucket without public `ListBucket` — now classified as
`orphaned`, not failures.)

**Archive layout (new):**
- `assets/<sha256>.<ext>` — content-addressed media bytes, deduped across the run.
- `courses/<id>.assets.json` / `question-banks/<id>.assets.json` — per-owner
  manifest mapping keys → `{hash, ext, file, size}` (sha256 = checksum).
- `assets-summary.json` — run-wide totals (written/deduped/failed) + the
  un-downloaded-key assertion result.

**Locked decisions (as built):** content-addressed dedup; parallel pool (~4), no
human-pacing (CDN is public-read, outside the authoring-API pacing invariant);
Storyline bundles, `cdn.articulate.com`, and YouTube/Vimeo embeds kept as
references (not downloaded). Downloads run panel-side (extension page +
`articulateusercontent.com` host permission), so no Rise tab / background relay
is needed. Owners with an existing `*.assets.json` are resume-skipped (delete to
force re-download).

Stats: 75 Vitest tests; `corepack pnpm test` / `compile` / `build` all green.

## Then: Phase 3 — import / recreation (the write side)

Recreate folders (deepest-first, map old→new id) → question banks → courses
(shell → theme → lessons → `CREATE_BLOCKS`, copy-faithful, client-gen ids) →
assets (`GET_YURL` → S3 PUT → `CRUSH`/`TRANSCODE` → remap keys) → cross-refs
(draw-from-bank → new bank id; Storyline → match Review 360). Verify parity +
checksums → fidelity report.

## Open unknowns / risks (tackle early in Phase 3)

- **EU-plane hosts** — EU Rise domain, EU S3 bucket, EU usercontent domain, EU
  auth are uncaptured (PRD §15). Confirm before building import.
- **Write envelopes uncaptured** — `CREATE_BLOCKS`, question-bank `PUT`
  (`session`/`lock_data`/`update_type` + the lock call), folder create, asset
  upload chain. Need a real mitm capture of each before Phase 3.
- **Storyline reachability** — only recreatable if the target can reach the same
  Review 360 item; otherwise flag for manual handling.
- **Orphaned media** — some courses reference media keys that are 403/deleted at
  source (`assets-summary.json → orphaned`). They can't be re-uploaded; import
  must read the asset manifest and flag/skip the referencing block (with the
  recorded location) rather than ship a dead key.
- **Folder team/subscription scoping** (`ownerPrincipalId`, `subscriptionId`,
  shared vs private) may not map 1:1 across accounts.

## Run / verify

`corepack pnpm install` (pnpm 11; settings in `pnpm-workspace.yaml`) →
`pnpm test` / `pnpm compile` / `pnpm build` → load `.output/chrome-mv3` unpacked.
Keep a logged-in `rise.articulate.com` (or EU) tab open; the panel rides it.
