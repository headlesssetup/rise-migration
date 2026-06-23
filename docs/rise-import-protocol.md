# Rise Import / Recreation Protocol (the write side)

> **Authoritative, capture-derived.** Reverse-engineered from a US write-path mitm
> session (`http_api.jsonl`, 334 envelopes — a live edit of an existing course plus
> a throwaway question-bank lifecycle). Companion to `rise-api-reference.md` (which
> covers the read side and the high-level recreate sketch in §4–§9). **Never infer
> the write API from memory — this file + the captures are the source of truth.**
>
> **Plane.** Hosts below are the **US** plane (`rise.articulate.com`,
> `articulate-us.s3.amazonaws.com`, `articulateusercontent.com`, `id.articulate.com`).
> URLs to `rise.articulate.com` are issued **relative** so they ride whichever Rise
> tab is open (US or EU). The two **absolute** hosts that differ on EU — the S3
> upload bucket and the usercontent read host — come back **inside** the `GET_YURL`
> response (`url`, `key`), so the upload target is server-dictated, not hard-coded.
>
> **EU plane — now captured & validated** (`2390d5ff-capture.mitm`):
>
> | role | US | EU |
> |---|---|---|
> | Rise authoring | `rise.articulate.com` | `rise.eu.articulate.com` |
> | account API | `api.articulate.com` | `api.eu.articulate.com` |
> | S3 upload bucket (from `GET_YURL.url`) | `articulate-us.s3.amazonaws.com` (SigV2) | `360-prod-eu-central-1-213152736482.s3.eu-central-1.amazonaws.com` (**SigV4**) |
> | usercontent (read) | `articulateusercontent.com` | **`articulateusercontent.eu`** (`.eu` TLD) |
> | CDN | `cdn.articulate.com` | `cdn.eu.articulate.com` |
> | auth (Okta) | `id.articulate.com` | `id.articulate.com` (**global**) |
>
> **Key validation:** every EU authoring envelope is **byte-identical** to US —
> `CREATE_LESSON`, `CREATE_BLOCKS`, `CRUSH_IMAGE`, `GET_YURL`→S3 PUT,
> `UPDATE_BLOCK_DEBOUNCE`, `PUT_LOCK`/`DEL_LOCK`. Relative URLs + the
> GET_YURL-returned host make the importer genuinely plane-agnostic.
>
> ⚠ **S3 PUT must echo `x-amz-acl: public-read` (font uploads).** Earlier notes
> claimed the `x-amz-acl=public-read` in the presigned query was enough and the
> header could be omitted (S3 returned 200 either way). That is FALSE for **font**
> uploads: a PUT without the header returns 200 but stores the object **private**,
> so the directly-served `.woff` later **403s** and Rise marks the typeface
> **`inactive`** (root cause of dozens of dead imported typefaces). The SigV4
> `SignedHeaders=host;x-amz-acl` means the client MUST send the header. Fix: send
> `x-amz-acl` whenever the presigned url signs it (`s3PutHeaders` in
> `import-shared.ts`) — signature-safe, and a no-op for urls that don't sign it.
> Fonts are the visible victim because the `.woff` is served straight from the
> uploaded bytes (no CRUSH/TRANSCODE in our import, §8); any asset served the same
> way needs the same ACL.

---

## 0. Transport (same as the read side)

- Every `rise.articulate.com` call is `POST .../api/rise-runtime/ducks/rise/<domain>/<ACTION>`
  with body `{type:"rise/<domain>/<ACTION>", payload:{…}}`, **or** a REST call under
  `/manage/api/*` / `/api/rise-authoring/*`. Bearer JWT on every call; `Content-Type:
  application/json` for bodies. Calls run **inside the live Rise tab** (first-party
  cookies) exactly like the export path.
