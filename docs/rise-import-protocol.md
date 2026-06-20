# Rise Import / Recreation Protocol (the write side)

> **Authoritative, capture-derived.** Reverse-engineered from a US write-path mitm
> session (`http_api.jsonl`, 334 envelopes — a live edit of an existing course plus
> a throwaway question-bank lifecycle). Companion to `rise-api-reference.md` (which
> covers the read side and the high-level recreate sketch in §4–§9). **Never infer
> the write API from memory — this file + the captures are the source of truth.**
>
> **Plane.** All hosts below are the **US** plane (`rise.articulate.com`,
> `articulate-us.s3.amazonaws.com`, `articulateusercontent.com`, `id.articulate.com`).
> URLs to `rise.articulate.com` are issued **relative** so they ride whichever Rise
> tab is open (US or EU). The two **absolute** hosts that may differ on EU — the S3
> upload bucket (`articulate-us.s3…`) and the usercontent read host — come back
> **inside** the `GET_YURL` response (`url`, `key`), so the upload target is
> server-dictated, not hard-coded. EU `CRUSH_IMAGE`/`TRANSCODE_ASSET` behaviour is
> uncaptured; build/verify **US→US first** (decision at kickoff).

---

## 0. Transport (same as the read side)

- Every `rise.articulate.com` call is `POST .../api/rise-runtime/ducks/rise/<domain>/<ACTION>`
  with body `{type:"rise/<domain>/<ACTION>", payload:{…}}`, **or** a REST call under
  `/manage/api/*` / `/api/rise-authoring/*`. Bearer JWT on every call; `Content-Type:
  application/json` for bodies. Calls run **inside the live Rise tab** (first-party
  cookies) exactly like the export path.
- **Auth refresh.** The capture shows `POST id.articulate.com/api/v1/sessions/me/lifecycle/refresh`
  (→204) firing constantly between writes, and one `POST id.articulate.com/oauth2/default/v1/token`.
  Treat as read side: refresh best-effort on `401`, retry once.
- **The websocket carries no document writes.** `conveyor.articulate.com/socket.io`
  is collaboration mirror only (presence + lock broadcast). A single-author importer
  ignores it. (It DOES carry a mirror of each write for live co-editing, but the HTTP
  call is authoritative — we never need the socket.)
- **`rise/track/TRACK`** envelopes are pure analytics (telemetry of UI actions).
  **Never replay them** — they're noise in the capture, not part of the write
  contract.

---

## 1. The write SEQUENCE (per course)

Derived from the capture's ordering. Steps the export side already mapped are cited;
new envelopes are documented in §3+. **Strictly sequential + human-paced** (the
export pacing invariant applies verbatim to the authoring API): one write fully
finishes before the next starts, ~2s ± jitter between writes. Idempotent + resumable
via a persisted old→new id map (§6) so a retry never double-creates.

