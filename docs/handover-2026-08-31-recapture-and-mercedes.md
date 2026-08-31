# Handover — Rise recapture + Mercedes import readiness (2026-08-31)

## Executive state

Two current US MITM sessions and a fresh two-course local archive were analyzed.

- The core Rise course/lesson/block/media transport has **not** been replaced.
- The `_mercedes` archive is internally complete and, except for one
  post-export publish-settings change, matches the current live Rise documents.
- Both source Mercedes courses preview and publish successfully.
- Neither Mercedes course has a Rise brand applied; they only use custom
  Mercedes typefaces.
- The current importer is still a **NO-GO for a production Mercedes import**.
  The main blocker is reused cuid-shaped nested IDs that the current remapper
  can preserve as collisions. Course settings, publish settings, and optional
  media parity also need fixes.

The earlier symptom—target course opens in the editor but preview/publish
fails—is compatible with nested-ID clobbering, but this has not been proven
against that failed target course because its target `GET_COURSE` and failed
preview/publish responses were not captured.

## Read first

1. This file.
2. `docs/findings-2026-08-31-us-recapture.md`.
3. `docs/rise-api-reference.md`, especially auth and §4a editing envelopes.
4. `core/import/remap.ts` (`freshClientIds` / `remapIds`).
5. `core/import/verify.ts` (course settings and optional-media parity).
6. `core/storyline/build-request.ts` (version-pinned raw export request).

## Local evidence — do not commit

These paths are operator-local and now ignored:

- `_capture3108/capture-editing-20260831-import-test.mitm`
- `_capture3108/capture-editing-20260831-mercedes.mitm`
- `_mercedes/`

The captures contain OAuth/session material, identity data, and authored
content. Do not commit or share raw `.mitm` or unsanitized JSONL.

`_mercedes/` is a `rise-local-archive` v1 archive:

- state: `ready`
- origin: `rise-export`
- tool version: `0.9.8`
- two courses
- course and asset-manifest checksums verified
- 226 asset references fetched
- 145 unique asset files written
- 81 content-hash deduplications
- no required asset failures
- 80 font mappings/files present and hash-valid

## Uncommitted repository changes from this chat

- `.gitignore`
  - ignores `_capture*/`, `_mercedes/`, and `*.mitm`
- `core/storyline/build-request.ts`
  - current raw web-export bundle pins from the first 2026-08-31 US capture
  - adds `ai_scenario`
  - updates LMS driver to `7.12.0.a.1.6.6`
- `core/storyline/build-request.test.ts`
  - updated bundle override fixture
- `docs/rise-api-reference.md`
  - current auth/lifecycle nuance
  - UUIDv4 is also a current client-ID shape
  - real multi-delete and ordered multi-move cardinality
  - multi-duplicate behavior
- `docs/findings-2026-08-31-us-recapture.md`
  - redacted detailed findings from the first capture
- `scripts/mitm-to-jsonl.py`
  - response cap raised from 200 KB to 2 MB because current `GET_COURSE`
    responses exceed 450 KB
  - explicit warning that output is unsanitized

Validation already run after these changes:

- TypeScript: clean (`./node_modules/.bin/tsc --noEmit`)
- Vitest: 84 files passed, 830 tests passed, 1 skipped

No commit was created.

## Capture 1 — basic US edit/import-test session

Source:
`_capture3108/capture-editing-20260831-import-test.mitm`

### Multi-block actions

No new authoring endpoint was introduced.

#### Multi-move

Rise uses the existing:

```text
rise/lessons/MOVE_BLOCKS
```

with:

```json
{
  "lessonId": "<lesson>",
  "courseId": "<course>",
  "moves": [
    {
      "blockId": "<block>",
      "previousBlockId": "<block|null>",
      "nextBlockId": "<block|null>"
    }
  ]
}
```

One request carried two moves. `moves[]` is procedural and order-sensitive:
the second entry described state produced by the first. UI selection count does
not necessarily equal `moves.length`; Rise can emit a minimal move set.

Importer/update implication: preserve array order and verify final order with
`GET_COURSE`.

#### Multi-delete

One existing `DELETE_BLOCKS` request carried three `blockIds`. The response
echoed all three. This disproves the older note that the editor always sent one.

#### Multi-duplicate

The UI emitted one single-block `CREATE_BLOCKS` per selected block. Two calls
overlapped and shared an anchor. It did not use `BULK_UPDATE_BLOCKS`.

Importer implication: do not copy the UI overlap. Keep authoring writes
sequential and use deterministic insertion anchors.

### Other drift

