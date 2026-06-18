# PRD — Articulate Rise Course Export/Import Tool

**Type:** Internal agency tool · Chrome extension
**Core capability:** Export a Rise course (content + media) from any account, and import it into any account — with an optional local-mutation step in between.
**First business case:** Migrate courses from the Rise **US** server to the **EU** server for customers (no official cross-server move exists, confirmed by Articulate).
**Status:** Draft. API details to be populated from mitm research.

---

## 1. Problem

Rise runs separate US and EU servers with no official migration path. Customers moving to the EU server for data-residency reasons need their US courses recreated on EU with full fidelity. We perform this as a one-time service per customer. This is the **first** use of a more general export/import primitive.

## 2. Approach

A Chrome extension that rides the authenticated Rise session to **export** course content + media from a source account and **import** it into a target account. The two halves are decoupled and run as independent phases, so source and target access are never needed at the same time:

1. **Export** (logged into source) → validate → save a self-sufficient archive to a local/EU-resident store.
2. **Import** (logged into target, possibly a different day) → derive the target payload from the archive and create the course.

## 3. Generality (why this is bigger than US→EU)

Export and import are account-agnostic primitives. The same mechanism supports:

- **Account-to-account migration** — e.g. US→EU (our first business case), or any source account to any target account.
- **Cross-account cloning** — copy a course from one customer/account into another.
- **Export → mutate → re-import into the same account** — pull a course (or many) to local storage, programmatically modify content and images, and push the result back. Enables bulk editing / content operations that the Rise UI doesn't offer.

US→EU is simply *export-from-US + import-to-EU*. We build the general tool; we ship the migration use case first.

## 4. Interface & platform

- Chrome extension using the **Side Panel API** for the UI — it stays docked alongside the Rise tab, persists across navigation, and is the best UX for an operator working through a list of courses (vs. a popup that closes on click-away).
- A web app on our own origin cannot ride the Rise session: the session cookie is `SameSite`-restricted and cross-origin reads are blocked by CORS. The extension's **content script runs in the Rise tab's own origin** (same cookies, same API, no CORS wall); its **service worker** makes cross-origin calls with host permissions. This also enables session detection and the dashboard.

## 5. Auth & identity

- Agency staff log in **once per phase using customer-provided credentials** (customer supplies source and target logins).
- Because we act as the customer's own user, imported courses are **owned by the customer**, in their account/folders.
- **Mechanism (captured):** auth is a short-lived **bearer JWT** minted by Okta (`id.articulate.com`), sent as `Authorization: Bearer` on every `manage/api` and ducks call. The content script captures the JWT from the live session; the service worker attaches it (host permissions bypass CORS); refresh on `401`. We never store credentials — we ride the live token.
- The extension reads the logged-in identity and displays who is logged in on each server.
- **To verify early:** confirm US and EU are distinct cookie domains, so both sessions can coexist in one browser profile (enables the live dashboard). If they share a domain, separate profiles / containers are required.

## 6. User flow

1. Open the side panel; it detects active source/target sessions and shows who is logged in on each.
2. **Dashboard**: list courses with per-course status (`Not started → Validated → Exported → Imported → Verified`).
3. **List & export inventory** (optional): produce and export a course inventory (see §7).
4. **Export** (source): select courses → **validate against the known-element registry, abort loudly on unknowns (§8)** → pull content + recurse all media → download binaries → write archive.
5. **Import** (target): select archived courses → upload binaries, derive target payload, create course → verify.
6. **Report**: generate a per-job fidelity report + log.

## 7. Course listing & inventory export

Two levels of listing:

- **Quick list** — from the list-courses endpoint. Fields: course id, title, owner, folder/team, last modified, language (if exposed), detected version (§8), status. Fast.
- **Deep inventory** — fetches each course. Adds: lesson count, block count, block-type breakdown, media count/size, version, and **validation status** (clean / unknowns found). Slower, one fetch per course (paced — see §12).

Both exportable as **CSV and JSON**. Uses: scope an engagement, hand the customer an inventory, choose courses to migrate, track progress, run a pre-migration audit that flags problem courses before any commitment.

## 8. Validation & discovery (two tiers)

Two orthogonal checks. Neither lets anything through silently that we haven't either covered or consciously accepted. Tier 1 asks "will it break?"; Tier 2 asks "is this new to us?"

### Tier 1 — Correctness (blocking)
Migration is **copy-faithful**: each block's JSON round-trips verbatim through `CREATE_BLOCKS`, so an unseen `family/variant` copies correctly with no per-type code. The only blocking concern is the two things that need transformation:
- **Generic media-key / cross-ref scan** over the whole document for media-key-shaped values (S3 keys, `rise/courses/{id}/…` paths, `articulateusercontent.com` URLs) and cross-refs (Storyline media, draw-from-bank ids).
- If the scan finds a media key or cross-ref the remap plan does not cover → **abort that course** with the exact path + raw snippet.
- Recognized non-remap references pass unchanged: CDN URLs (`cdn.articulate.com/...`) and embeds (YouTube/Vimeo).

