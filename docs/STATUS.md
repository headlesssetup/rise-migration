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

**Outputs** (to a user-picked folder, persisted via IndexedDB):
`inventory.*`, `folders.json` + `folders-inventory.*`, `census.*`,
`catalog.*` (per-variant field profiles), `novelty.*` (new variants/fields vs
catalog), `question-banks/*` + `question-banks-catalog.*`, `manifest.json`.

**Tier-1 loud-fail gating and the novelty accept-UI are intentionally deferred** —
catalog curation is done **by hand** (send a run's `catalog.json`; we regenerate
`core/census/catalog.fields.json`). This works well; no automation needed.

Stats: 54 Vitest tests; `corepack pnpm test` / `compile` / `build` all green.
Validated against a live 579-course account + mitm captures.

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

## Next: Phase 2 — asset extraction (finish the export side)

Goal: download the uploaded binaries so an archive is self-sufficient for import.

- From the census, collect **distinct uploaded-media keys** per course + per bank
  (`media-image/video/audio/other`). Download from
  `https://articulateusercontent.com/{key}` (public-read).
- **Skip** (kept as references): `cdn.articulate.com`, YouTube/Vimeo embeds, and
  **Storyline bundles** (recreated via Review 360, not re-uploaded).
- Write an **asset manifest** per course/bank + verify **no uploaded key is left
  un-downloaded** (CLAUDE.md invariant).

**Locked decisions:**
1. **Layout — content-addressed + dedup.** Store bytes once at
   `assets/<sha256>.<ext>`; each course/bank gets an `assets-manifest.json`
   mapping its media keys → hash/size/checksum. (Mirrors import's upload-once.)
2. **Concurrency — parallel (~4), no human-pacing.** The 2s pacing invariant is
   scoped to the Rise **authoring API** (course fetch/pagination), not the public
   `articulateusercontent.com` CDN.
3. **Storyline — do not download** bundle bytes.

Implementation notes: add `https://articulateusercontent.com/*` to
`host_permissions`; add a binary write path to `FileSystemStorage`
(`createWritable().write(Blob)`); reuse the existing `scanRefs` to enumerate keys.

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
- **Folder team/subscription scoping** (`ownerPrincipalId`, `subscriptionId`,
  shared vs private) may not map 1:1 across accounts.

## Run / verify

`corepack pnpm install` (pnpm 11; settings in `pnpm-workspace.yaml`) →
`pnpm test` / `pnpm compile` / `pnpm build` → load `.output/chrome-mv3` unpacked.
Keep a logged-in `rise.articulate.com` (or EU) tab open; the panel rides it.