```
# ---- account-level, once per run (before any course) ----
for folder in source folders, DEEPEST-FIRST so parents are remapped first:   # §5
    newFolderId = POST /manage/api/content … (folder create; see §5)
    map oldFolderId -> newFolderId

for bank in banks referenced by draw-from-bank blocks (deduped by id):       # §4
    POST /api/rise-authoring/locks         {category:"questionBanks/<uuid>", session, …}
    newBankId = POST /manage/api/question-banks {folderId:mapped, title}      -> {id}
    PUT /api/rise-authoring/question_banks/<newBankId> {id, questions:[…remapped…],
                                            session, lock_data, update_type:"editor"}
    map oldBankId -> newBankId ;  map each oldQuestionId -> newQuestionId

# ---- per course ----
newCourseId = POST /manage/api/content {createBookmark:false, folderId:mapped}  # ref §4.1 -> {id}
UPDATE_COURSE {id:newCourseId, theme}                # theme round-trips verbatim (§7)
UPDATE_COURSE_FIELD {id, field:"title", value}       # title (and other scalar fields)

for lesson in source.lessons (ASC position):
    {lessonId} = CREATE_LESSON {author, courseId:newCourseId, position, title, type:null}  # §2
    UPDATE_LESSON {id:lessonId, courseId, type:<blocks|section|quiz>, icon, …,
                   bulkUpdateBlocks:{deletes:[],creates:[],updates:[],moves:[]}}           # §2
    PUT_LOCK {id:lessonId, courseId}                  # §2 (lesson edit lock; optional but captured)

    previousBlockId = null
    for block in lesson.items (source order):
        CREATE_BLOCKS {courseId:newCourseId, lessonId, previousBlockId,
                       blocks:[ remapBlock(block) ]}   # §3 — client-gen ids
        previousBlockId = block.newId
        if block is draw-from-bank:                    # §4
            INSERT_QUESTION_BANK_QUESTIONS {lesson:<full lesson>, blockOrItemId,
                drawCount, mode, pendingItemId, questionBankId:newBankId,
                questionDrawType, questionList:[…new question ids…], courseId}
        if block carries uploaded media:               # §8 — do AFTER the block exists
            for each media key on the block:
                {key,url,type} = GET_YURL {assetPath:"courses/"+newCourseId,
                                           courseId:newCourseId, filename}
                PUT bytes -> url   (Content-Type:type, public-read in the presigned url)
                if image: CRUSH_IMAGE {courseId, original:key} -> {key:crushedKey}
                if a/v:   TRANSCODE_ASSET {courseId,key,lessonId,mediaType,original,
                                           refs,uploadId} -> {jobId}
                          UPDATE_COURSE {id:newCourseId, jobs:[jobId]}   # register job
                          poll CHECK_STATUS {jobs:[jobId], courseId} until done
                UPDATE_BLOCK_DEBOUNCE {id:blockId, courseId, lessonId,
                                       item:<block with media.{image|video|audio}.key
                                             (and crushedKey) set to the NEW key>}   # §8
        if block is storyline / mighty:                # §9 — conditional, flag manual
            … only if target reaches the same Review 360 item; else SKIP + flag

    DEL_LOCK {id:lessonId, courseId}                   # release the lesson lock
```

> **Ordering rules that matter (from the capture):**
> 1. **Lesson exists → blocks → media.** A media block is first created with its
>    *default/placeholder* media (or empty), THEN the real asset is uploaded and the
>    block is patched via `UPDATE_BLOCK_DEBOUNCE`. You cannot upload to a course/lesson
>    that doesn't exist (`GET_YURL` needs the real `courseId`; `TRANSCODE_ASSET` needs
>    `lessonId` + the block item `refs`).
> 2. **`previousBlockId` chains block order.** First block in a lesson uses
>    `previousBlockId:null`; each subsequent `CREATE_BLOCKS` passes the *prior* block's
>    id. (Capture: `null → cmqjv8g0… → cmqjv96a… → …`.) Blocks CAN be batched in one
>    call, but the capture creates them one-at-a-time; we mirror that (human-paced).
> 3. **Banks before the blocks that draw from them** (a draw-from-bank block needs the
>    new bank id). Folders before courses/banks (so `folderId` is the mapped target).
> 4. **`UPDATE_COURSE {jobs:[…]}` registers transcode jobs on the course** — it's the
>    same envelope as the theme write, just a different payload field. Send it after
>    `TRANSCODE_ASSET` returns a `jobId`, then poll `CHECK_STATUS`.

---

## 2. Lessons — `CREATE_LESSON`, `UPDATE_LESSON`, locks

**`POST …/ducks/rise/lessons/CREATE_LESSON`**
```jsonc
// req.payload
{ "author":"auth0|…", "selectedAuthorId":"auth0|…",
  "courseId":"<newCourseId>", "position":5, "title":"remaining types", "type":null }
```
`author`/`selectedAuthorId` = the importing account's user id (read from the session
identity / `locks` profile). `type` is sent **null** here and set on the follow-up
`UPDATE_LESSON`. Response returns `payload.course.lessons[]` (the full **ordered** id
list, server-authoritative) and `payload.lesson.id` — the **server-assigned lessonId**
(record it old→new). `position` is the 0-based slot; send source order ascending.

