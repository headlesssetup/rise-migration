# Project Status

_Last updated: 2026-06-20 (Phase 3 import core landed on a branch). Keep this current at each phase boundary._

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

The full export side (Phases 0/0.1/2 incl. account extras) is **merged to
`master`** (PRs #1–#3); extension version `0.2.4`.

## Phase 3 — import / recreation (the write side): IN PROGRESS (branch)

Rebuild an exported archive into a *different* Rise account (US → EU). **First
PR landed on a feature branch** (not yet merged). What's built:

**Decisions settled at kickoff:** packaging = **one extension, two modes**
(Export read-only / Import write) — not two build targets; first target =
**US→US** (captured hosts; EU overrides later); the import core is wired to the
**live write path** (unverifiable here without a live Rise account, but ready for
a live run).

**`docs/rise-import-protocol.md` (NEW, authoritative):** the write SEQUENCE,
lock/session semantics, and id remapping reverse-engineered from the US
`http_api.jsonl` capture. Documents `CREATE_LESSON`/`UPDATE_LESSON` + locks,
`CREATE_BLOCKS` (copy-faithful), question banks `POST`→`PUT` +
`INSERT_QUESTION_BANK_QUESTIONS` (the draw-from-bank link — a **new** envelope),
`UPDATE_COURSE`/theme round-trip, the asset chain (`GET_YURL`→S3 `PUT`→
`CRUSH_IMAGE`/`TRANSCODE_ASSET`→`UPDATE_COURSE {jobs}`→`CHECK_STATUS`→
`UPDATE_BLOCK_DEBOUNCE`), folders, Storyline/Mighty (conditional), safe-import
gates, and loud-fail assertions. (`INSERT_BLOCK_TEMPLATE` + the storyline
`unzip` S3 PUT are documented as **out of scope** — copy-faithful recreates the
blocks directly.)

**`core/import/` (pure, fully unit-tested — 46 new tests):**
- `ids.ts` — cuid-style client-id factory + `IdMap` (old→new, JSON-serializable
  resumable job log).
- `remap.ts` — generic copy-faithful transform: regenerate client ids
  consistently, rewrite id-bearing refs (`correct`/`corrects`/`refs`/`uploadId`),
  strip server-owned fields, blank/remap uploaded media keys, and the
  `findSurvivingSourceKeys` invariant scan.
- `envelopes.ts` — typed `WriteSpec` builders for every captured write.
- `plan.ts` — deterministic ordered plan (banks → course → theme → lessons →
  blocks → uploads → cross-refs) feeding both the dry-run preview and the
  executor; flags storyline/orphan media for manual handling.
- `executor.ts` — walks the plan, relays envelopes (injectable), **loud-fails**
  on unexpected responses, records server ids, paces, polls transcode jobs;
  DRY-RUN collects envelopes without sending. Final assertion: no source media
  key survives.
- `guards.ts` — Source ≠ Target identity gate + plane detection.
- `fidelity.ts` — plan-based parity/flags/surviving-key report (JSON + markdown).
- `verify.ts` (**Phase 4 read-back parity**) — canonicalize source + a read-back
  `GET_COURSE` of the new course (tokenize ids/media keys, drop server/derived
  fields, normalize HTML) and structurally diff them. The *true* round-trip check:
  reports per-block missing/extra/type-changed/content-changed/media-missing,
  classifying flagged (storyline/orphan/unsupported-media) + draw-from-bank
  divergences as **expected**. Wired into the live import (paced read-back after a
  successful course) → `_import/<id>.parity.md` + a parity column in the panel.

**Wiring:** `background` gained a `RELAY_WRITE` handler + binary/PUT/noAuth
support (S3 upload rides the tab, same cross-origin PUT the editor issues);
`storage` gained `readManifest`/`readAsset` + `_import/` artifacts (kept out of
the read-only archive); `orchestrator/import.ts` reads a course + asset manifest
+ referenced banks, runs the plan dry/live, resumes from a job log; the export
manifest now records `sourceAccount` for the guard; `ImportView` provides the
write-mode banner, target gate, Source≠Target guard (+ override), dry-run
preview, and gated live import.

**Recently added (completeness branch):**
- **Lesson header / lesson media upload** — header images are now uploaded
  (GET_YURL → S3 PUT) and remapped into `UPDATE_LESSON {headerImage}` instead of
  being blanked + flagged. Same dedup / no-surviving-key guarantees as block media.
  ⚠ Capture-verify the `UPDATE_LESSON {headerImage}` write shape on a live run.
- **Dry-run oversize prediction** — the 64MB relay-cap overflow is now PREDICTED in
  the plan from the asset manifest `size`, so a dry-run flags oversized media (it no
  longer surfaced only at live time). The executor keeps a runtime backstop.
- **Per-flag log lines** — storyline / draw-from-bank / orphan / unsupported-media
  flags now each log a `[i/N] ⚠ FLAG …` line, so the step counter is contiguous
  (no more silent gaps).

**TODO (open):**
- ⏳ **Confirm video thumbnails/posters round-trip.** A multimedia/video block's
  `poster`/`thumbnail` are `images[.eu].articulate.com` transform URLs wrapping a
  `rise/courses/{id}/{poster}.jpg` key (protocol §8). Verify the poster image is
  uploaded + the thumbnail/poster renders on the target after import (the transform
  URL host/key must resolve on the target plane). Not yet verified on a live run.

**Still TODO in Phase 3:**
- **Folder recreation** — the folder-create endpoint/payload is **not** in the
  capture; the importer currently places content at the account root and flags
  folder structure as not-yet-mapped (protocol §5). Confirm `POST /manage/api/folders`
  on a live target.
- **draw-from-bank source field names** — the capture *creates* the binding, so
  the exact source-block fields (`questionBankId`/`drawCount`/`questionDrawType`)
  aren't confirmed against a GET_COURSE block; `findBankRef` probes likely names
  and the executor loud-fails if a bank id can't be resolved (protocol §4b).
- **Live verification** — nothing here has been run against a live Rise account;
  the executor is exercised only via mock-relay unit tests. Needs a real US→US
  dry-run then live run, then an EU write capture for EU specifics.
- **`UPDATE_COURSE_FIELD` (title)** + **`RESOLVE_ASSET`** payloads are best-guess
  (flagged in `envelopes.ts`) — confirm on a live run.

## Open unknowns / risks (Phase 3)

- **EU-plane hosts — CAPTURED & VALIDATED** (`2390d5ff-capture.mitm`). EU map:
  `rise.eu.articulate.com`, `api.eu.articulate.com`, S3
  `360-prod-eu-central-1-…s3.eu-central-1` (SigV4), usercontent
  **`articulateusercontent.eu`** (`.eu` TLD), CDN `cdn.eu.articulate.com`, auth
  stays global `id.articulate.com`. Every EU authoring envelope is **identical to
  US**; the successful EU S3 PUT sent only `Content-Type` (no `x-amz-acl` header),
  so our upload path works on EU unchanged. The importer is genuinely plane-
  agnostic (relative URLs + GET_YURL-returned host). The capture also fixed the
  **title** envelope (`UPDATE_COURSE_FIELD_THROTTLE` `{course:{id,title}}`). The
  EU **export downloader** is now plane-aware (`makeCdnDownloader`/
  `cdnBasesForPlane`): a known plane hits exactly one usercontent host
  (`articulateusercontent.com`/`.eu`), an unknown plane tries both;
  `articulateusercontent.eu` added to host_permissions.
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
