# Rise Migration — Explorer (Phase 0)

Read-only Chrome MV3 (WXT + React) extension that rides a logged-in
**rise.articulate.com** session to explore a course library. Phase 0 of the Rise
Export/Import tool — see `docs/` for the PRD, build plan, API reference, and block
catalog, and `CLAUDE.md` for the invariants.

**Phase 0 is read-only.** It does not export media, import, or recreate anything.

## What it does

1. **Captures the bearer JWT** by observing real Rise requests (`webRequest`) — no
   credentials are stored (token lives in `storage.session` only). Catalog calls
   also ride the tab's first-party session cookie.
2. **Shows identity** — the logged-in account name read from the Rise page header
   (avatar `aria-label`, e.g. "INTEA Team"), whether a Rise tab is present, and the
   library's **total course count** (one cheap page-0 search, auto on detect).
3. **Enumerates courses** via `GET /manage/api/content/search`, paginated 16/page
   like the Rise UI; a **list limit** (16-step, or "All") caps how many to list.
4. **Inventory** — as soon as courses are listed, writes a customer-ready catalog
   `inventory.csv`/`inventory.json` (id, title, owner, lessonCount, type, dates,
   folder, shareId) straight from the listing — no per-course fetch needed.
5. **Fetches selected courses** via the `GET_COURSE` ducks RPC — strictly
   sequential, ~2s + jitter between requests, resumable (skips already-saved).
6. **Saves each raw `GET_COURSE` body** verbatim to a remembered folder (File
   System Access, persisted via IndexedDB; one-click reconnect after a restart).
7. **Census** — every distinct `family/variant`, media keys split by type
   (**image / video / audio / storyline** + other), CDN/embeds, cross-refs, and a
   version signal — exported as `census.json` + `census.csv`.

Output folder layout:

```
<folder>/
  courses/<courseId>.json   raw GET_COURSE bodies (immutable)
  inventory.json|csv        list-level catalog (written at listing time)
  census.json|csv           content-level census (written after fetch)
  catalog.json|csv          per-variant field profiles (block knowledge base)
  novelty.json|csv          Tier-2 novelty: new variants + new fields vs catalog
  manifest.json             run index
```

**Catalog + novelty (Tier-2, PRD §8).** For each block, a structural signature
(`family/variant` + recursive key-paths; array indices → `[]`, id-shaped map keys
→ `*`) feeds two outputs:

- **`catalog.json/csv`** — per-variant **field profiles**: the union of field-paths
  for each `family/variant`, each tagged **core** (present in every instance) vs
  **optional** (sometimes), with presence %. This is the scalable knowledge base
  (one row per variant×field, not per optional-field permutation) that seeds
  `docs/rise-block-catalog.md`.
- **`novelty.json/csv`** — only what's genuinely new: **new variants** (absent from
  the catalog seed in `core/census/catalog.ts`) and, once a variant has a recorded
  field baseline, **new fields**. Copy-faithful migration still round-trips unknown
  blocks — this just ensures nothing migrates unseen/undocumented.

Reports cover the **whole folder**: after fetching, the census/catalog/novelty are
rebuilt from **every saved course** (`scanSavedCourses` over `listSaved()`), not
just the current selection — so partial or multi-attempt scrapes stay complete.

The accept→remember loop: review a scrape's `catalog.json`, fold the accepted
per-variant fields into `core/census/catalog.fields.json` (the field baseline) and
new variant names into `core/census/catalog.ts` (+ the doc). Subsequent runs then
go quiet for them and surface only the next genuinely-new variants/fields. The
579-course scrape's 32 variants are already seeded in `catalog.fields.json`.

## Architecture

| Context | Role |
| --- | --- |
| `entrypoints/background.ts` | Token capture (`webRequest`), cross-origin fetch RPCs, 401 refresh. Does **not** pace. |
| `entrypoints/rise.content.ts` | Minimal session-presence ping. |
| `entrypoints/sidepanel/` | React UI + orchestrator: paced loops, folder writes, census. |
| `core/` | Pure, unit-tested logic: `census/` (recursive scan + aggregate + export), `rise-client/`, `auth/jwt`, `pacing/delay`, `storage/`. |
| `shared/` | Schema types + typed messaging protocol. |

The census scan is a **generic recursive walk** of the whole document (never a
per-block-type walk), per the CLAUDE.md convention.

## Develop

```bash
pnpm install        # also runs `wxt prepare`
pnpm dev            # launch in dev (Chrome) with HMR
pnpm build          # production MV3 build → .output/chrome-mv3
pnpm test           # vitest (pure core/ + shared/)
pnpm compile        # tsc --noEmit type-check
```

Load the unpacked build from `.output/chrome-mv3` via `chrome://extensions`
(Developer mode → Load unpacked). Open a logged-in Rise tab, click the toolbar
icon to open the side panel, interact with Rise once so the token is captured,
then pick a folder and list/fetch courses.

## Notes / open items

- **API calls run inside the Rise tab.** Rise's catalog/`manage/api` is
  cookie-authenticated; a `SameSite` session cookie is withheld from an
  extension-origin (cross-site) fetch, so the background runs the fetch in the
  live Rise tab via `chrome.scripting.executeScript` (first-party cookies +
  bearer). **Keep a logged-in rise.articulate.com tab open** while using the
  panel.
- **Token refresh on 401** is best-effort; the reliable fallback is re-interacting
  with the Rise tab so the observer captures a fresh token. Confirm the refresh
  mechanics against live Rise.
- **Search response shape** is treated permissively (`items[]`, stop on a short
  page). Tighten once real responses are captured.
- Endpoints/payloads come only from `docs/rise-api-reference.md` — never inferred.