- **Auth refresh.** The capture shows `POST id.articulate.com/api/v1/sessions/me/lifecycle/refresh`
  (→204) firing constantly between writes, and one `POST id.articulate.com/oauth2/default/v1/token`.
  The bearer is short-lived (~15 min). ⚠ On a long import it expires mid-run and the
  **authoring endpoints answer an expired token with `403 Forbidden`, NOT `401`** —
  observed as `GET_YURL … HTTP 403 — body: Forbidden`. So **re-auth on BOTH `401` and
  `403`**: hit the refresh endpoint, then **re-read the rotated `_articulate_rise_`
  cookie** (during an import there's no page traffic for the webRequest observer to
  catch the new bearer), and retry once. Also refresh **proactively** when the held
  token is within ~60s of `exp`, so a long run never trips the 403 at all.
  ⚠ **Refresh on demand, not only near `exp`.** Observed failure: a DRY-RUN preview
  succeeded but the LIVE run 403'd on the **first** ducks write of **every** course
  (`UPDATE_COURSE_FIELD_THROTTLE`, then `CREATE_LESSON … HTTP 403 — body: Forbidden`)
  right after the cookie-auth `POST /manage/api/content` shell create succeeded — the
  REST shell create rides first-party cookies, but the bearer had gone stale while the
  panel sat idle, and the reactive 401/403 retry alone didn't recover it in time. Fix:
  the panel forces a refresh (`REAUTH`: refresh session → re-read cookie) **at run
  start AND before each course** (operations A/B/C all refresh at start), so every
  course begins with the full ~15 min window instead of inheriting the prior course's
  near-dead token. The reactive retry stays as a backstop.
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
UPDATE_COURSE_FIELD {id, field:"title", value}       # title FIRST — materializes the draft (see ⚠ below)
# (theme comes AFTER the lessons — see ⚠ ordering rule 0b)

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
            for each media key on the block (original, crushedKey, poster, caption):
                {key,url,type} = GET_YURL {assetPath:"courses/"+newCourseId,
                                           courseId:newCourseId, filename}
                PUT bytes -> url   (Content-Type:type; + header x-amz-acl:public-read
                                    when the url signs it — required or object is private)
                # NO CRUSH_IMAGE / NO TRANSCODE_ASSET — upload the EXACT exported
                # bytes (Rise already crushed/transcoded at author time; every
                # variant key is its own upload + remap). See §8.
                UPDATE_BLOCK_DEBOUNCE {id:blockId, courseId, lessonId,
                                       item:<block with media.{image|video|audio}.key
                                             (and crushedKey) set to the NEW key>}   # §8
        if block is storyline / mighty:                # §9 — conditional, flag manual
            … only if target reaches the same Review 360 item; else SKIP + flag

    DEL_LOCK {id:lessonId, courseId}                   # release the lesson lock

