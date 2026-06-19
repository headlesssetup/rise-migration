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
- **Strictly sequential, human-paced fetching.** Never parallelize course fetches or list pagination. Wait for each request to fully finish before the next. ~2s delay between courses with randomized jitter. Same for pagination. Look like a person, not a scraper.
- **Loud failure is scoped to media keys and cross-refs.** Run a generic recursive scan over the whole course document for media-key-shaped values (S3 keys, `rise/courses/{id}/…` and `rise/questionBanks/{id}/…` paths, `articulateusercontent.com` URLs) and cross-refs. If a media key or cross-ref is found that the remap plan does not cover, ABORT that course with the exact path + raw snippet. Do NOT abort merely because a block `family/variant` is unseen — copy it faithfully.
- **Novel shapes are never copied silently.** A new `family/variant`, a new field shape on a known variant, or a copy-faithful round-trip mismatch raises an alert classified as new-block / version-difference / our-bug, and requires an operator decision (per distinct shape, deduplicated + persisted). On accept it is recorded to the block catalog (`docs/rise-block-catalog.md`). Migration is not blocked, but nothing new passes unseen or undocumented.
- **Copy-faithful round-trip check.** For any block treated as copy-faithful, assert that re-serialized output equals source input except for intended media/ref remaps. A mismatch is a code-fault signal → alert, do not ship it silently.
- **No source media keys may survive** in an imported course. Assert every uploaded-asset key was re-uploaded and remapped before declaring success. (CDN URLs `cdn.articulate.com/...` and embeds YouTube/Vimeo are kept as-is — not re-uploaded.)
- **The source archive is the immutable source of truth.** Never mutate it. The target payload is derived at import time from a copy.
- **Storyline is conditional.** A Storyline block is only recreatable if the target account can reach the same Review 360 item (same 360 org/team). If not, flag it for manual handling — there is no API path to ingest a raw bundle.
- **Auth:** bearer JWT (Okta). Content script captures it from the live session; service worker attaches `Authorization: Bearer`; refresh on `401` via `id.articulate.com/.../lifecycle/refresh`. Never persist customer credentials.
- **IDs:** course id and lesson id are server-assigned; block ids and item ids are client-generated (cuid-style) — generate consistently and keep internal `refs` (`items:<itemId>/…`) valid.
- **EU-resident store** for the US→EU case; provide a purge-job-data action.
- **Service worker is ephemeral.** Persist job progress to storage so a terminated worker resumes mid-job.

## Storage
- Course archives → File System Access API into a user-picked folder: raw `course.json` + `/assets/` + `manifest.json` per course.
- App state (registry, job status, session/identity) → `chrome.storage.local` / IndexedDB.
- All storage behind a `Storage` interface: `FileSystemStorage` now, `DbStorage` later.

## Conventions
- Asset/cross-ref discovery is a **generic recursive scan** of the full document, not a per-block-type walk.
- Dedup binaries by content hash: upload once, reuse the key for all references.
- Keep this file under ~200 lines.