- Current editor-generated block/item IDs can be UUIDv4, not only cuids.
- `GET_COURSE` can include:
  - `payload.deliveryPolicy`
  - `course.awaitingContent`
  - `course.theme.brandId`
  - `course.theme.appliedBrand`
  - `course.theme.colors`
  - `course.theme.showLogo`
- Brand catalogs are read from:
  - `GET /manage/api/brands`
  - `GET /api/rise-runtime/manage/brands`
- Brand logo assets use a new account namespace:
  - `rise/brands/<brand-id>/...`
- Applying a brand used:
  - `UPDATE_COURSE {id, applyBrandId, theme}`
- `UPDATE_COURSE_DEBOUNCE {id, exportSettings}` was observed.
- Collaboration now emits `rise/courseSnapshots/SNAPSHOT_CREATED`.

### Brand implementation remains blocked

The first capture proves the source/read/apply shape but does not prove:

- brand create/update API
- brand-logo upload path
- target brand mapping
- EU parity
- whether `appliedBrand` is portable materialized state or provenance

Do not invent brand migration. A source `brandId` is account-specific, and
`rise/brands/...` keys must never silently ship to a target.

### Auth observations

- Current US editor ducks calls succeeded with cookies and no explicit
  `Authorization` header.
- This does not prove the extension should remove its bearer. Test one
  controlled relayed `GET_COURSE` with `omitBearer` before changing auth.
- Okta lifecycle refresh still does not rotate `_articulate_rise_`.
- Some lifecycle responses set Okta session cookies, so the old blanket
  “no Set-Cookie” statement was corrected.

### Raw web-export version pins

The first capture's `build/{courseId}/raw` request used:

```json
{
  "rise_frontend": "138df8347f29d7a2ed31fc506d7f54d1826e4983",
  "ai_scenario": "a5a39ec2268be9757df119279017e713aa697bf1",
  "learn_distribution_frontend": "036472797945bdca27b2c7cfe3a4d0b743a4a977",
  "mondrian": "a0e63065d3a4cbe865042e3ced4865ba54c4f7ad",
  "sandbox": "42753f3391b109fa3788c525c22880445ab48325"
}
```

with LMS driver `7.12.0.a.1.6.6`.

The later Mercedes SCORM 1.2 builds used a different `rise_frontend`
(`96b0e1ec...`) while the other pins matched. Do not replace the raw-export
default from a SCORM capture: the difference may be export-format-specific.
Capture another `/raw` request if current raw defaults need reconfirmation.

## Capture 2 + `_mercedes` — source/archive fidelity

Source:
`_capture3108/capture-editing-20260831-mercedes.mitm`

### Branding verdict

The source account has brands, including a default brand, but neither course
has a brand applied:

- no `brandId`
- no `appliedBrand`
- no `rise/brands/...` reference
- Rise UI shows “Apply a brand”

Therefore the first capture's new brand surface is not a Mercedes blocker.

### Course 1 — MB CRM Gatekeeper

ID: `qVdswsO4DXVtPxn7_iUiTo6lV1LDKrtz`

- 27 lessons
- 115 block/question items
- six inline quiz questions
- no Storyline
- no question-bank cross-reference
- not localized
- all required rendering media archived
- six source asset 403s are optional provenance only:
  - two `media.tmp`
  - two `originalImage`
  - two video `inputKey`

Typeface bindings:

- heading: `MB Corpo A Text Cond`
- body: `MB Corpo S Text Light`
- UI: built-in `Lato`

The required Mercedes WOFF files are archived.

Live/archive comparison:

- authored content and shapes match
- expected live-only changes:
  - `updatedAt`
  - `order`
  - `lastPublishedAt`
  - publish experiment metadata
  - one course snapshot
  - request-time `deliveryPolicy.evaluatedAt`
- one meaningful post-export difference:
  - archive `course.exportSettings.quizId` held a quiz lesson's
    `duplicatedFromId`
  - after source publish, live Rise corrected it to the actual quiz lesson ID

The source preview succeeded:

- `/preview/<id>`: 200
- `/api/rise-runtime/boot/<id>`: 200
- no asset failures

The source SCORM 1.2 publish succeeded:

- build acknowledgement: 200
- distributor: `package:success`
- downloaded ZIP: valid, about 87 MB

### Course 2 — The Spaceship Mission – Bitara’s new adventure

ID: `qsOHNWMQiuZHTbhKV0e9ZVgNFbgpTJsp`

- six lessons
- 104 blocks
- no Storyline
- no question-bank cross-reference
- not localized
- every media key and byte present