UPDATE_COURSE {id:newCourseId, theme, …typefaceIds}   # theme LAST — needs a lesson (§7, rule 0b)
```

> **Ordering rules that matter (from the capture):**
> 0. ⚠ **Create is ATOMIC — then `GET_COURSE` to confirm (mirror the editor).**
>    ✅ **Capture-confirmed** (`docs/rise-mitm-sample-new-course.md`, EU New-Course
>    recording): a **single** `POST /manage/api/content {createBookmark:false,
>    folderId:"all"[,type]}` creates a **fully-materialized** course — the editor opens
>    and `GET_COURSE` returns it **200 immediately** (classic theme, a random built-in
>    `cdn…/themes/classic/cover-image/*.jpg` cover, `title:""`, `lessons:[]`). **A bare
>    titleless/lessonless shell is a VALID, dashboard-safe course** — there is **no**
>    separate "materializing write". So: right after the POST, **`GET_COURSE` the new
>    id before any write** (the editor always does); if it doesn't return a `course`,
>    abort + `soft-delete` (the shell is broken). Title/description (`UPDATE_COURSE_FIELD_THROTTLE`)
>    are just the editor's debounced typing; theme comes after a lesson (rule 0b).
>    The earlier "never-born phantom" theory was **wrong about the mechanism**: a
>    `GET_COURSE`-404 / `content/search`-500 row is a **partial delete** artifact
>    (a soft/hard-delete that 500'd mid-op), NOT an incomplete create. We keep the
>    post-create handshake + a `soft-delete` rollback of an *unconfirmed* shell as a
>    cheap backstop; we do **not** build phantom-repair. See `core/import/executor.ts`
>    (create-course handshake, `rollbackShell`).
> 0b. ⚠ **Theme AFTER a lesson exists.** Rise rejects theming a lesson-less course
>    ("add a lesson to your course before theming"). The original capture themed an
>    *existing* (already-populated) course, so it shows theme-before-lessons — but
>    for a NEW course the `UPDATE_COURSE {theme}` must come **after** at least one
>    `CREATE_LESSON`. We apply it once, course-level, after the lessons loop.
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
> 4. **Lessons in `course.lessons` ORDER (the ordered id list) — NOT the objects
>    array order, NOT `position`.** Both were observed to scramble a real course;
>    `course.lessons` is authoritative (§2). Create in that order with a sequential
>    0-based slot (idx); `CREATE_LESSON` honors it, so no reorder pass is needed.
> 5. **NO transcode / NO crush on import.** We upload the EXACT exported asset bytes
>    (`GET_YURL`→S3 PUT) and remap keys — Rise already crushed/transcoded at author
>    time, so re-processing only recompresses + drifts. `CRUSH_IMAGE`/`TRANSCODE_ASSET`/
>    `CHECK_STATUS`/`RESOLVE_ASSET`/`UPDATE_COURSE{jobs}` are documented but unused.
>    ✅ **Capture-confirmed** (`rise-mitm-sample-edit-media-theme.md`): the editor DOES
>    call `CRUSH_IMAGE`/`CROP_IMAGE` for images — we skip them and re-upload the
>    source `key`+`crushedKey` verbatim (same end state). A **video uses NO
>    `TRANSCODE_ASSET`** (0× in the capture) — `GET_YURL`→S3 PUT→`CHECK_STATUS`, and its
>    **poster/thumbnail is an `images[.eu]` transform URL over the uploaded key**, so
>    re-uploading + remapping the key(s) (incl. inside transform URLs) is sufficient.

---

## 2. Lessons — `CREATE_LESSON`, `UPDATE_LESSON`, locks

**`POST …/ducks/rise/lessons/CREATE_LESSON`**
```jsonc
// req.payload
{ "author":"auth0|…", "selectedAuthorId":"auth0|…",
  "courseId":"<newCourseId>", "position":5, "title":"remaining types", "type":null }
```
`author`/`selectedAuthorId` = the importing account's user id. `type` is sent **null**
here and set on the follow-up `UPDATE_LESSON`. Response returns `payload.lesson.id` —
the **server-assigned lessonId** (record it old→new).

⚠ **DISPLAY ORDER = `payload.course.lessons` — an ORDERED ARRAY OF LESSON IDS** on the
course object (✅ capture-confirmed: `"lessons":["7dqd…","_mAVG…",…]`). This is the
authoritative order — **NOT** the top-level `lessons[]` objects array order, and **NOT**
the `position` field (both scrambled a real course). Order the source lesson objects by
this id list, then **create each at its sequential slot** (`position: 0,1,2,…`).
✅ **`CREATE_LESSON` honors `position`**, so creating in the right order needs no reorder
pass. **Fallback (unused):** `courses/UPDATE_LESSON_ORDER {course:{from, lessonId, to,
courseId}}` reorders one lesson; `lessons/DELETE_LESSON {id, position, courseId}` removes
one. (For a future cleanup tool — not part of import.)

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

⚠ **Lesson header / lesson media (uploaded keys).** A `headerImage`/`media` that
carries an **uploaded** key (`rise/courses/<srcId>/…`) is now re-uploaded like block
media: the importer runs `GET_YURL → S3 PUT` for the header bytes **before**
`UPDATE_LESSON` (an `upload-lesson-media` step), then sends the lesson with the key
**remapped** to the new target key (any un-uploaded/oversize/orphan lesson media is
blanked so no dead source key survives). Built-in `cdn.…`/`assets/rise/…` header
images stay as references. The `GET_YURL→S3 PUT` upload is capture-confirmed; the
`UPDATE_LESSON {headerImage:<new key>}` write shape still wants a live confirmation.

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
- **Batch a whole lesson's blocks in ONE `CREATE_BLOCKS` (ordering fix).** ✅
  Confirmed on a live US→EU import: creating blocks **one-at-a-time** with
  per-call `previousBlockId` chaining — interleaved with the media upload calls —
  **mis-ordered larger lessons** (the lesson's last few blocks landed near the
  top, shifting the rest). Send the lesson's blocks as a **single ordered array**
  (`previousBlockId:null`, `blocks:[b0,b1,…]`) — a single array insert preserves
  order deterministically and is the editor's multi-block-paste path. Do the media
  uploads + `UPDATE_BLOCK_DEBOUNCE` patches **afterward, addressed by block id**
  (order-independent). Map the returned `blockMetadata` back **by `id`**, not by
  position (the response order isn't guaranteed).
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
2. `POST /manage/api/question-banks` `{folderId:null, title}` → `{id}` — the **new
   bank id** (cuid). Record old→new. ⚠️ **Confirmed live:** `folderId` must be
   `null` (or a real *bank*-folder id) — passing the course-content `"all"`
   sentinel **500س**. Banks have their own folder namespace.
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
`CREATE_BLOCKS` (`items:[{id, type:"DRAW_FROM_QUESTION_BANK"}]`). Binding it to a
bank is **optional and OFF by default** (`recreateBanks`): a course import should
not silently spawn banks in the target account. By default the empty block is
left as an **unbound placeholder** and flagged for manual handling (same posture
as Storyline/Mighty). Only when bank recreation is explicitly enabled do we run
§4a + the bind below:

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
3. **Title.** ⚠️ **Confirmed live:** the `rise/courses/UPDATE_COURSE_FIELD` ducks
   action **404s** (doesn't exist) — the old §4.2 guess was wrong. The title is
   set through the general `UPDATE_COURSE {id, title}` envelope (the action that
   exists). Treat as **best-effort**: the title may actually be a *catalog*-side
   field (`manage/api/content`) with an uncaptured rename call, so never abort the
   course import if it doesn't take — flag it and let the operator rename. Capture
   the real rename call on a live target to make it authoritative.
   (`UPDATE_COURSE` also accepts `{jobs:[…]}` to register transcode jobs, §8.)
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

## 10a. Typography & custom fonts (theming) ✅ captured

**Typeface ids are account-specific** — even built-ins: each account has its own id
for "Lato". A migrated course's theme references the *source* account's
`headingTypefaceId`/`bodyTypefaceId`/`uiTypefaceId`, which don't resolve on the
target → **wrong (default) font**. Two facts from the theming capture:

- **The authoritative typeface ids are TOP-LEVEL on the course**, set via
  `UPDATE_COURSE {id, headingTypefaceId, bodyTypefaceId, uiTypefaceId, theme}`
  (the theme object carries its own copies too — set both).
- **`FETCH_TYPEFACES`** → `{typefaces:[{id, name, default, deleted,
  fonts:[{key, style, original}]}]}`. Built-ins have `default:true` + keys under
  `assets/rise/fonts/…` (shared, universal); custom fonts have `rise/fonts/…`
  keys + an `original` filename.

> ⚠ **`FETCH_TYPEFACES` needs an EXISTING course id.** Calling it with a
> just-created course id 404s (`NotFoundError`) — the new course hasn't settled
> as a valid typeface context yet. So fetch the target's typefaces **once, up
> front, against a live existing course** (page-0 of the target library via
> `SEARCH_COURSES`) and reuse that map for every course in the run — never
> against the course we're building.

**Migration algorithm (by NAME, with recreate):**
1. `FETCH_TYPEFACES` on the **target** (an *existing* course id) → `name → id`.
2. For each typeface the course uses, look up its **source name** (from the
   exported `account/typefaces.json`):
   - target has that name → **reuse the target id** (covers built-ins AND a brand
     font already uploaded — natural **dedup** across courses/re-runs);
   - else, custom font missing on target → **recreate**.
3. **Recreate a custom font:** for each font file, `GET_YURL {assetPath:"fonts/",
   courseId, filename}` → S3 PUT the `.woff` bytes → then
   `CREATE_TYPEFACE {name, fonts:{ "typeface-<style>": {id, key, type, filename,
   url, original, style, status:"complete", progress:100}, … }}` → returns the
   new **typeface id**. (Font bytes come from the archive's `assets/` via the
   `account/typefaces.assets.json` key→file map the exporter now writes.)
4. Remap the theme's typeface ids + send the top-level ids (step above). A font
   that can't be matched or recreated (no archived bytes) is **flagged** `typeface`.

**Course cover / card image** (the remaining course-level media): upload via the
normal chain (`GET_YURL {assetPath:"courses/<id>"}` → S3 PUT → `CRUSH_IMAGE`),
then `UPDATE_COURSE {id, coverImage:{media:{image:{key, crushedKey, dimensions,
sourcedFrom:"USER", useCrushedKey:false, originalUrl}}}, cardImage:{…|{}}}`.
Built-in theme cover/header images stay as `cdn.…/assets/rise/…` references.

---

## 10b. Folders & shortcuts (catalog) ✅ captured

**Folders** (`/manage/api/folders`) — captured CRUD:
- **Create:** `POST /manage/api/folders {name, parentFolderId, permissions?}` →
  `{id, folderType, parentFolderId, ownerPrincipalId, subscriptionId, roleId, …}`.
  - A folder's owner ACL is `permissions:[{principalId, principalType:0, roleId:3,
    profile:{user_id}}]` (the creating user as owner).
  - ⚠ **A folder MUST have an owner.** Creating one with **no** `permissions`
    leaves it owner-less, which then **500s the content service ACCOUNT-WIDE** —
    `getContent({folderId})`, `content/search`, even `PATCH .../permissions`
    itself all return `{"status":500}` (the content/folder join NPEs on the null
    owner). It is NOT recoverable in place (the repair PATCH 500s too) — the only
    fix is to **delete** the owner-less folders. So **never create one owner-less**:
    set the owner in the create call.
  - ⚠ **The owner `principalId` must be the ACCOUNT-LOCAL user id**, NOT the token
    `sub`/`aid`. The bearer's `sub` is the global **Okta** subject (e.g.
    `auth0|5c5c…`); the account-local Rise user id is in the **`_articulate_user_id`
    cookie** (e.g. `auth0|671e…`). On a cross-plane session they differ, and
    sending the Okta subject is rejected `400 {"message":"Error creating folder
    with permissions - Invalid users"}`. Read `_articulate_user_id` (Cookies API)
    and use that as the principal.
  - **How we do it:** include the owner `permissions` in the **create call**
    (`POST /manage/api/folders {name, parentFolderId, permissions:[owner]}`) so a
    folder is born owned — never owner-less. (Sharing with OTHER team members
    stays a manual step.)
- **Delete (cleanup):**
  - Course: two captured **batch** steps — **`POST /manage/api/content/soft-delete
    {ids:[…]}`** moves courses to the bin (200 echoes `{ids}`), then **`POST
    /manage/api/content/hard-delete {ids:[…]}`** permanently removes them (must be
    soft-deleted first). The purge chains soft → hard. ⚠ There is **no `DELETE
    /content/{id}`** (405).
  - Folder: `DELETE /manage/api/folders/{id}` (conventional; not yet capture-
    confirmed). Used by the purge action to undo owner-less folders from a bad run.
  - There are **two roots** (both `isRoot:true`): a **shared** root and a
    **private** root. A top-level folder's `parentFolderId` is the matching root
    id; nested folders use their parent's id.
- **Move (reparent):** `PATCH /manage/api/folders/{id}/move {parentId}`.
- **Permissions:** `PATCH /manage/api/folders/{id}/permissions {permissions:[…]}`.
- **Move a course into a folder:** `PATCH /manage/api/content/{courseId}/move`
  with the **folder id as a bare `text/plain` body** (not JSON).

**Recreation algorithm:** read the source `account/folders.json`; `GET
/manage/api/folders` on the **target** to find its two root ids by `folderType`;
create source folders **parent-first** (top-level → matching target root;
nested → mapped parent), set the account-local owner on each (see the owner
caveat above), recording old→new; then for each imported course,
`PATCH content/{newCourseId}/move` to its
**mapped** folder id (course→source-folderId comes from `_metadata/inventory.*`,
not `GET_COURSE`). Team/subscription scoping may not map 1:1 — flag mismatches.

## 10c. Shortcuts = bookmark-groups (dashboard collections)

"Shortcuts" are **bookmark-groups** — user dashboard collections of pinned
courses (NOT folders). Captured ops:
- **Create:** `POST /manage/api/bookmark-groups {author, name}` → `{id, …}`.
- **Rename:** `PATCH /manage/api/bookmark-groups/{id} {id, name}`.
- **Delete:** `DELETE /manage/api/bookmark-groups/{id}`.
- A **bookmark** = a pinned item `{id, itemId:<courseId>, itemType:"course",
  bookmarkGroupId}`; assign to a group via `POST /manage/api/bookmarks/{id}/move
  {id, bookmarkGroupId}`.

Recreation (optional, lower priority): recreate the groups (`POST`), then for
each bookmarked course create/move a bookmark referencing the **new** course id.
User-scoped and dashboard-only — migrate after folders if wanted.

## 10d. Operation decomposition (A → B → C) + cross-step id maps

The import UI is split into **three independent, ordered operations**, each with
its own dry-run + live run. They share state through small id-map artifacts under
`_import/` so they can run in sequence (even across sessions) without redoing work:

- **A — Account settings:** folder tree (§10b) + custom fonts (§10a), account-level.
  Persists `_import/account.idmap.json` = `{ folders: {srcFolderId: tgtFolderId},
  typefaces: {srcTypefaceId: tgtTypefaceId} }`. Fonts are matched-by-name +
  recreated **once** (a typeface is an account resource — not per course).
- **B — Question banks:** create selected banks standalone (`POST` bank → `PUT`
  questions, copy-faithful with regenerated ids). Persists
  `_import/banks.idmap.json` = `{ srcBankId: { newBankId, questionIds:[…new ids…] } }`
  (merged across runs). Bank-question media stays flagged (not re-uploaded).
- **C — Courses:** the per-course sequence in §1, but it **consumes** A's maps
  (place into the mapped folder; apply the pre-resolved typeface ids — no
  per-course font upload) and B's map (**auto-bind** each draw-from-bank block to
  its imported bank via `INSERT_QUESTION_BANK_QUESTIONS` with the persisted
  `questionList`). A draw-from-bank block whose bank wasn't imported in B stays an
  unbound placeholder. If A wasn't run, C falls back to creating folders inline +
  resolving fonts per course (back-compat).

## 10e. Capture additions (2026-06 — `9e532fc5`)

- **Video block** `family:multimedia, variant:video` → `items[].media.video`:
  ```jsonc
  { "key":"rise/courses/{id}/{vid}.mp4", "type":"video", "filename":"…",
    "poster":"https://images[.eu].articulate.com/f:png,w:1920,…/rise/courses/{id}/{poster}.jpg",
    "thumbnail":"https://images[.eu].articulate.com/f:jpg,w:100,h:100,…/rise/courses/{id}/{poster}.jpg",
    "captions":[ {"code":"pl","name":"Polish","key":"rise/courses/{id}/{cap}.vtt","isAiGenerated":true}, … ] }
  ```
  - `poster`/`thumbnail` are **`images[.eu].articulate.com` transform URLs** wrapping a
    **separate crushed image key** (`rise/courses/{id}/{poster}.jpg`). The editor makes
    it by uploading a frame PNG (`GET_YURL`→PUT) then `CRUSH_IMAGE {courseId,
    original:"…/{frame}.png"}` → `{key:"…/{poster}.jpg"}`.
  - **Captions** are separate `.vtt` keys (one per language; AI auto-captions add a
    second). Uploaded via `GET_YURL`→PUT (no crush/transcode).
  - **Copy-faithful coverage:** the generic scan already collects the video key, the
    poster key (from inside the transform URL), and every caption `.vtt` key as media,
    and `remapMediaKeys` swaps them in place (incl. inside the transform URLs). So
    poster + captions round-trip without per-field code. (Test:
    `collectAssetKeys — video poster + captions`.)
  - ⚠ **The captured video upload does NOT transcode** — direct `GET_YURL`→S3 PUT→
    `UPDATE_BLOCK_DEBOUNCE`, with `media.video.isSkipCrush/skipProcess` editor flags.
    Our importer currently `TRANSCODE_ASSET`s video; revisit whether transcode is
    needed (likely only for non-mp4 / large sources).
- **Microlearning = a course with `type:"onePage"`.** `POST /manage/api/content
  {createBookmark:false, folderId, type:"onePage"}` → `{id}`. A normal course omits
  `type` (defaults to a multi-lesson course). Single-lesson in the UI, same API.
- **Delete a typeface:** `POST …/ducks/rise/typefaces/DELETE_TYPEFACE {id, courseId}`
  → 200 (echoes the course's remaining typeface ids). Needs a live courseId. (Lets a
  cleanup/purge remove typefaces this tool created.)
- **Quiz-bank folders are SEPARATE from course folders.** They live in the
  `GET /api/rise-authoring/question_banks` response under `private_folders` /
  `shared_folders` (NOT `GET /manage/api/folders`, which is courses). A bank
  references one via `folder_id`. We export both trees (merged in
  folders-inventory); recreating bank folders on import isn't built yet (banks are
  created at the bank root, `folderId:null`).

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
- Any `4xx`/`5xx` (other than the one-shot `401`/`403` re-auth-retry) → abort + report.
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
