# Project Status

_Last updated: 2026-08-02 (v0.6.0 — multi-language stacks: export, inventory, full import). Keep this current at each phase boundary._

**Session handover (2026-08-02, multi-language):**
`docs/handover-2026-08-02-multilang.md` — what shipped, the ONE open decision
(the "N source changes detected" badge; nothing built, mirroring rejected, an AI
updates-run is the only remaining route pending a 1-minute operator test), the
gap list, and the leftover test-run state to clean up.

The authoritative protocol is `docs/rise-api-reference.md`; invariants are in
`CLAUDE.md`. Block/question/folder schemas: `docs/rise-block-catalog.md`,
`docs/rise-question-banks.md`, `docs/rise-folders.md`.

> **Reading note.** The per-phase sections below are a HISTORICAL record, written
> at each phase boundary and largely left as-is. Where a later phase or the audit
> changed a behavior they describe, this top section wins. Current: **v0.6.1**,
> **599 Vitest tests**, `compile` / `test` green.

## Phase 6 — Multi-language stacks (v0.6.0): BUILT, needs live verification

Protocol fully captured across three MITM sessions and documented in
`docs/rise-multilang.md`; primitives in `core/l10n/` (detector, materializer
with locale→default→any fallback, cell/batch machinery); stack branch in
`core/import/plan.ts` + `executor.ts`.

- **Export**: raw archives already carry the full `payload.l10n` overlay; the
  exporter now RE-FETCHES a course whose archive predates languages shown by
  the listing; census scans stacks materialized (no `*.l10nId` novelty noise);
  asset discovery covers table media (generic raw-doc walk); orphan locations
  format as `translations (ru) › …`; manifest records `toolVersion`.
- **Inventory**: `multi_language` column (locale codes, default first) straight
  from the search listing.
- **Import** (docs/rise-multilang.md §6): minimal placeholder course →
  `POST …/translations` per formality group (the AI "stack-shape factory" —
  the ONLY way locale rows exist; AI sees placeholder strings only) → paced
  await until every language `complete` → GET_COURSE learns the target's own
  course-level refs → content copy-faithful with SOURCE l10nIds verbatim
  (creates carry inline `translationChanges`, capture-proven) → table media
  uploaded + remapped inside cell values → batched `UPDATE_L10N_BATCH` writes,
  default locale FIRST (pending-flag rule) → custom per-language label sets
  (CREATE_LABEL_SET/UPDATE_LABELS/UPDATE_LOCALE, run-deduped) → junk-cell
  cleanup → clean title/description cells per language LAST. Preflight
  sanity-checks locale codes against `available-languages` (localization is
  free on every subscription — no plan gating). Read-back: unfiltered foreign-
  key scan + `verifyL10nParity` (cell-by-cell) + per-language pending counts;
  reports carry the standing **"never click Update translation"** warning.
- **"Ready to import?"**: rough pre-run estimate (paced envelopes × pacing +
  upload bytes + 90 s per stack) shown for any selection in step C.
- **Storyline in a stack — per-language, end-to-end (v0.6.1)**: a storyline
  block's package lives in the cell tables, so each language can carry its OWN
  bundle (capture2aug). Export (`findStorylineBlocks`) resolves the block's
  `{l10nId}` media ref through the tables and yields one ref per language,
  staging one zip per DISTINCT leaf (shared bundles staged once) with
  `locale`/`l10nId` in the storyline manifest. Import emits
  `attach-storyline-l10n` per language: `copy_review_item` (target block id) +
  the storyline cell write for that locale. The block is created copy-faithful
  with its ref and **never patched** — patching `items[0].media` would replace
  the ref and destroy every language's binding. Cells are never copied verbatim
  (the source `contentPrefix` is source-owned and storyline keys are exempt from
  the foreign-key invariant); languages with no staged package are flagged, and
  a block with no package in any language is flagged block-level.