**`POST …/ducks/rise/lessons/UPDATE_LESSON`** sets the real lesson fields:
```jsonc
{ "id":"<lessonId>", "courseId":"<newCourseId>",
  "type":"blocks",            // "blocks" | "section" (module header) | "quiz" (icon:"Quiz")
  "icon":"Article",
  "updatedAt":"<echo of the lesson's createdAt from CREATE_LESSON>",
  "bulkUpdateBlocks":{ "deletes":[], "creates":[], "updates":[], "moves":[] } }
```
Carry the source lesson's `type`, `icon`, `headerImage`, `description`, `settings`,
`media` verbatim (copy-faithful) — only ids/positions are remapped. `bulkUpdateBlocks`
is sent empty here (blocks are created separately via `CREATE_BLOCKS`).

**Lesson edit lock** (collab guard; captured, low-risk to include):
- `POST …/ducks/rise/locks/PUT_LOCK` `{id:<lessonId>, courseId}` → `{author, session,
  updatedAt, courseId, id, ttl:86400000}` (24h TTL).
- `POST …/ducks/rise/locks/DEL_LOCK` `{id:<lessonId>, courseId}` to release at the end.
- Single-author imports don't strictly need the lock (no contention), but taking it
  matches the editor and avoids a co-editor stomping a long import. Treat as
  **best-effort**: acquire before a lesson's blocks, release after; never abort on a
  lock failure.

---

## 3. Blocks — `CREATE_BLOCKS` (copy-faithful)

**`POST …/ducks/rise/lessons/CREATE_BLOCKS`**
```jsonc
{ "courseId":"<newCourseId>", "lessonId":"<lessonId>", "previousBlockId":null,
  "blocks":[ { "family":"image", "id":"<client cuid>", "type":"image", "variant":"hero",
               "items":[ { "id":"<client cuid>", …content verbatim… } ],
               "settings":{ … verbatim … } } ] }
```
- **Copy-faithful.** Each source block's JSON is written back **unchanged** except:
  (a) regenerate `id` and every nested item `id` (they are **client-generated**,
  cuid-style — see §6); (b) remap media keys (§8) and cross-refs (§4/§9); (c) drop
  server-owned fields the source carried (`globalBlockId`, `createdAt`, `updatedAt`) —
  the server assigns a fresh `globalBlockId` and returns it in `blockMetadata`.
- Response: `{success:true, blockMetadata:[{id, globalBlockId, createdAt, updatedAt}],
  courseId, lessonId, …}`. **Loud-fail** if `success !== true` or `blockMetadata[].id`
  ≠ the id we sent.
- Question blocks (inline quiz / knowledge-check) are **ordinary blocks** here — no
  bank call. Their `{type:"MULTIPLE_CHOICE"|…, answers, feedback, …}` ride inside the
  block verbatim with regenerated ids (see `rise-question-banks.md` for the schema).
- Default/placeholder media seen in the capture (`sourcedFrom:"DEFAULT"`,
  `cdn.articulate.com/assets/rise/assets/block-defaults/…`) is what a freshly-created
  media block ships with; we overwrite it via `UPDATE_BLOCK_DEBOUNCE` (§8). Blocks with
  no uploaded media (text, divider, html/inline, continue, etc.) are **done** after
  `CREATE_BLOCKS` — nothing else to do.

---

## 4. Question banks + draw-from-bank cross-ref

Two separate things: (a) recreating a reusable **bank**, (b) **linking** a block to it.

### 4a. Recreate a bank (catalog POST → authoring PUT)
1. `POST /api/rise-authoring/locks` — acquire an edit lock for the bank category:
   ```jsonc
   { "author":"auth0|…", "profile":{avatars,first_name,last_name,user_id,staff,
       content_team_admin}, "category":"questionBanks/<uuid>", "id":"<cuid>",
       "session":"<cuid>" }
   ```
   (`category` is `questionBanks/<a uuid>`; `session`/`id` are client cuids. Best-effort,
   same as lesson locks.)
