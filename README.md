# Rise Migration — Explorer (Phase 0)

Read-only Chrome MV3 (WXT + React) extension that rides a logged-in
**rise.articulate.com** session to explore a course library. Phase 0 of the Rise
Export/Import tool — see `docs/` for the PRD, build plan, API reference, and block
catalog, and `CLAUDE.md` for the invariants.

**Phase 0 is read-only.** It does not export media, import, or recreate anything.

## What it does

1. **Captures the bearer JWT** by observing real Rise requests (`webRequest`) — no
   credentials are stored (token lives in `storage.session` only).
2. **Shows identity** (decoded from the JWT) and whether a Rise tab is present.
3. **Enumerates courses** via `GET /manage/api/content/search`, paginated with
   human pacing.
4. **Fetches each selected course** via the `GET_COURSE` ducks RPC — strictly
   sequential, ~2s + jitter between requests (CLAUDE.md pacing invariant).
5. **Saves each raw `GET_COURSE` body** verbatim to a user-picked folder (File
   System Access API).
6. **Builds a census** — every distinct `family/variant`, every media-key /
   cross-ref shape and where it occurs, lesson/question types, and a version
   signal — exported as `census.json` + `census.csv`.

Output folder layout:

```
<folder>/
  courses/<courseId>.json   raw GET_COURSE bodies (immutable)
  census.json               full census
  census.csv                flat census
  manifest.json             run index
```

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