- **Draw-from-bank in a stack** (capture2aug): banks are NOT localized — bank
  questions are plain strings, `INSERT_QUESTION_BANK_QUESTIONS` carries no
  `translationChanges`, and Rise mints fresh question cells when it materializes
  drawn questions into the course. Binding is therefore faithful with the
  existing code path; per-language edits to DRAWN questions in the source do not
  migrate (reported).
- **Stack export/publish is Localize-gated** (operator-confirmed 2026-08-02):
  `build/{id}/raw` returns **HTTP 500** for a stack on an account without an
  active Articulate Localization subscription (monolingual courses in the same
  account export fine). Since Stage D sources Storyline bundles from that web
  export, a stack's embeds can only be migrated from a subscribed account —
  otherwise those blocks import empty + flagged. Content/media/cells/label sets
  are unaffected.
- Other known gaps (rise-multilang.md §7): `TOGGLE_LOCALE_SELECTOR` payload
  (manual flag), glossaries out of scope, monolingual course-level label sets
  still unmigrated.

### Read-back coverage audit (v0.6.4)

Per-surface truth (CLOSED in v0.6.5, `core/import/readback.ts`): COURSES are
verified at three stages (creation handshake; post-conversion GET_COURSE on
stacks; end-of-course parity — blocks + course fields + media keys + l10n cells
+ pending counts), now PLUS typeface identity by FONT NAME (ids tokenize, names
must survive; downgraded to expected under a typeface flag), per-language
label-set bindings (target `l10n.locales[].labelSetId` vs the run's recreated
sets — fails the language read-back), and a HEAD probe of every attached
storyline bundle's `story.html` on usercontent. QUESTION BANKS are GET back
after the PUT and compared (title + canonicalized questions; a failure fails
that bank and keeps it out of the bound map, so draw-from-bank stays safely
unbound). FOLDERS are re-listed after creation and every mapping verified by
name (WARN-only — placement infrastructure). Still response-trusted: the
per-course folder move (best-effort, warned).
FIXED in the same pass: `verifyL10nParity` treated the deliberately-not-copied
(flagged) storyline cells as failures — a stack with an unattached storyline
would have gone `partial` on its language read-back despite the flag announcing
exactly that absence; those cells are now routed to `expected`.

### Course-field read-back (v0.6.4)

`verifyParity` now also diffs course-level fields against the server read-back:
title/description (catches a leftover `!importing:` marker), theme (typeface ids
tokenized), the four course image objects (catches a dropped cover — the exact
class of the v0.6.2 built-in-cover bug), `blockBackgroundImage`/
`overlayNavigationImage`, and the settings scalars. NEW KNOWN GAP made visible:
course settings (`sidebarMode`, `navigationMode`, `markComplete`, `allowSearch`,
`color`, `aiTutorConfig`…) are not migrated at all — non-default sources now
report honest `course-field-changed` divergences. The write to close it is small
and its envelope is captured (`UPDATE_COURSE_DEBOUNCE {id, settings:{…}}`,
capture1aug). Stack lesson labels in parity reports no longer print
`[object Object]`.

### Duplicate client ids across lessons — FIXED (v0.6.3)

Found by the first full stack import: block/item ids are client-generated and
Rise's own sample courses reuse `"1"`,`"2"`,`"3"` in every lesson (40 blocks /
14 distinct ids). We shipped them verbatim (`remapIds` only re-mints cuid-shaped
ids), so the server clobbered blocks across lessons: whole lessons' translation
cells vanished (100 of 170 on one course), read-back parity reported
`block-type-changed`, and per-block follow-ups were mis-keyed. Now
`freshClientIds` re-mints non-cuid ids positionally + per block, and the source
index / blockMeta / follow-up steps key on `lessonId+blockId`. **This was a
monolingual bug too** — any course with such ids lost blocks silently; the l10n
parity check is what finally made it visible.

### Built-in ("library") assets — copied + probed (v0.6.2)