2. `POST /manage/api/question-banks` `{folderId:<mapped or null>, title}` → `{id}` —
   the **new bank id** (cuid). Record old→new.
3. `PUT /api/rise-authoring/question_banks/<newBankId>`:
   ```jsonc
   { "id":"<newBankId>", "questions":[ …whole array, ids regenerated… ],
     "session":"<cuid>", "update_type":"editor",
     "lock_data":{ avatars, first_name, last_name, user_id, staff, content_team_admin } }
   ```
   - Writes the **entire** questions array (it's an autosave-style full PUT — the
     capture fired it ~18× as the demo typed; we send it **once** with the complete,
     remapped array). Response echoes the bank with `version` (starts at 1) +
     `updated_at`. Question/answer schema: `rise-question-banks.md`.
   - Regenerate every question `id` and answer `id`; fix `correct`/`corrects` to point
     at the new answer ids; remap any question `media` keys (§8, snake_case under
     `rise/questionBanks/<bankId>/…`). Keep HTML `title`/`feedback` (with
     `data-editor-id`) verbatim.
4. (Catalog cleanup seen in the capture — `DELETE /manage/api/question-banks/question-bank/<id>`
   — was the demo deleting its throwaway bank. **Not** part of import; never delete.)

### 4b. Link a draw-from-bank block — `INSERT_QUESTION_BANK_QUESTIONS`
The `knowledgeCheck / draw from question bank` block is created **empty** via
`CREATE_BLOCKS` (`items:[{id, type:"DRAW_FROM_QUESTION_BANK"}]`), then bound:

**`POST …/ducks/rise/lessons/INSERT_QUESTION_BANK_QUESTIONS`**
```jsonc
{ "lesson":{ …the FULL lesson object… , "items":[ …blocks…, {
       "family":"knowledgeCheck", "variant":"draw from question bank",
       "id":"<blockId>", "items":[{id, type:"DRAW_FROM_QUESTION_BANK"}],
       "globalBlockId":"<from blockMetadata>", "pendingItemId":"<client cuid>" } ] },
  "blockOrItemId":"<blockId>", "pendingItemId":"<same client cuid>",
  "mode":"knowledgeCheck",            // or "quiz" for a graded-quiz draw
  "drawCount":1,                       // how many questions to draw (from source block)
  "questionDrawType":"random",         // "random" | (fixed?) — copy from source
  "questionBankId":"<newBankId>",      // the MAPPED bank id
  "questionList":[ …the NEW bank's question ids… ],   // candidate pool = remapped ids
  "courseId":"<newCourseId>" }
```
- `lesson` is the current lesson **echoed back in full** (as last known), with the
  draw-from-bank block carrying a `pendingItemId` (a fresh client cuid). Build it from
  the `CREATE_LESSON`/`UPDATE_LESSON` response + the blocks created so far.
- `questionList` is the candidate pool to draw from — the **recreated** bank's
  question ids (old→new mapped). `drawCount`/`questionDrawType`/`mode` come from the
  **source** draw-from-bank block.
- ⚠️ **Source-side field names to confirm against an export fixture.** The capture
  *creates* this block fresh, so it doesn't show how `drawCount` / `questionDrawType` /
  the bank id are stored **on a source GET_COURSE block**. The block catalog records
  the cross-ref as "question-bank id" on `items[].type:DRAW_FROM_QUESTION_BANK`. Before
  shipping, read a real exported course that has a draw-from-bank block (29 exist in the
  library, `assets-summary`/census `draw-from-bank-crossref`) and confirm the exact
  field names (`drawCount`, `questionDrawType`, the stored bank id, the question subset
  if not "all"). The importer **loud-fails** if it can't locate the source bank id for a
  draw-from-bank block rather than guessing.