Typeface bindings:

- heading: `MB Corpo Schrift Headline`
- body: `MB Corpo Schrift Regular`
- UI: built-in `Lato`

The required Mercedes WOFF files are archived.

Live/archive comparison:

- full content/shape match after only legitimate publish/server metadata is
  canonicalized

The source preview succeeded:

- preview HTML: 200
- runtime boot: 200
- no asset failures

The source SCORM 1.2 publish succeeded:

- build acknowledgement: 200
- distributor: `package:success`
- downloaded ZIP: valid, about 17 MB

## Why the archive is correct but current import is not yet safe

### Blocker 1 — repeated cuid-shaped structural IDs

Rise blocks contain identities at several levels:

- block IDs
- nested item IDs (quote item, flashcard, panel, etc.)
- question IDs
- answer IDs

These are not all quizzes. The Mercedes sources reuse some nested cuid-shaped
IDs across different blocks/lessons. Top-level block IDs are unique.

Current behavior:

1. `freshClientIds` remints only IDs that do **not** look like client IDs.
2. Cuid-shaped IDs pass to the global `IdMap`.
3. `IdMap` maps equal source strings to one equal target string.
4. A reused source cuid can therefore remain a target collision.

This is the same general defect class as the already-fixed numbered-ID
collision, except the old fix deliberately skipped cuid-shaped IDs.

Risk: Rise can clobber nested content or bind references to the wrong item. A
course may remain editor-openable while learner runtime or publishing fails.

Required fix:

- remint every structural block/item/question/answer identity per block,
  regardless of source ID format
- preserve local references:
  - exact answer refs
  - `correct`
  - `corrects`
  - `items:<id>` refs/upload IDs
- keep unrelated IDs outside structural positions untouched:
  - Storyline metadata slide IDs
  - scenario/library identifiers
  - other domain IDs
- assert that generated Mercedes create payloads contain no structural
  collisions

Do not rebuild each family/variant from a hand-authored schema. Continue copying
the full block JSON; only regenerate structural identities and references.

### Blocker 2 — course settings are not migrated

Both source courses carry non-default course settings. Current import does not
write fields including:

- `sidebarMode`
- `navigationMode`
- `showLessonCount`
- `showNavigationButtons`
- `allowSearch`
- `allowCopy`
- `animateBlockEntrance`
- `markComplete`
- `enableVideoPlaybackSpeed`
- `color`
- nested `settings`
- `aiTutorConfig`

`verify.ts` already treats a difference as blocking `course-field-changed`, so
the current result should be `partial`, not falsely imported.

This is historical backlog, not a policy decision. A nested settings envelope
was captured earlier:

```text
UPDATE_COURSE_DEBOUNCE {id, settings}
```

Before implementing the entire surface, capture every current Settings control
once to determine which fields ride `settings`, which ride a full
`UPDATE_COURSE`, and write ordering.

### Blocker 3 — publish/export settings are not migrated

`exportSettings` includes:

- completion mode
- completion percentage
- selected quiz
- LMS reporting
- resume behavior
- locale packaging
- web-export settings

Current import neither writes nor verifies it.

The Mercedes capture proves:

```text
UPDATE_COURSE_DEBOUNCE {id, exportSettings}
```

CRM requires identity remapping:

- source `quizId` must map to the new target quiz lesson ID
- therefore the export-settings write must happen after lessons are created
- read back and assert that `quizId` names a real target quiz lesson

The source archive's CRM `quizId` is stale relative to live Rise because the
source publish happened after archive creation. Re-export CRM if an exact
current source snapshot is wanted. Re-exporting alone does not close the import
implementation gap.

### Blocker 4 — optional provenance currently causes false `partial`

Per the project invariant, unavailable optional authoring provenance is blanked
without a manual flag:

- distinct `inputKey` when playback has a valid `key`
- `media.tmp`
- `originalImage`
- inactive `key`/`crushedKey` variant

CRM has six such source keys. The archive correctly records them as optional
and has no required failure.

Current parity logic tolerates missing media primarily via manual flags.
Optional drops intentionally have no flag, so their blanked fields can still
produce blocking `media-missing` differences.

Required fix:

- carry typed optional omission paths/reasons into parity, or canonicalize
  those exact source paths out before comparison
- do not add a manual-work flag
- do not weaken the final foreign-media-key assertion; it remains unfiltered
  over the actual target `GET_COURSE`

### Typeface state

All four active Mercedes custom typeface files are present and valid.

Current import behavior is otherwise suitable:

