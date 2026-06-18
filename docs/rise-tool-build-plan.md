# Build Plan — Rise Export/Import Tool

Companion to the PRD. Covers tech stack, storage, repo layout, what to hand Claude Code, and a phased plan. Build with Claude Code; this plan + the PRD + `CLAUDE.md` are the inputs.

---

## 1. Tech stack

- **Language:** TypeScript. The validator/registry (PRD §8) is a type-modeling problem — model blocks as discriminated unions; an unknown element is one that matches no variant. Compile-time feedback also tightens the AI codegen loop.
- **UI:** React, in the Chrome **Side Panel**.
- **Scaffold:** **WXT** (convention-driven MV3 framework on Vite — manifest, side panel, content scripts, background handled for you). Alternative: Vite + CRXJS for more manual control.
- **Quality:** ESLint + Prettier + **Vitest**. Tests run against real course fixtures captured in Phase 0.

## 2. Storage (start simple, swap later)

- **Course archives → File System Access API** into a user-picked folder. One folder per course: `course.json` + `/assets/` + `manifest.json`. This is the "local folders" we want for v1.
- **App state** (registry, job status, session/identity, dashboard) → `chrome.storage.local` or **IndexedDB** (IndexedDB for blobs / larger data).
- **Storage interface now.** Define a `Storage` interface; implement `FileSystemStorage` first; a `DbStorage`/server backend drops in later without touching pipeline logic.
- **MV3 service workers are ephemeral.** Chrome terminates them; persist job progress to storage so a killed worker resumes mid-job. This is the PRD's resumability, for free.
- **Never persist customer credentials.** We ride the live session only.

## 3. Repo / module structure

- `content-script/` — session detection, identity, raw API calls in the Rise origin
- `background/` (service worker) — orchestration, the paced fetch queue, cross-origin asset up/download
- `sidepanel/` (React) — dashboard, course lists, status, reports
- `core/rise-client/` — typed wrappers over Rise endpoints
- `core/registry/` + `core/validator/` — known-element registry, recursive walk, version detection
- `core/exporter/`, `core/importer/`, `core/assets/` — the pipelines
- `core/storage/` — `Storage` interface + `FileSystemStorage`
- `shared/types/` — course schema types (start permissive, tighten from Phase 0 fixtures)

## 4. What to give Claude Code

- This build plan + the PRD
- `rise-api-reference.md` — endpoint contracts + course schema (the captured protocol)
- `rise-block-catalog.md` — living catalog of block types/options, grown by novelty review (Phase 0 seeds it)
- `CLAUDE.md` at repo root (companion file) encoding the invariants — auto-loaded every session; keep under ~200 lines
- Real course **fixtures** from Phase 0 (validator/importer can't be tested without them)
- Exact Rise **US + EU domains** for manifest `host_permissions` (capture in Phase 0)
- The **registry seed** (the Phase 0 census output)

## 5. Phased plan

### Phase 0 — Exploration / discovery (read-only) — start here
Launch in our agency account, walk every course, dump raw JSON, build a family/variant + media-ref census. Endpoints per `docs/rise-api-reference.md`.
- MV3 + side panel skeleton (TS, WXT)
- auth: capture the bearer JWT from the live session, attach `Authorization: Bearer`, refresh on 401 (API ref §2)
- identity: show who is logged in
- enumerate courses: `GET /manage/api/content/search` with **paced pagination**
- per-course `GET_COURSE` (ducks RPC), **strictly sequential + ~2s jitter** (don't get flagged on our own account)
- save each raw `GET_COURSE` document to a picked folder
- accumulate a **census**: every distinct `family/variant`, every media-key/cross-ref shape and where it occurs, and any version signal
- export census as CSV/JSON

**Deliverable:** the real distribution of block variants and media-ref/cross-ref shapes across the library (including very old courses) → confirms the copy-faithful path, **seeds `docs/rise-block-catalog.md`**, seeds the scanner's known media/cross-ref shapes, and produces test fixtures.
**Why first:** exercises the four riskiest pieces — JWT capture, content-script API access, pacing, storage — read-only, while producing the data everything downstream depends on.

### Phase 1 — Spec lock + validation
- From the census: confirm endpoints/schema, seed the block catalog
- **Tier 1** correctness scanner: generic media-key/cross-ref detection, scoped loud-fail (PRD §8)
- **Tier 2** novelty detector: per-block shape signature vs catalog, three-way classification (new-block / version-diff / our-bug), copy-faithful **round-trip self-check**, per-shape persisted decisions
- test both against Phase 0 fixtures

### Phase 2 — Export pipeline
- generic media-key/cross-ref scan → download uploaded media (public-read by key) → archive writer (raw `course.json` + assets + manifest) → dedup → validation gating (copy-faithful; scoped loud-fail per PRD §8)
- `Storage` interface with `FileSystemStorage`

### Phase 3 — Import pipeline
- create course shell (`POST /manage/api/content`) → set fields + theme (round-trips verbatim) → lessons in order → `CREATE_BLOCKS` (blocks written back unchanged) with client-generated ids
- assets: `GET_YURL` → S3 PUT → `CRUSH_IMAGE`/`TRANSCODE_ASSET` → remap keys
- cross-refs: recreate question banks then link draw-from-bank; match/select Review 360 item for Storyline (flag if unreachable)
- verification (count parity + asset checksums) → fidelity report

### Phase 4 — Dashboard + ops
- full side panel: both sessions, course list, per-course status, job log, reports, purge action, resumable jobs
- **novelty review UI**: surface auto-captured new shapes, show diff + classification hypotheses, let the operator classify once → enrich `rise-block-catalog.md`

### Phase 5 — Later
- DB / server storage backend (swap behind the `Storage` interface)
- multi-customer conveniences