---

## 5. Folders (deepest-first, map old→new)

Source folders come from `account/folders.json` + `_metadata/folders-inventory.*`
(`id, name, source(course|bank), parentId, depth, path, deleted, courseCount`). The
capture did not exercise folder *creation* (it edited an existing course in place), so
the **create** call is taken from `rise-api-reference.md` / `rise-folders.md`:
- Process folders **deepest-first by `depth`** so a parent is mapped before its child
  (the child's create needs the mapped `parentFolderId`).
- Create each folder under its mapped parent; record old→new.
- Pass the mapped target folder id as `folderId` when creating courses
  (`POST /manage/api/content {folderId}`) and banks
  (`POST /manage/api/question-banks {folderId}`).
- **Skip `deleted` folders** (or only recreate if they still hold live content).
- Team/subscription scoping (`ownerPrincipalId`, `subscriptionId`, shared vs private)
  may not map 1:1 across accounts — **flag** cross-account differences for the operator
  (like Storyline reachability); don't fail the run.

> The exact folder-create endpoint/payload is **not in this capture** — confirm it on a
> live target (likely `POST /manage/api/folders {name, parentFolderId, …}`) before
> enabling folder recreation; until confirmed, the importer can place all content at the
> account root (`folderId:"all"` / null) and flag folder structure as not-yet-mapped.

---

## 6. IDs, references & the remap map

| Thing | Assigned by | On import |
|---|---|---|
| Course id | Server (`POST /manage/api/content`) | capture from response |
| Lesson id | Server (`CREATE_LESSON`) | capture from `payload.lesson.id` |
| Block id, item id | **Client** (cuid) in `CREATE_BLOCKS` | **regenerate**, keep internal refs consistent |
| `globalBlockId` | Server (`CREATE_BLOCKS` → `blockMetadata`) | capture; needed for `INSERT_QUESTION_BANK_QUESTIONS` |
| Bank id | Server (`POST /manage/api/question-banks`) | capture from `{id}` |
| Question id, answer id | **Client** (cuid) | **regenerate**; fix `correct`/`corrects` |
| Asset key / crushedKey | Server (`GET_YURL` / `CRUSH_IMAGE`) | capture; remap into the block |

- **Client ids are cuid-style** (e.g. `cmqjv8g0g002i3b7oabdf4pav`, 25 chars,
  base36-ish). Generate consistently; the importer mints a fresh id per source id and
  records the mapping so **internal `refs`** stay valid. `refs` paths are
  `items:<itemId>/items:<subItemId>` (used by `TRANSCODE_ASSET`/`uploadId`) — rebuild
  them from the **new** ids.
- HTML content carries `data-editor-id`, custom-font classes (`mighty-type-style-*`),
  and theme CSS variables — **preserve verbatim**; they stay valid as long as the same
  typeface ids + theme are used (which the theme round-trip guarantees, §7).
- **Resumable job log.** Persist the whole old→new map (folders, banks, questions,
  course, lessons, blocks, asset keys) to storage as the import runs. On resume, a
  source id already in the map is skipped — so a terminated worker / retry never
  double-creates. This is the import analogue of the export's resume.

---

## 7. Course shell + theme

1. **Create shell** (ref `rise-api-reference.md` §4.1; not re-exercised in this
   capture): `POST /manage/api/content {createBookmark:false, folderId:<mapped>}` →
   `{id:"<newCourseId>"}`.
2. **Theme round-trips verbatim.** `POST …/ducks/rise/courses/UPDATE_COURSE`
   `{id:newCourseId, theme:<source course.theme object>}`. The capture's
   `UPDATE_COURSE` **response** shows the full theme shape echoed (themeId, colorAccent,
   blockCorners, the three typeface ids, navigationType, cover/header images, paddings,
   `headingTypefaceId`/`bodyTypefaceId`/`uiTypefaceId`, `features`, `typefaces` map) —
   read `source.course.theme` and POST it straight back. Built-in cover/header images
   are `cdn.articulate.com/…` / `articulateusercontent.com/assets/rise/…` URLs —
   **referenced, not re-uploaded**.
3. **Scalar fields** (title, etc.): `UPDATE_COURSE_FIELD {id, field, value}` (ref §4.2)
   — single-field updates. (`UPDATE_COURSE` also accepts a `{jobs:[…]}` payload to
   register transcode jobs, §8 — same envelope, different field.)
4. **Typefaces / theme constants** are account/subscription-level — reuse the **same
   ids** rather than recreating (the export captured custom typefaces incl. font files
   for reference; provisioning custom fonts on the target is a manual/account step).

> ⚠️ The theme's `headingTypefaceId`/`bodyTypefaceId`/`uiTypefaceId` reference
> **account-level** typeface ids. If the target account doesn't have the same custom
> typefaces, those ids won't resolve — flag a typeface mismatch (like Storyline
> reachability) rather than silently shipping a broken font reference. Built-in fonts
> (Lato, Merriweather, …) map fine.

