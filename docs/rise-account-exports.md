# Rise account export map

What an account exposes and our export status, so it isn't re-discovered.
Reverse-engineered from a live mitm capture (US plane, `*.articulate.com`).
Companion to `rise-api-reference.md`; schemas for the big resources live in
`rise-block-catalog.md` / `rise-question-banks.md`.

## Exported (the migration archive)

| Resource | Endpoint | Output |
|---|---|---|
| Courses | `POST …/ducks/rise/courses/GET_COURSE` (list via `GET /manage/api/content/search`) | `courses/<id>.json` + `_metadata/inventory.*`, `census.*`, `catalog.*`, `novelty.*` |
| Question banks | `GET /api/rise-authoring/question_banks` (questions inline) | `question-banks/<id>.json` + `_index.json`; `_metadata/question-banks-catalog.*` (schema) + `question-banks-inventory.*` (decision table) |
| Folders | `GET /manage/api/folders` (course) + `private_folders`/`shared_folders` in the banks index | `account/folders.json` + `_metadata/folders-inventory.*` |
| Uploaded media | `GET https://articulateusercontent.com/{key}` (public-read) | `assets/<sha256>.<ext>`, per-owner `*.assets.json`, `_metadata/assets-summary.json` |
| **Block templates** | `POST …/ducks/rise/blockTemplates/FETCH_BLOCK_TEMPLATES` (payload `null`) | `account/block-templates.json` + `_metadata/block-templates-inventory.*` |
| **Custom typefaces** | `POST …/ducks/rise/typefaces/FETCH_TYPEFACES` (payload = a **live** courseId — must exist on the tab's account) | `account/typefaces.json` + `account/typefaces.assets.json` (font key→file map) + `_metadata/typefaces-inventory.*`; font `.woff` files downloaded into **`account/assets/`** (separate from the content-addressed course `assets/`) |

> **Review 360 is NOT exported.** We deliberately never contact the Review servers
> (`api[.eu].articulate.com/review/*`). Storyline/Mighty content is recreated as
> placeholders (see below); the actual bundle files are obtained out of band.

## Mighty

Mighty is an external plugin whose interactive content appears in Rise as
**Storyline-variant blocks** (`type:interactive, variant:storyline`, with
`media.storyline.contentPrefix`/`src` under `rise/courses/{id}/…`).

**Treatment:** **recreate as placeholders.** We preserve the block +
contentPrefix verbatim in the course JSON and recreate the block copy-faithful on
import, flagged for manual handling. We do **NOT** fetch anything from Review 360
(no `review/items`, no inventory) — the actual bundle/package files are obtained
out of band and added separately. At import the target needs the Mighty plugin
provisioned and the same Review/360 reachable, else it stays a manual step.

## Deferred (endpoints exist; empty in the sampled account)

| Resource | Endpoint | Notes |
|---|---|---|
| Bookmark groups | `GET /manage/api/bookmark-groups` | empty here; small user-collections feature |
| External/shared folders | `GET /manage/api/folders/external` | empty here; content shared from other teams |

## Skip (not user-migratable content)

- Built-in block gallery: `mondrian-api.articulate.com/api/templates` (Articulate's own).
- Stock media: `api.articulate.com/content-library/images`.
- AI assistant + TTS: `api.articulate.com/ai/*`, audio voices/models (generated
  audio already lands as course `.mp3` media).
- Account/identity/billing: `manage/api/{profile,subscription}`,
  `api.articulate.com/{subscriptions,growth}`, `id.articulate.com/*` — needed to
  **map owners/teams** when re-homing, not exported as content.
- Realtime collab: `conveyor.articulate.com` socket.io (presence/locks).

## Write path (Phase 3 — import, captured for reference)

The same capture shows the recreation envelopes to build against:
`CREATE_LESSON`, `CREATE_BLOCKS`, `UPDATE_COURSE`/`courseTheme`, question-bank
`POST /manage/api/question-banks` → `PUT /api/rise-authoring/question_banks/{id}`
(`{questions, session, lock_data, update_type}`) + `locks` (`PUT_LOCK`/`DEL_LOCK`),
asset upload chain `GET_YURL` → S3 `PUT` (`x-amz-acl=public-read`) →
`CRUSH_IMAGE`/`TRANSCODE_ASSET` → `CHECK_STATUS`, and `INSERT_BLOCK_TEMPLATE`.