### Tier 2 — Novelty & documentation (decision-gated, never silent)
Copy-faithful lets unknown blocks migrate, but they must still be surfaced, decided on, and documented — a side-goal is a full understanding of Rise's block types and options.
- **Shape signature** per block (`family/variant` + field-key set / structure), compared to the **block catalog** (`rise-block-catalog.md`).
- An alert is raised on: a novel `family/variant`; a known variant with a new field shape; or a **copy-faithful round-trip mismatch** (re-serialized block ≠ source for a block we didn't intend to transform).
- The alert classifies with three hypotheses: **new block type** (variant absent from catalog) / **version difference** (known variant, shape differs, course version differs from the catalog's) / **our code fault** (round-trip mismatch). The diff and evidence are shown; the operator decides.
- Decision is **per distinct shape, deduplicated across the batch and persisted**: classify once → accept (copy-faithful, recorded to the catalog with classification + note) or quarantine. Later occurrences of a classified shape pass silently.
- Accepting **enriches the block catalog** — that is how the documentation gets built.

### Version detection
Record each course's version signal; flag mixed versions in a batch; feed it to Tier 2's version-difference hypothesis. (Whether Rise exposes an explicit version id is still open — see §15.)

## 9. Intermediate store

Single source of truth per course; the target version is a **derived output**, never stored as an input.

At export, the archive contains:
- `course.json` — the **untouched source payload** (never mutated).
- **Binaries** — actual media files, keyed by **content hash** (enables dedup).
- `manifest.json` — index: asset-reference list, block-type inventory, counts, checksums, detected version, validation result.

The archive is fully self-sufficient (zero source access required to import later). For the US→EU case the store is **EU-resident**, with a retention/purge policy and a manual "purge job data" action.

## 10. Asset & cross-ref handling

- **Three reference classes:**
  - **Uploaded media** (`articulateusercontent.com/{key}` / S3 keys) → download (public-read, no auth), re-upload to target, remap the key.
  - **Shared CDN assets** (`cdn.articulate.com/...`, e.g. built-in theme cover/header images) → keep the URL, do not re-upload.
  - **Embeds** (YouTube/Vimeo) → plain URLs, no upload.
- **Upload flow (captured):** `GET_YURL` → pre-signed S3 `PUT` (no auth header) → `CRUSH_IMAGE` for images / `TRANSCODE_ASSET` + poll `CHECK_STATUS` + `RESOLVE_ASSET` for audio/video → rewrite the block's media `key`. `refs` ties an asset to a block item via `items:<itemId>/…`.
- **Cross-refs** (handled before/with the blocks that reference them): **Storyline** → select the matching Review 360 item so Rise re-copies the bundle (conditional — see §15); **draw-from-bank** → recreate the question bank, then point the block's item at the new bank id.
- **Dedup**: a binary used N times uploads once; all references reuse the same new key.
- **No source media keys may survive** in the imported course — assert every uploaded-asset key was re-uploaded and remapped before declaring success.
- Re-uploaded media is re-processed (delivery versions, not byte-identical originals) — expected, not an error.

## 11. Fidelity & verification

- **All block types in scope.** Unknown elements and version mismatches are caught up front by §8; a course never silently imports partial.
- Preserve accessibility data (alt text, caption tracks).
- Verification: block-count and asset-count parity, plus checksum of target-hosted assets against local copies.
- Import is reproducible: a half-failed job regenerates the target payload fresh from the untouched source archive.

## 12. Rate limiting & human-paced fetching

The tool must behave like a person clicking through the Rise UI, never like a scraper.

- **Strictly sequential** — never fetch courses in parallel. A course must **finish loading/fetching before the next begins**.
- **Inter-course delay** mimicking a human opening courses one at a time — on the order of a couple of seconds between courses, with **randomized jitter** so the cadence isn't robotic.
- **Paced list pagination** — when paging through the course list, imitate a human clicking page by page rather than rapid-firing page requests; apply the same delay + jitter.
- **Import/creation side**: human-speed pacing as above.
- All delays configurable so we can tune if Rise's behavior suggests a safer rhythm.

## 13. Reporting

Per job: a **fidelity report** (courses, lessons, blocks, assets migrated; checksums matched; flagged/quarantined items; detected versions) as a customer deliverable, plus an operation log for support/debugging.

## 14. Out of scope (for the first release)

- Re-sync / incremental updates (one-time migration only).
- Simultaneous export + import (phases are independent).
- Single customer per job run.
- Non-portable, server-specific data: review/share links, review comments, collaborator lists, analytics/learner data.

## 15. Open items

- **EU-plane hosts (primary unknown).** The captured protocol covers the US plane only. Capture/confirm the EU Rise domain, EU S3 bucket, EU usercontent domain, and EU Okta auth before building the import path.
- **Storyline is conditional (resolved into a constraint).** A Storyline block is only recreatable if the target account can reach the same Review 360 item (same 360 org/team); matched by `project_id`/`title`, then Rise re-copies. Otherwise flag for manual handling — there is no API path to ingest a raw bundle. See API reference §8.
- **Course versioning**: does Rise expose an explicit per-course version id, or must we infer it? (§8)
- **Localization / multi-language**: separate XLIFF-style payload (own export/import path) or embedded in the course JSON?
- **"Mighty" — clarified.** `mighty-type-style-*` are custom-font CSS classes in HTML content, not a block type; preserved as-is by keeping the same typeface IDs + verbatim HTML. No special handling needed.

## 16. API reference

See **`rise-api-reference.md`** (separate file) for endpoint contracts, auth/session model, course content schema, the element catalog, asset model, and versioning. Populated from mitm captures + Phase 0 exploration; kept as the source of truth from which the code's TS types and known-element registry are derived.