- match target typefaces case-insensitively by name
- recreate missing custom typefaces from archived WOFF bytes
- upload with required S3 ACL header
- remap active course/theme bindings

Operator decision in this chat: same-name byte equivalence is not a concern.
Do not treat name-only reuse as a blocker.

CRM contains two stale theme-internal typeface IDs with no source typeface
catalog entry. The authoritative top-level bindings are valid, and the source
itself previews/publishes with these stale theme values. They should still be
examined during target read-back, but they are not a demonstrated source
failure.

## Novel block-field paths

Archive novelty summary:

- 34 known family/variants
- zero new variants
- 273 field paths absent from the current field-profile catalog

“Novel path” does not mean invalid. The count is inflated because every nested
object and leaf path is listed separately.

Main groups:

- image dimensions/crop coordinates
- `originalImage`
- `isSquare`
- `isSkipCrush`
- `sourcedFrom`
- `originalUrl`
- background image metadata on text/list/quote/impact/continue blocks
- scenario character pose records, filters, keys, and thumbnails
- custom padding
- knowledge-check retry count
- `attachedToNextBlock`
- audio-position settings

Because:

- the archive matches live Rise,
- both source previews succeed, and
- both source publishes succeed,

these look like legitimate current Rise fields, not corruption. Review and
accept/catalog the distinct shapes before production import, preserving the
copy-faithful rule.

Novelty is currently present in `_metadata/novelty.json`, but import-plan output
does not surface 273 manual decisions. Ensure the normal persisted novelty
decision workflow records operator acceptance; do not silently treat the file
as approved.

## Exact next implementation plan

Implement and verify in this order:

1. **Structural ID remint**
   - characterize both Mercedes documents
   - fix per-block remint for cuid-shaped structural IDs
   - preserve local refs
   - assert no generated structural duplicates
2. **Optional-media parity**
   - add the CRM six-key regression
   - optional omissions must not produce `partial`
   - final foreign-key read-back remains strict
3. **Course settings**
   - run focused current-UI capture for every control
   - add ordered write step
   - remove settings fields from known-gap annotations as each ships
4. **Publish settings**
   - write after lessons exist
   - remap `quizId`
   - include in read-back parity
5. **Novelty decisions**
   - review/dedupe the 273 paths into distinct shapes
   - accept legitimate shapes into `docs/rise-block-catalog.md`
6. **Mercedes target smoke test**
   - one course at a time, disposable target
   - do not use the prior broken target as proof of the fix

## Required target smoke-test evidence

For each imported course:

1. Save complete import logs and `_import/<id>.report.json`.
2. Capture final target `GET_COURSE`.
3. Run unfiltered `findForeignMediaKeys` on that actual read-back.
4. Confirm no unresolved local asset refs.
5. Compare:
   - lesson order/count
   - block family/variant/order
   - nested item/question/answer counts and refs
   - course settings
   - theme
   - typeface names/bindings
   - export settings
6. HEAD each recreated Mercedes WOFF and require 200.
7. Open target preview:
   - `/preview/<targetId>`: 200
   - `/api/rise-runtime/boot/<targetId>`: 200
   - no required asset 403/404
8. Publish SCORM 1.2:
   - settings update: 200
   - build acknowledgement: 200
   - distributor `package:success`
   - download and validate ZIP
9. CRM specifically:
   - `exportSettings.quizId` equals the new target quiz lesson ID
   - quiz completion/reporting works
10. Mark `imported` only after the read-back and runtime/publish checks pass.

## If the old failed target is still available

A short diagnostic capture would strengthen root-cause confidence:

- target `GET_COURSE`
- failed `/api/rise-runtime/boot/<id>` status/body
- failed publish build status/body
- browser console error

Compare nested block/item/answer counts and IDs to the source archive. If
content is missing or IDs collapse, that directly proves the current
`freshClientIds` defect caused the earlier failure.

## Remaining full-recapture campaign

Do not use one giant recording. Use isolated sessions with timestamped operator
notes and US/EU parity where relevant:

- auth/editor boot and expiry
- regular/onePage/AI-outline creation
- core authoring and settings
- editing/multi-actions/undo
- media matrix
- folders/permissions
- question banks
- localization conversion and locale writes
- stack management
- Storyline export/import
- legacy Storyline
- XLIFF/publish
- long-run token refresh
- negative rights/auth/asset cases
- brand creation/logo/application/removal

Every accepted protocol change needs:

- captured request and response
- read-back evidence
- sanitized fixture
- regression test
- protocol-document update
- no weakening of pacing, media-remap, cross-reference, novelty, or
  copy-faithful invariants