Rise stock media (sample-course covers, theme covers, block defaults) is not
account media: nothing to re-upload, and it appears either as a host-relative
`assets/rise/…` key or an absolute `cdn|images[.eu].articulate.com/assets/…` url.
Fixed: a course image with no *uploadable* key was treated as "no image" and
silently dropped (sample-course covers were lost; on a stack it also produced a
spurious `l10n-ref` flag). Now copied verbatim, and — because plane parity of the
two libraries is UNVERIFIED (a region may lack an asset for licensing reasons) —
each distinct reference is HEAD-probed on the TARGET plane (deduped by resolved
url, cached run-wide, outside pacing). Absent/inconclusive → still shipped plus a
`builtin-asset` flag; no host is ever rewritten without a passing probe.
Residency note: US→EU keeps source-plane absolute urls (correct rendering beats an
unverified rewrite) — the flags make it visible. `core/import/builtin-assets.ts`.

### Roadmap → v0.7.0 (recorded, not designed)

- **Parallel course creation**: Articulate tolerates ~two concurrent editing
  sessions per account → two internally-sequential import pipelines could run
  side by side. Needs a scoped relaxation of the strictly-sequential invariant
  ("per-pipeline sequential, max 2 pipelines") + a re-entrant executor/
  orchestrator (separate locks, shared token heartbeat, per-course logs).

## Phase 5 — Storyline/Mighty end-to-end (Stage D): BUILT, needs live verification

**This supersedes the old "placeholders only / never touch Review 360" policy**
(CLAUDE.md is updated). Storyline + Mighty blocks now migrate for real:

- **Export-D** (`core/storyline/{detect,ws-export,ws-export-client,package-zip,repackage,md5}.ts`,
  `orchestrator/storyline.ts`) — detect storyline blocks → Rise **web export**
  over the plane's ws-distributor (`identify` → `build` → `package:success`
  carries the zip location) → download → extract each block's
  `content/assets/{leaf}/` subtree → convert `story.html` from web-export to
  Review-360 manual-upload form → stage a per-leaf zip + manifest.
- **Import-D** (`core/storyline/{review-protocol,review-socket-client}.ts`) —
  upload each staged zip to the **TARGET** Review 360 over socket.io
  (`items:create` → `yurl:get` presigned S3 PUT → `items:update` →
  `items:upload`) then poll `items:get` for `contentPrefix`; the executor
  attaches it with `copy_review_item` + a `media.storyline` patch. Items are only
  ever CREATED in the target; the source account's Review 360 is never written.
- Plane-aware throughout (a **null plane is a loud error**, never an EU default).
  A block whose bundle can't be obtained stays a copy-faithful **placeholder**.

**Known ceiling:** the upload rides the zip through a base64 `runtime.sendMessage`
hop, so a package over **48 MB** fails a loud pre-flight check
(`MAX_UPLOAD_ZIP_BYTES`, `orchestrator/storyline.ts`). Investigated and confirmed
fixable: the `yurl:get` URL is a plain presigned S3 PUT (`noAuth`, no cookies) and
the zip is immutable after `items:create` (the server signs against the md5 sent
before any bytes move), so the panel can PUT it directly like course assets do —
lifting the ceiling to the ~350 MB memory bound. Needs a begin/commit split of
`STORYLINE_UPLOAD` (SW holds the socket + returns the presigned URL, panel PUTs,
SW finishes update/upload/poll); `createdAt` must be threaded through, since
`items:create` and `items:update` require the identical value. See `TODO(H5)`.

