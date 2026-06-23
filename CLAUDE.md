# Rise Export/Import Tool — Project Memory

## What this is
Chrome extension (Manifest V3, Side Panel) that **exports** a Rise course (content + media) from one account and **rebuilds it editably** in another, via Rise's private "ducks" RPC + `manage/api`. Export and import are decoupled, independent phases. First business case: migrating courses from the Rise **US** server to the **EU** server.

**API & schema:** `docs/rise-api-reference.md` is the authoritative, captured protocol. Read it for endpoints/payloads/schema — never infer Rise's API from memory. The living **block catalog** is `docs/rise-block-catalog.md` (grown by novelty review — see invariants). Also in `docs/`: `rise-migration-prd.md` (what/why), `rise-tool-build-plan.md` (how/sequence).

## Stack
- TypeScript; React (side panel); **WXT** (MV3 scaffold); Vitest.
- Model blocks as discriminated unions only where we transform them; everything else is copied verbatim.

## The core model: copy-faithful
Rise blocks **round-trip verbatim** — read each block's JSON and write it back unchanged via `CREATE_BLOCKS`. An unseen `family/variant` copies correctly with no per-type code. Only two things actually vary and need handling:
1. **Media keys** — download from `articulateusercontent.com/{key}`, re-upload to target (`GET_YURL` → S3 PUT → `CRUSH_IMAGE`/`TRANSCODE_ASSET` → `RESOLVE_ASSET`/`CHECK_STATUS`), and remap the key in the block.
2. **Cross-refs** — Storyline block → Review 360 item; draw-from-bank block → question-bank id.

## Invariants (never violate)
- **Strictly sequential, human-paced fetching AND writes.** Never parallelize course fetches, list pagination, or **authoring-API writes**. Wait for each request to fully finish before the next. ~2s delay with randomized jitter between courses, between pages, and between write envelopes (`CREATE_LESSON`/`CREATE_BLOCKS`/`UPDATE_*`/`GET_YURL`/`CRUSH`/`TRANSCODE`/locks). Look like a person, not a scraper. **Exception:** raw **asset byte transfers** are outside the pacing invariant — CDN downloads (public-read) and **S3 upload PUTs** (presigned) may run in a bounded parallel pool (~4), since they hit S3/CDN, not the authoring API. The ducks calls that bracket an upload stay paced.
- **Loud failure is scoped to media keys and cross-refs.** Run a generic recursive scan over the whole course document for media-key-shaped values (S3 keys, `rise/courses/{id}/…` and `rise/questionBanks/{id}/…` paths, `articulateusercontent.com` URLs) and cross-refs. If a media key or cross-ref is found that the remap plan does not cover, ABORT that course with the exact path + raw snippet. Do NOT abort merely because a block `family/variant` is unseen — copy it faithfully.
- **Novel shapes are never copied silently.** A new `family/variant`, a new field shape on a known variant, or a copy-faithful round-trip mismatch raises an alert classified as new-block / version-difference / our-bug, and requires an operator decision (per distinct shape, deduplicated + persisted). On accept it is recorded to the block catalog (`docs/rise-block-catalog.md`). Migration is not blocked, but nothing new passes unseen or undocumented.
- **Copy-faithful round-trip check.** For any block treated as copy-faithful, assert that re-serialized output equals source input except for intended media/ref remaps. A mismatch is a code-fault signal → alert, do not ship it silently.
- **No source media keys may survive** in an imported course. Assert every uploaded-asset key was re-uploaded and remapped before declaring success. (CDN URLs `cdn.articulate.com/...` and embeds YouTube/Vimeo are kept as-is — not re-uploaded.)
- **The source archive is the immutable source of truth.** Never mutate it. The target payload is derived at import time from a copy.
- **Storyline/Mighty: recreate as PLACEHOLDERS; never touch Review 360.** Storyline blocks (and **Mighty**, which surfaces as storyline-variant blocks) are recreated copy-faithful as **placeholders** — flagged for manual handling. We do **NOT** contact the Review 360 servers at all (no `review/items` fetch, no inventory): the actual bundles/files are obtained out of band and added separately. There is no API path to ingest a raw bundle inline.
- **Auth:** bearer JWT (Okta), short-lived (~15 min). Captured from the live session or read straight from the `_articulate_rise_` cookie; service worker attaches `Authorization: Bearer`. Re-auth on **`401` AND `403`** (authoring endpoints answer an expired token with `403 Forbidden`) via `id.articulate.com/.../lifecycle/refresh`, then re-read the rotated cookie + retry; refresh proactively near `exp` AND force a refresh at run-start and **before each course** (an idle panel lapses the token, so the first ducks write of a course 403s otherwise). Never persist customer credentials.
- **Course creation handshake (mirror the editor).** A single `POST /manage/api/content` creates a FULLY-MATERIALIZED course (capture-confirmed: `GET_COURSE` returns it `200` immediately, with the classic theme + a random built-in cover; a bare titleless/lessonless shell is valid). Immediately after the POST, **always `GET_COURSE` the new id before any write** — exactly as the editor does on open — to confirm the shell is real. If it doesn't return a `course`, abort + roll back (soft-delete) rather than build on a broken shell. (A `GET_COURSE`-404 / `content/search`-500 phantom comes from a *partial delete*, NOT from creation — keep that for reference; do not build phantom-repair.) Preserve the source `course.type` (e.g. `onePage`) on the create call.
- **IDs:** course id and lesson id are server-assigned; block ids and item ids are client-generated (cuid-style) — generate consistently and keep internal `refs` (`items:<itemId>/…`) valid.
- **EU-resident store** for the US→EU case; provide a purge-job-data action.
- **Service worker is ephemeral.** Persist job progress to storage so a terminated worker resumes mid-job.

## Storage
- Course archives → File System Access API into a user-picked folder. Layout: root = `manifest.json` + content dirs `courses/`, `question-banks/`, `assets/` (content-addressed); raw account source in `account/` (folders, block-templates, typefaces); derived reports (inventories/census/catalog/novelty/assets-summary) in `_metadata/`. See `docs/rise-account-exports.md` for the full account export map.
- App state (registry, job status, session/identity) → `chrome.storage.local` / IndexedDB.
- All storage behind a `Storage` interface: `FileSystemStorage` now, `DbStorage` later.

## Conventions
- Asset/cross-ref discovery is a **generic recursive scan** of the full document, not a per-block-type walk.
- Dedup binaries by content hash: upload once, reuse the key for all references.
- **Every repeatable action shows `[i/N]` progress.** Any loop that does N units of work (folders, fonts, banks, lessons, courses, blocks, assets, purges, deletes…) logs per-item progress in the same form — e.g. `[3/20 folders] OK created "Name"`, `[12/77 fonts] OK created typeface "X"`, `[1/5] course …`. Never run a long loop that looks frozen; the operator must always see which item N-of-total is in flight.
- Keep this file under ~200 lines.