---

## 8. Asset upload chain (image vs a/v)

Trigger: a block (or question) carries an **uploaded** media key (`rise/courses/<id>/…`
or `rise/questionBanks/<id>/…`). The bytes come from the archive's content-addressed
`assets/` store via the per-owner `*.assets.json` manifest (source key → `{hash, ext,
file}`). Do this **after** the block exists.

**Common head:**
1. `POST …/ducks/rise/uploads/GET_YURL`
   `{assetPath:"courses/<newCourseId>", courseId:<newCourseId>, filename:<original display name>}`
   → `{key:"rise/courses/<newCourseId>/<server-random>.<ext>", type:"<mime>",
       filename:"<server-random>.<ext>", url:"<presigned S3 PUT>"}`.
   - **The server picks a fresh random key/filename.** The request `filename` is just a
     display/original hint (e.g. `13.jpg`, or a url-encoded unicode name); the response
     `key` is the canonical new key to remap into the block. `assetPath` is
     `"courses/<courseId>"` (NOT `"rise/courses/…"`).
2. **S3 PUT the raw bytes** to `url`: plain `PUT`, `Content-Type` = the returned `type`,
   **no `Authorization`** (the signature + `x-amz-acl=public-read` are query params in
   the presigned url). Returns `200`. Host is `articulate-us.s3.amazonaws.com` on US (it
   comes back in `url`, so it auto-follows the plane).

**Image tail:**
3. `POST …/ducks/rise/uploads/CRUSH_IMAGE` `{courseId, original:"<the GET_YURL key>"}`
   → `{courseId, original, key:"<crushedKey>"}` (the compressed delivery key).
4. `POST …/ducks/rise/lessons/UPDATE_BLOCK_DEBOUNCE` patches the block's media:
   ```jsonc
   { "id":"<blockId>", "courseId":"<newCourseId>", "lessonId":"<lessonId>",
     "item":{ …the full block…, "items":[{ …, "media":{ "image":{
         "key":"<GET_YURL key>", "crushedKey":"<CRUSH_IMAGE key>",
         "type":"image", "useCrushedKey":false, "isSkipCrush":true,
         "sourcedFrom":"USER", "dimensions":{originalWidth,originalHeight},
         "originalUrl":"<display name>" } } }] } }
   ```
   (`UPDATE_BLOCK_DEBOUNCE` is the autosave-coalesced variant; `UPDATE_BLOCK` is the
   immediate form — either works when scripting. The capture used the debounce form.)

**Audio / video tail:**
3. `POST …/ducks/rise/uploads/TRANSCODE_ASSET`
   ```jsonc
   { "courseId", "key":"<URL-ENCODED GET_YURL key>", "lessonId",
     "mediaType":"audio",            // "audio" | "video"
     "original":"<the original filename, decoded unicode ok>",
     "refs":"items:<blockId-or-itemId>/items:<subItemId>",
     "uploadId":"<lessonId>-<refs>" }
   ```
   → `{jobId:"<ts>-<rand>"}`. **Note `key` is URL-encoded** here (unlike `CRUSH_IMAGE`).