**Follow-up (memory):** `unzipToMap` inflates EVERY entry of the web export
(the whole course's media) to use one leaf subtree. fflate's `unzipSync` `filter`
option would inflate only the wanted leaves + `runtime-data.js`; a side-effecting
filter can still record the full inventory for the mismatch diagnostic.

## Full-codebase audit (2026-07-31): findings fixed

Five parallel subsystem reviews (auth/background, import, export/census/assets,
storyline, side panel). Baseline was green but hid **five critical** defects. All
fixed on this branch, each with regression tests (344 → 468 tests). The ones that
change operator-visible behavior:

- **Writes could land in the SOURCE account.** The background re-resolved "the
  active Rise tab" per request, so focusing the source tab mid-import redirected
  authoring writes (both planes' tabs are open in a US→EU run; relayed URLs are
  relative). Now a run **pins one tab** (`TabPin` in `shared/messaging.ts`,
  `resolveTarget` in `background.ts`): the background verifies tab + plane on
  every write and fails loudly, bearers are keyed **per plane** (a source-tab
  session refresh can no longer clobber the target token), and steps A/B/C/D each
  BLOCK a live run they cannot pin. Export-D warns and continues (it only
  triggers a build naming a source course id).
- **Dead source media keys shipped to the target, masked by the assertion.**
  Blanking (`keyMap.set(key,'')`) was skipped by a falsy check, orphaned keys were
  never blanked at all, and the final surviving-keys check **excluded flagged
  keys** — reporting "surviving: 0" while a `rise/courses/<SRC>/…` key was written.
  Fixed; the assertion now runs **unfiltered**, and the real gate is a **read-back**
  `findForeignMediaKeys` over the actual `GET_COURSE` (survivors ⇒ `partial`,
  never `imported`).
- **A string holding an embed URL *and* an uploaded key was invisible.**
  `classifyString` tested embeds first, so such a string was classified `embed`:
  never downloaded, never remapped, never scanned. Media now wins; the key regex
  boundary also gained `(`, `=`, `,`, `>`, `;` (CSS `url()`, unquoted attrs,
  entity-escaped quotes). Both had no backstop — every guard shares that classifier.
- **Whole-string blanking destroyed authored text** (an HTML paragraph embedding
  one `<img>` became `''`). Now only the media reference is stripped.
- **"Resumable" was false.** Re-running duplicated courses. Resume is now
  per-run at COURSE granularity (already-imported courses are skipped); a
  failed/stopped course is re-imported as a NEW course, so partials are titled
  `!importing:` / `!unfinished:` and must be deleted by hand.
- **Transient asset failures were reported as "deleted at source"** and silently
  dropped the media. Only 403/404 are orphans now; anything else aborts that
  course before any write.
- **The panel could brick or hang.** Export handlers had no try/finally (a throw
  froze `busy` forever with no error line), the background message listener had no
  rejection path (`sendResponse` never fired ⇒ the panel awaited forever), and
  `rpc` had no timeout. All fixed; switching to the Export tab mid-import can no
  longer detach a live run.
- Storyline hardening: the Review-360 socket no longer leaks an
  infinitely-reconnecting manager on `connect_error` (auto-reconnect off — uploads
  are one-shot and the md5 is committed before bytes move), every ack is inspected
  (a refusal used to surface 180s later as a bogus "item not ready" timeout), and
  the `story.html` transform **asserts its own output** so a Rise markup change
  aborts loudly instead of uploading a broken package.
- Assets: resume verifies blobs still exist and that the key scan is covered by
  the manifest (so this audit's regex fix reaches already-"complete" owners), one
  worker's crash no longer kills the run, CDN fetches have timeouts, and orphan
  bookkeeping is consistent between summary and manifest.

**Deferred by operator decision** (documented, not bugs-in-waiting): the
`*.amazonaws.com` host permission stays broad (an Articulate bucket in a new
region would otherwise silently break uploads); Stop coverage stays partial
(fonts / step D / export loops are not stoppable); no purge-job-data action (the
archive is a folder the operator manages); the H5 panel-direct upload above; and
`awaitContentPrefix` still accepts the first prefix-shaped value without gating on
version readiness (unobserved; revisit only if attaches turn flaky).

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

Stats (at the time): 101 Vitest tests. Phase 0 validated against a live
579-course account + mitm captures. (Current: 468 tests — see the top section.)

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
failures — so a re-run is cheap and self-healing. (Audit-hardened: a `complete`
skip is honored only if the current key scan is fully covered by the manifest AND
every stored blob still exists — otherwise the owner re-runs, reusing prior keys.
That is what lets a key-detection fix reach already-"complete" owners.) (An early full-library run hit
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
is needed. Owners with an existing `*.assets.json` are resume-skipped **after a
coverage + blob check** (delete to force re-download).

Stats (at the time): 75 Vitest tests.

The full export side (Phases 0/0.1/2 incl. account extras) is **merged to
`master`** (PRs #1–#3); extension version was `0.2.4` (now `0.4.0`).

## Phase 3 — import / recreation (the write side): BUILT (merged to `master`)

Rebuild an exported archive into a *different* Rise account (US → EU). Since
merged to `master` (and audit-hardened — see the top section). What's built:

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

**Large assets — 64MB cap lifted (large-assets branch):**
- The S3 upload PUT now goes **direct from the side panel** (raw bytes), instead of
  base64 riding two `chrome.runtime` message hops (panel→background→tab) that capped
  at ~64MB. The S3 buckets are in `host_permissions` (`*.amazonaws.com`), which
  exempts the panel fetch from CORS. The ceiling is now memory (`MAX_UPLOAD_BASE64`,
  ~262MB raw) rather than messaging — so the 184MB GIFs that previously flagged now
  migrate. ⚠ **Needs live verification:** confirm the panel→S3 PUT succeeds with
  host_permissions (no CORS block) on both US and EU planes, and that very large
  files don't OOM the panel.

**Capture-confirmed (sample 2 — `docs/rise-mitm-sample-edit-media-theme.md`):**
- **Create handshake timing.** `POST /content` → `GET_COURSE` returns 200 immediately
  (the ~13s gap in the capture is OAuth re-auth + page load, not a wait). The importer
  now paces + retries the post-create GET_COURSE handshake (`courseHandshakeTries`, 3).
- **Images:** the editor calls `CRUSH_IMAGE`/`CROP_IMAGE`; we intentionally skip them
  and re-upload the source `key`+`crushedKey` verbatim (same end state).
- **Video thumbnails — BODY-CONFIRMED, no transcode.** An uploaded video block
  (`be2ee1ae`) carries `key` (mp4), `poster`+`thumbnail` (`images.eu` transform URLs
  over a separate uploaded `.png` key), and a `.vtt` caption — all `rise/courses/{id}/…`
  uploads our generic scan re-uploads + remaps (mp4→media-video, png→media-image,
  vtt→media-other). The client sends `skipProcess:true` + `isSkipCrush:true` →
  `TRANSCODE_ASSET`/`RESOLVE_ASSET` never called (matches our no-transcode stance). The
  upload-time `UPDATE_BLOCK_DEBOUNCE` has transient client fields; the SETTLED
  `GET_COURSE` (view capture `docs/captures/2026-06-23-eu-view-video-course.jsonl`)
  confirms the persisted shape.
- ⏳ **FUTURE LIVE TEST — uploaded-video `media.video.id` stale ref.** The persisted
  video block keeps `media.video.id = "<lessonId>-items:<blockId>/items:<itemId>"` (and
  AI captions `"ai-caption-<blockId>-<itemId>-<ts>"`). Our `remapIds` rewrites the
  `items:<id>` segments + media keys but leaves the **leading lessonId / ai-caption
  embedded ids stale** (a source id surviving in an internal `id` field). Keys migrate
  fine so playback should be unaffected, and parity ignores `id`. On the first live
  US→EU import with an uploaded video, CHECK: does the video play on target, and does
  Rise regenerate `media.video.id` on `CREATE_BLOCKS` (→ no-op) or store our value
  verbatim (→ decide whether to remap the leading lessonId in `remapRefString`)? Hold
  any `remapRefString` change until this is answered (a speculative remap could break a
  format Rise expects). See `docs/rise-mitm-sample-edit-media-theme.md` (Persisted shape).

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