4. `POST …/ducks/rise/courses/UPDATE_COURSE` `{id:<newCourseId>, jobs:["<jobId>"]}` —
   registers the transcode job on the course.
5. Poll `POST …/ducks/rise/uploads/CHECK_STATUS` `{jobs:["<jobId>"], courseId}` until the
   job reports done (capture shows `{jobs:[], …}` → `[]` when idle; a live job returns
   the job's status — poll human-paced until complete, then `RESOLVE_ASSET` resolves the
   `transcoded-…` key per `rise-api-reference.md` §5).
6. `UPDATE_BLOCK_DEBOUNCE` patches the block's `media.audio`/`media.video` with the new
   key (and the resolved transcoded key) — same shape as the image patch.

**Invariant — no source key survives.** After patching, re-scan the rebuilt course
document for any `rise/courses/<OLD id>/…` or `rise/questionBanks/<OLD id>/…` key. If
any source key remains, **abort + report** (CLAUDE.md: "no source media keys may
survive"). CDN (`cdn.articulate.com`) + embeds (YouTube/Vimeo) are kept as-is.

**Orphaned media.** Keys flagged `orphaned` in `_metadata/assets-summary.json` (403/404
= deleted at source) have **no bytes** to upload. Don't fail the run — **flag** the
referencing block (with its recorded `lessonTitle / family/variant / blockId` from
`core/assets/locate.ts`) for manual handling and skip its upload.

**Media NOT on a content block (course/lesson/theme/bank).** The capture only shows
uploading media that attaches to a content block (`UPDATE_BLOCK_DEBOUNCE`). It does
**not** show how to (re)upload a course **cover/card** image, a **lesson header**
image, a custom **theme** image, or **question-bank** question media — those write
paths are uncaptured. So the importer treats them like orphans: **flag** each for
manual handling and **blank** its uploaded key in the payload (theme/lesson) so a dead
source key is never written. (Built-in `cdn.articulate.com` / `…/assets/rise/…` theme
images are kept verbatim — they're not `rise/courses/<id>/…` uploads.) The final
invariant then asserts every *remaining* uploaded key belongs to a **target** owner
(new course / new bank id); a key under any other owner that isn't flagged is a
loud-fail. Confirm the cover/header/bank upload envelopes on a live target to promote
these from flagged to migrated.

---

## 9. Storyline / Mighty (conditional — flag, don't fail)

A storyline block is created **empty** via `CREATE_BLOCKS`
(`{family:"360", type:"interactive", variant:"storyline", items:[{id}]}` — confirmed in
the capture, no media). Its content (`items[0].media.storyline = {src, meta{stage,
title, player, scenes, slides, version, course_id, thumbnail}}`, src =
`rise/courses/<id>/<pkg>/story.html`) can **only** come from a published **Review 360
item** — there is no `.story` upload in Rise.

- **Recreatable only if** the target account reaches the same Review 360 item (same 360
  org/team). Flow: `GET api.articulate.com/review/items?…productFilter=storyline`,
  match by `project_id`/`title`, select it → Rise re-copies the bundle and sets
  `media.storyline`. (The capture shows an `unzip` PUT to a
  `rise-frontend-sandbox-*.s3…/unzip/<uuid>.zip` bucket — the package-ingest plumbing;
  it is **not** a public, reproducible upload path and is out of scope.)
- **If unreachable → flag for manual handling**, don't fail the course. **Mighty** is
  treated identically (storyline-variant block + Review item flagged `mighty_bundle`,
  empty package); target needs the Mighty plugin provisioned.

---

## 10. Block templates (out of scope for copy-faithful)

The capture also shows `FETCH_BLOCK_TEMPLATES` → `INSERT_BLOCK_TEMPLATE`
`{blockTemplateId, lessonId, courseId, itemIndex, updatedAt}` — inserting a **saved
team-library template** by id at a position. This is an authoring convenience, **not**
needed for migration: we recreate the resulting blocks faithfully via `CREATE_BLOCKS`,
so block templates are reference-only (account-level feature; the template id wouldn't
exist on the target anyway). Don't use `INSERT_BLOCK_TEMPLATE` in the importer.

---

## 11. Safe-import gates (required UX, enforced before any write)

1. **Write mode is never the default.** A distinct Import/write-mode entry, separate
   from the read-only export panel.
2. **Target-account confirmation gate.** Before any write, show the live tab's identity
   (account name from the header) + US/EU plane; the operator must confirm "write into
   THIS account".
3. **Source ≠ Target guard.** Read the source identity from the archive's
   `manifest.json`; refuse to write into the same account/plane unless explicitly
   overridden (prevents re-importing into the source).
4. **Archive stays read-only.** Derive the target payload from a **copy** of each source
   doc; never mutate `courses/*.json` etc.
5. **Dry-run plan preview.** Default to DRY-RUN: produce the full ordered plan (every
   envelope it *would* send, with remapped ids) and a fidelity preview **without
   issuing writes**. A live run is a second, explicit step.

---

## 12. Loud-fail on unexpected write responses

Every write asserts its response shape and **aborts the course** (with the exact
envelope + raw response) on a mismatch — never ships a half-written course silently:
- `CREATE_LESSON` → `payload.lesson.id` present.
- `CREATE_BLOCKS` → `success:true` and each returned `blockMetadata[].id` equals the id
  we sent.
- `GET_YURL` → `key` + `url`; S3 `PUT` → HTTP 200.
- `CRUSH_IMAGE`/`TRANSCODE_ASSET` → `key`/`jobId` present.
- bank `PUT` → echoed bank with `version`.
- Any `4xx`/`5xx` (other than the one-shot `401`-refresh-retry) → abort + report.
- Final assertion per course: **no source media key survives** (§8) and every old→new
  mapping the plan declared got fulfilled.

---

## Appendix — captured envelope index (US, `http_api.jsonl`)

| idx | call | role |
|---|---|---|
| 44, 79 | `POST /api/rise-authoring/locks` | bank edit lock |
| 66 | `POST /manage/api/question-banks` | create bank → `{id}` |
| 82–105 | `PUT /api/rise-authoring/question_banks/{id}` | write questions (full array, autosave ×N) |
| 125 | `DELETE /manage/api/question-banks/question-bank/{id}` | demo cleanup (NOT import) |
| 165 | `CREATE_LESSON` | new lesson; server lessonId |
| 166 | `UPDATE_LESSON` | set type/icon |
| 168 / 296 | `PUT_LOCK` / `DEL_LOCK` | lesson edit lock acquire/release |
| 180, 186, 230, 253, 266, 270, 285, 286, 288 | `CREATE_BLOCKS` | one block each (chained `previousBlockId`) |
| 183 | `INSERT_QUESTION_BANK_QUESTIONS` | bind draw-from-bank block → bank + question list |
| 201 / 214 | `GET_YURL` | presigned S3 PUT (image / audio) |
| 203 / 217 | S3 `PUT` | raw bytes upload (200) |
| 204 | `CRUSH_IMAGE` | image → crushedKey |
| 218 | `TRANSCODE_ASSET` | audio → jobId |
| 220, 222 | `UPDATE_COURSE` | register `jobs:[…]` |
| 205, 219, 223, … | `UPDATE_BLOCK_DEBOUNCE` | patch block media with new key |
| 147 | `CHECK_STATUS` | poll transcode jobs |
| 243 / 246 | `FETCH_BLOCK_TEMPLATES` / `INSERT_BLOCK_TEMPLATE` | template insert (out of scope) |
| 279 | S3 `PUT …/unzip/<uuid>.zip` | storyline package ingest plumbing (out of scope) |
| TRACK, socket.io, lifecycle/refresh | — | analytics / collab / auth — never replayed as writes |
