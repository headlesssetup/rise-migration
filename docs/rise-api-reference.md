> **Package note.** This is the authoritative API reference for the tool, reverse-engineered via mitm. It captures the **US plane** (`rise.articulate.com`, `articulate-us.s3`, `articulateusercontent.com`, Okta at `id.articulate.com`). The **EU-plane hosts** (Rise EU domain, EU S3 bucket, EU usercontent domain, EU auth) are not yet captured — confirm them on the target side before building the import path; treat the hosts below as the *source* side.
>
> **Design consequence (drives PRD §8/§10):** migration is **copy-faithful** — each block's JSON is read and written back unchanged. The only per-type work is (a) **media keys** — download + re-upload + remap — and (b) **cross-refs** — Storyline → Review 360 item, draw-from-bank → bank id. The validator is therefore a generic media-key/cross-ref scanner, not a per-block schema validator.

# Articulate Rise — Course Export & Recreation Protocol

Reverse-engineered from captured traffic. Lets you read a Rise course's full source
out of one account and rebuild it (editably) in another, programmatically.

> Private, undocumented API. It can change without notice, and automating against it
> likely conflicts with Articulate's Terms of Service. Confirm you own / are licensed
> for any content you migrate.

---

## 1. Architecture (three planes + assets)

| Plane | Host / path | Role |
|---|---|---|
| **Auth** | `id.articulate.com` (Okta) | Mints/refreshes the bearer JWT used everywhere |
| **Catalog (REST)** | `rise.articulate.com/manage/api/*` | List/create courses, folders, labels |
| **Authoring RPC ("ducks")** | `POST rise.articulate.com/api/rise-runtime/ducks/rise/<domain>/<ACTION>` | All reads + writes of course content; body is `{type, payload}` |
| **Realtime (collab only)** | `conveyor.articulate.com` socket.io | Presence, locks, and a *mirror* of write actions for live co-editing |
| **Assets** | PUT → `articulate-us.s3.amazonaws.com`; read ← `articulateusercontent.com/{key}` | Binary media (public-read by key) |

**Key insight:** the websocket carries no document data — it's collaboration sync only.
A single-author headless script ignores it entirely and just issues the HTTP "ducks" POSTs.

---

## 2. Auth

- The bearer is the `_articulate_rise_` cookie value: an Okta access JWT (`aud:
  api://default`, `~15 min` lifetime, claims include `iss`, `cid`, `scp`). Send it
  as `Authorization: Bearer <jwt>` on every `manage/api` and `ducks` call.
  - `sub` is USER-scoped (operator-confirmed 2026-08-20): the Articulate ID of
    the signed-in LOGIN, shape `aid|<uuid>` — the same value for that person on
    BOTH planes, and different for different logins. It is not account/tenant
    scoped (that is the account-local `_articulate_user_id` cookie).
  - `iss` is `https://id.articulate.com/oauth2/default` on BOTH planes: one
    shared SSO. Signing out of `rise.articulate.com` does NOT end the
    `id.articulate.com` session, so opening the OTHER plane's origin can
    silently mint a token for the PREVIOUS login — the Source ≠ Target guard's
    "token is stale or mis-filled" verdict catches exactly this drift
    (observed live 2026-08-20: an Elza-login token on the EU origin after a US
    logout, replaced by the correct login's token once the operator signed the
    EU origin in explicitly).
- **Token refresh — MITM-confirmed (2026-06-23, rechecked US 2026-08-31), do
  NOT confuse the two calls:**
  - `POST id.articulate.com/api/v1/sessions/me/lifecycle/refresh` usually returns
    **`204 No Content`**; the 2026-08-31 login-transition session also observed
    one `200` session response and Okta `JSESSIONID`/`sid`/`xids` Set-Cookie
    headers. It ONLY keeps/updates the Okta SSO session. It does **not** set or
    rotate `_articulate_rise_`, so it does not refresh the Rise bearer.
  - The bearer is actually rotated by **Okta silent re-auth**, which the Rise SPA
    runs internally: a hidden iframe to `GET {iss}/v1/authorize?client_id={cid}
    &prompt=none&response_type=id_token+token&response_mode=okta_post_message
    &redirect_uri={riseOrigin}/auth-callback&scope={scp}&nonce=…&state=…`. Okta
    (relying on the warm SSO session) returns an HTML page that does
    `window.parent.postMessage(data, "{riseOrigin}")` where `data = {id_token,
    access_token, token_type:"Bearer", expires_in:"900", scope, state}`.
    `data.access_token` is the new bearer. **No `oauth2/token` call and no
    `Set-Cookie`** for the bearer — the SPA writes the (non-httpOnly)
    `_articulate_rise_` cookie in JS.
  - **Operator-confirmed (2026-06-23): only a COURSE EDITOR boot rotates the
    bearer.** Reloading/idling the *dashboard* does NOT (it pings lifecycle/refresh
    but never silent-re-auths). The rotation fires when a course editor loads.
  - **We replicated the headless silent-auth iframe and it FAILED at runtime** —
    the injected `prompt=none` iframe never advanced `exp` (third-party SSO cookie /
    postMessage / CSP differences from the SPA's own first-party flow). That code
    was removed. **How we refresh now:** reload the active Rise tab (must be a
    course editor) so the SPA performs its own native silent re-auth and writes the
    rotated cookie; then re-read `_articulate_rise_`. A renewal counts only when the
    JWT `exp` advances. (Revisit a no-reload silent path later — see
    `entrypoints/background.ts` `TODO(refresh)`.)
  - **Idle does NOT keep the bearer fresh (capture-confirmed 2026-06-23).** In a
    ~35-min idle capture with a course open, the bearer rotated exactly ONCE — at
    SPA boot (a `prompt=none` authorize at +0:00), `exp` jumping ~5 min forward —
    then EXPIRED ~15 min later with NO further rotation; only `lifecycle/refresh`
    keep-warm pings (204) kept firing. So the rotation is triggered by the SPA
    booting/opening a course, not by a pure idle timer. This is exactly why
    reloading the course tab works (it re-triggers the boot-time authorize) and why
    "open a course and walk away" is not sufficient past ~15 min of inactivity.
- Tokens are short-lived → on `401`/`403` refresh (as above) and retry.
- SSO/2FA makes fully-programmatic login painful; easiest is a one-time browser capture
  (or Playwright with a real login) to grab a fresh token, then run the API client.

---

## 3. EXPORT (read)

1. **Enumerate courses**
   `GET /manage/api/content/search?page=N&pageSize=16&sort=RECENTLY_UPDATED&type=COURSE&type=MICROLEARNING&…`
   → ids, titles, folderId, shareId, lessonCount, cover images. Paginate to cover the library.

2. **Get the full document** (single call, returns everything in the HTTP body)
   `POST /api/rise-runtime/ducks/rise/courses/GET_COURSE` body `{"type":"rise/courses/GET_COURSE","payload":{"courseId":"…"}}`
   Response `payload`:
   - `course` — `theme{…}` (40+ keys), `headingTypefaceId` / `bodyTypefaceId` / `uiTypefaceId`,
     `labelSetId`, `navigationMode`, `settings`, `description`, `coverImage`/`cardImage`.
   - `lessons[]` — each `type:"section"` (module header, no content) or `type:"blocks"`
     (content), ordered by `position`, blocks in `items[]`.
   - **block** = `{id, type, family, variant, items[], settings, globalBlockId}`.
     `family`+`variant` identify the exact block (e.g. `text/paragraph`; `interactive`
     family = accordion/tabs/flashcards/labeled-graphic; `multimedia` = video/audio/embed).
     Content lives in `items[]` — rich HTML for text, media refs for image/multimedia.
     **Question blocks** instead carry `{type:"MATCHING"|"MULTIPLE_CHOICE"|…, title, answers, feedback}`.
     **Storyline blocks** (`family:"360", variant:"storyline"`) carry
     `items[0].media.storyline = {contentPrefix, src, meta}` (see §8).

3. **Quizzes** — `GET /api/rise-authoring/question_banks` (separate from blocks).

4. **Fonts / theme tokens** — `FETCH_TYPEFACES`, `FETCH_THEME_CONSTANTS`.
   Usually you just re-use the same IDs rather than recreating these.

5. **Assets** — extract every `rise/courses/{courseId}/<file>` `key` from the document,
   download from `https://articulateusercontent.com/{key}` (public-read, no auth).
   These are Rise's processed delivery versions, not byte-originals.

---

## 4. RECREATE (write)

All ducks calls: `POST https://rise.articulate.com/api/rise-runtime/ducks/rise/<domain>/<ACTION>`,
body `{type, payload}`, bearer auth.

1. **Create the course shell**
   `POST /manage/api/content` body `{"createBookmark":false,"folderId":"all"}`
   → `{"id":"<newCourseId>"}`
   Carry the source `type` (e.g. `"onePage"` for a microlearning) verbatim.
   ⚠ A `type:"onePage"` shell is created WITH one pre-created lesson
   (`{title:"", type:"blocks", items:[]}` — capture-proven 2026-08-04); the
   editor writes blocks straight into it and never renames it. Regular and
   `aiOutline` shells are lessonless. Adopt the shell lesson as lesson 1 —
   creating another leaves a phantom extra lesson.

2. **Set course fields**
   `rise/courses/UPDATE_COURSE` payload `{id, theme}` (or `UPDATE_COURSE_FIELD` for
   single fields like `title`). **The `theme` object round-trips verbatim** — it's the
   exact same shape returned in `course.theme` from `GET_COURSE` (themeId, colorAccent,
   blockCorners, the three typeface IDs, navigationType, cover/header images, paddings…),
   so just read it and POST it straight back. Built-in theme cover/header images are
   `cdn.articulate.com/assets/rise/...` URLs — referenced, not re-uploaded.

3. **For each lesson, in order**
   `rise/lessons/CREATE_LESSON` payload `{author, courseId, position, title, type}`
   → server assigns and returns the new `lessonId`.
   `rise/lessons/UPDATE_LESSON` — header image, icon, description, settings, and
   **lesson `type`**: `"blocks"` (normal), `"section"` (module header), or `"quiz"`
   (graded quiz lesson; sent as `{id, type:"quiz", icon:"Quiz"}`).

4. **For each lesson's blocks**
   `rise/lessons/CREATE_BLOCKS` payload
   `{courseId, lessonId, previousBlockId, blocks:[ … ]}`. Blocks come in **two shapes**:
   - **Content blocks**: `{family, variant, id, items:[{id, …content}], settings, globalBlockId}`
     (e.g. `text/paragraph`, `image/hero`, `multimedia/video`, `interactive-fullscreen/labeledgraphic`,
     `flashcard/flashcard`, `list/numbered`, `continue/continue`).
   - **Question blocks** (knowledge-check *and* quiz-lesson questions, identical):
     `{id, type:"<QTYPE>", title, answers:[…], feedback, settings}` where `<QTYPE>` is e.g.
     `MATCHING` (`answers:[{id,title,matchTitle}]`), `MULTIPLE_CHOICE`/`MULTIPLE_RESPONSE`
     (answers carry a `correct` flag), `FILL_IN_BLANK`, etc. **No `question_banks` write
     is involved** — questions are plain blocks. (`question_banks` is a separate, optional
     reusable-bank feature, read-only in our captures.)

   Blocks can be **batched**; `id`/item-`id`s are **client-generated** (older
   captures used cuid-style ids; the 2026-08-31 editor used UUIDv4) — you choose
   them and keep internal refs consistent. `rise/lessons/UPDATE_BLOCK` for later edits
   (`UPDATE_BLOCK_DEBOUNCE` is the autosave-coalesced variant — use the plain form when scripting).

---

## 4a. EDITING envelopes (capture-confirmed 2026-08-12)

Source: `capture-editing-20260812.mitm` (operator session: create / edit /
delete / move / duplicate blocks + lessons, undo/redo, quiz lesson, image
upload). Extracted flows: `docs/captures/2026-08-12-editing-envelopes.jsonl`.
These are the mutation envelopes the future **update-existing-course** path
rides. All are plain ducks POSTs (§4 conventions); every one returned 200.

- **Delete blocks** — `rise/lessons/DELETE_BLOCKS`
  `{blockIds:["…"], courseId, lessonId}` →
  `{success:true, blockIds, lessonId, updatedAt, contentUpdatedAt}`.
  `blockIds` is a real batch: the 2026-08-31 Manage Blocks UI sent three ids in
  one request. Deleting a media-bearing block triggers **no asset-side call** —
  uploads are left orphaned server-side.

- **Reorder blocks (within a lesson)** — `rise/lessons/MOVE_BLOCKS`
  `{lessonId, courseId, moves:[{blockId, previousBlockId, nextBlockId}]}` →
  `{success:true, moves, lessonId, updatedAt, contentUpdatedAt}`.
  **Linked-list anchors, not indexes** (first position: `previousBlockId:null`).
  `moves` is a real, order-sensitive batch: Manage Blocks sent two entries in
  one request, and the second entry's anchors depended on the first move having
  already executed. Preserve array order and verify the final order with
  `GET_COURSE`; selection cardinality need not equal `moves.length`. No
  cross-lesson move exists in the UI; none captured.

- **Batch mutate (the editor's UNDO/REDO transport)** —
  `rise/lessons/BULK_UPDATE_BLOCKS`
  `{courseId, lessonId, updates:[…], creates:[{previousBlockId, blocks:[<full block>]}], deletes:[blockId…], moves:[…]}`
  → `{success:true, lessonId, updatedAt, contentUpdatedAt, creates:[{blockMetadata:[{id, globalBlockId, createdAt, updatedAt}]}]}`.
  Undo of a delete re-creates the **same client block id** (the server mints a
  fresh `globalBlockId`); redo rides `deletes`. One envelope carries any mix —
  the natural transport for an update-plan's per-lesson changeset. ⚠ `updates[]`
  was empty in every sample — its element shape is UNCAPTURED (text edits ride
  `UPDATE_BLOCK_DEBOUNCE` instead); capture before using.

- **Edit a block** — `rise/lessons/UPDATE_BLOCK_DEBOUNCE`
  `{id, courseId, lessonId, item:<the FULL block JSON>}` — whole-block
  replacement; item add/remove/reorder inside a block are all just this
  envelope with the new `items[]`. Edited rich text comes back wrapped in
  `<div data-editor-id="…">` (known catalog noise). Response:
  `{success:true, blockId, lessonId, lastUpdatedBy, updatedAt, contentUpdatedAt}`.

- **Duplicate a block** — no dedicated envelope: plain `CREATE_BLOCKS` with the
  copied payload under fresh client ids, anchored by `previousBlockId`
  (confirms the insert-anywhere semantics of `CREATE_BLOCKS`). The 2026-08-31
  multi-select UI duplicated two selected blocks as two overlapping,
  single-block `CREATE_BLOCKS` calls sharing an anchor; it did not use
  `BULK_UPDATE_BLOCKS`. A scripted importer should keep writes sequential and
  use deterministic anchors rather than copying that UI overlap.

- **Insert a block template** — `rise/lessons/INSERT_BLOCK_TEMPLATE`
  `{blockTemplateId, lessonId, courseId, itemIndex, updatedAt}` → the LESSON
  row (not the created blocks; a follow-up GET_COURSE shows them). Index-based,
  unlike MOVE/CREATE. (Previously marked out of scope in §11 — now captured.)

- **Lesson ops** —
  `rise/courses/UPDATE_LESSON_ORDER` `{course:{from, to, lessonId, courseId}}`
  → authoritative `course.lessons` id array (one envelope per drag);
  `rise/lessons/DUPLICATE_LESSON` `{lessonId, position, courseId}` → server-side
  deep copy (new lesson id, `duplicatedFromId`, block ids re-minted server-side)
  + `course.lessons`;
  `rise/lessons/DELETE_LESSON` `{id, position, courseId}` → `course.lessons`
  (response shape now captured);
  `rise/lessons/UPDATE_LESSON_DEBOUNCE` `{id, description, updatedAt, courseId}`
  — autosave variant for lesson fields (captured on a quiz lesson description).

- **Locks — write transport now proven, granularity = LESSON.**
  `rise/locks/PUT_LOCK` `{id:<lessonId>, courseId}` →
  `{author, session, updatedAt, courseId, id, ttl:86400000}` (24 h TTL);
  `rise/locks/DEL_LOCK` `{id:<lessonId>, courseId}` echoes the payload. The
  editor PUTs when a lesson opens for editing and DELs on leave. **Operator
  decision 2026-08-12: multi-editor contention is OUT OF SCOPE** (single-author
  assumption) — a scripted writer should still mirror PUT/DEL around each
  lesson's write burst for editor fidelity, but no contention handling is built.

- **Concurrency signals.** Every mutation response carries `updatedAt` +
  `contentUpdatedAt`; the requests that include `updatedAt`
  (`INSERT_BLOCK_TEMPLATE`, `UPDATE_LESSON_DEBOUNCE`) echo the lesson's last
  known value. Whether the server ENFORCES it as a precondition is unverified
  (no stale write was attempted). No etag/version headers. ⇒ Until proven
  otherwise, the update path must rely on its own fingerprint check (fresh
  GET_COURSE diff immediately before applying), not on server-side rejection.

### 4a′. Settings panel envelopes (capture-confirmed 2026-08-31, `-settings.mitm`)

- `UPDATE_COURSE_DEBOUNCE {id, settings}` — the FULL settings object per write
  (observed: `{aiTutorEnabled: false|true}`).
- `UPDATE_COURSE_DEBOUNCE {id, exportSettings}` — the FULL publish-settings
  object per write; fields observed live: completeWith, completionPercentage
  (number OR string!), reporting, target/targetName + activeLMS, exportType,
  loadOnlyInLMS, hideLmsUi, enableExitCourse, disableCoverPage,
  enableTelemetryCollection, format, isRemotePackage, notifyLearnersOfUpdates,
  resetLearnerData, localesPackageType, quizComplete/quizId,
  storylineComplete/storylineId, identifier (`<courseId>_rise`), shareId,
  activeEdition, locales, isTranslated, **updateResumeData**,
  **webExportSettings** (both new 2026-08-31).
- `UPDATE_COURSE_DEBOUNCE {id, aiTutorConfig}` — AI-tutor name (debounced
  typing) + avatar (`image.media.image.{key,src}` after the normal GET_YURL →
  S3 PUT upload).
- `UPDATE_COURSE {id, labelSetId}` — the label-set select (IMMEDIATE, not
  debounced) — the monolingual label-set binding envelope.
- ⚠ The navigation/appearance controls are NOT Settings fields: they write the
  THEME object (`UPDATE_COURSE {id, theme}` — navigationType,
  navigationRestricted, sidebarStartsOpen, showLessonCount, allowSearch,
  markLessonsComplete, animateBlockEntrance, enableVideoPlaybackSpeed, …).
  The TOP-LEVEL course scalars (navigationMode, markComplete, sidebarMode,
  color, …) are LEGACY MIRRORS no current control writes — source courses
  disagree with their own theme (CRM: markComplete=true vs
  theme.markLessonsComplete=false) and still preview/publish fine. `allowCopy`
  has no captured write anywhere yet.

## 4b. Folders & content placement (REST, capture-confirmed 2026-06-23)

Folder ids are **UUIDs**. Two roots exist per account (`folderType: shared` / `private`,
both `isRoot`); a top-level folder hangs off the matching root via `parentFolderId`.

- **Create folder** — `POST /manage/api/folders` (JSON)
  `{"name":"new-a","parentFolderId":"<uuid>"}` → `200` the new folder
  (`{id, name, parentFolderId, folderType, ownerPrincipalId, roleId:3, …}`).
- **Rename folder** — `PATCH /manage/api/folder/<id>/rename` (JSON, note SINGULAR `folder`)
  `{"name":"courses-renamed"}` → `200` the folder.
- **Move folder** — `PATCH /manage/api/folders/<id>/move` (JSON, PLURAL `folders`)
  `{"parentId":"<uuid>"}` → `200` (note: key is `parentId`, not `parentFolderId`).
- **Move a COURSE into a folder** — `PATCH /manage/api/content/<courseId>/move`
  body is the **bare folder id as `text/plain;charset=UTF-8`** (NOT JSON), e.g.
  `163aa790-e4c5-4036-bc36-5bfca9397615` → `200` (empty body). ⚠ Asymmetry: course move
  = bare text id; folder move = JSON `{parentId}`. Our `moveCourseToFolder` matches this
  exactly — a `400` here means a **stale/invalid target folder id**, not a wrong shape.
- **Content permissions** — `GET`/`PUT /manage/api/content/<courseId>/permissions`
  (owner/collaborator ACL); `GET /manage/api/collaborators` lists members.

**Why a course move can `400` (the run's failure, analyzed 2026-06-23).** The
envelope is correct, so the cause is the folder *id* we pass, not the request:
1. **Stale persisted folder map (most likely).** When a prior step-A run persisted
   `account.idmap.json` (source folderId → target folderId), a later course run uses
   it directly WITHOUT re-creating/validating folders. If those target folders were
   since deleted/recreated (or came from a different target account/session), every
   id is invalid → uniform `400` on all courses (exactly what we saw — the run logged
   no folder-creation step, so it ran off the persisted map).
2. **Cross-plane id.** A US (source) folder id used as if it were an EU (target) id.
3. **Folder soft-deleted** between setup and the move.
4. **Permission**: moving into a team/shared folder the session user can't write.
   NOT the "create a duplicate then move" case — our `setupFolders` DEDUPES by
   parent|name and REUSES an existing folder; and if a create fails it skips the move
   (no id → no move), so a duplicate-create never produces a move `400`.
   Mitigation in place: the move + folder-create failures now log the server's
   response body + the folder id; re-running with fresh folder setup resolves it.

Question-bank folders are a SEPARATE namespace:
- **Create bank folder** — `POST /manage/api/question-banks/folder` (JSON).
- **Move bank** — `PUT /manage/api/question-banks/question-bank/<bankId>/move`.
- **Delete bank folder** — `DELETE /manage/api/question-banks/folder/<folderId>`.

---

## 5. Asset upload flow

1. `rise/uploads/GET_YURL` payload `{assetPath:"courses/<newCourseId>", courseId, filename}`
   → `{key, url, type, filename}` where `url` is a **pre-signed S3 PUT** URL
   (`articulate-us.s3.amazonaws.com/…`, `x-amz-acl=public-read`).
2. **PUT the raw bytes** to that `url` (confirmed: plain `PUT`, `Content-Type` set to the
   returned `type` e.g. `image/jpeg`, no `Authorization` header — the signature and
   `x-amz-acl=public-read` are query params in the pre-signed URL; returns `200`).
3. Post-processing:
   - Images → `rise/uploads/CRUSH_IMAGE` to generate the compressed `crushedKey`.
   - Audio/Video → `rise/uploads/TRANSCODE_ASSET`
     `{courseId, key(url-encoded), lessonId, mediaType, original, refs, uploadId}`,
     then `RESOLVE_ASSET` resolves a `transcoded-…` key; poll
     `rise/uploads/CHECK_STATUS {jobs:[…], courseId}` until done.
4. **Rewrite the block's media `key`** to the new key.
   Embeds (YouTube/Vimeo) are plain URLs — no upload needed.

**Course-level images (cover / card / logo).** MITM-confirmed (2026-06-23). Upload chain
is the same `GET_YURL → S3 PUT → CRUSH_IMAGE {courseId, original} → {key:<crushedKey>}`
(SVG returns a crushedKey but with `isSkipCrush:true`). The SET is a partial
`rise/courses/UPDATE_COURSE {id, <field>}` sending only the changed field(s):
   - **cover / card** → `coverImage` / `cardImage` = `{media:{image:{key, crushedKey,
     isSkipCrush, sourcedFrom:"USER", dimensions, useCrushedKey, originalUrl}}}` (or `{}`).
   - **cover-page logo** → `media` = `{image:{key, crushedKey, isSkipCrush, sourcedFrom,
     useCrushedKey, originalUrl}}` — note: the `image` sits DIRECTLY under `media` (no inner
     `media` wrapper), unlike coverImage/cardImage.
   - **lesson header** → `lessonHeaderImage` = `{media:{image:{key, crushedKey, …}}}` (same
     shape as cover/card; may also nest an uncropped `originalImage` with its OWN
     key/crushedKey — upload + remap ALL of them so none survives).
   Migration re-uploads the exported `key` + `crushedKey` (+ nested `originalImage` keys)
   verbatim and remaps every one (no re-crush).
   - **block background** → NOT a course field: it's block-level
     `item.background.media.image.{key,crushedKey}`, set via `UPDATE_BLOCK_DEBOUNCE`
     (MITM-confirmed). Already handled by the copy-faithful per-block media path
     (`collectAssetKeys(block)` → upload + `patch-block-media`); needs no special code.
   - **overlayNavigationImage** → no upload UI; Rise reuses the cover overlay image
     (inherited). Nothing to migrate unless a course carries a distinct key (then it
     stays flagged).
   - user-uploaded **`theme.*`** image keys → deferred (not yet wired).

`refs` ties an asset to a block item via the path `items:<itemId>/items:<subItemId>`.

---

## 6. IDs & references

| Thing | Assigned by |
|---|---|
| Course id | Server (`POST /manage/api/content`) |
| Lesson id | Server (`CREATE_LESSON`) |
| Block id, item id | **Client** (sent in `CREATE_BLOCKS`) |

HTML content carries `data-editor-id` attributes, custom-font classes
(`mighty-type-style-*`), and theme CSS variables. Preserve them as-is; they stay valid
as long as you keep the same typeface IDs and theme.

---

## 7. Recreation algorithm (pseudocode)

```
newCourseId = POST /manage/api/content {createBookmark:false, folderId:"all"}
UPDATE_COURSE(newCourseId, {title, theme, typefaceIds, labelSetId, settings, ...})

# question banks first (blocks may reference them)
for bank in source.question_banks:
    newBankId = POST /manage/api/question-banks {folderId, title}
    PUT /api/rise-authoring/question_banks/newBankId {questions:[…]}
    map oldBankId -> newBankId

for lesson in source.lessons (ordered by position):
    newLessonId = CREATE_LESSON {courseId:newCourseId, position, title, type}
    UPDATE_LESSON(newLessonId, {type, headerImage, icon, description, settings})
    CREATE_BLOCKS {courseId:newCourseId, lessonId:newLessonId,
                   previousBlockId:null, blocks:[ remapped blocks ]}
    # for draw-from-bank blocks: point item at mapped newBankId
    # for storyline blocks: select matching Review 360 item (see §8)

for asset in source.assets:
    {key,url,type} = GET_YURL {assetPath:"courses/"+newCourseId, courseId, filename}
    PUT bytes -> url (Content-Type:type)        # confirmed 200
    if image:  CRUSH_IMAGE
    if av:     TRANSCODE_ASSET ; poll CHECK_STATUS ; RESOLVE_ASSET
    remap every reference old key -> new key in the rebuilt blocks
```

---

## 8. Storyline / 360 blocks

A Storyline block is `{type:"interactive", family:"360", variant:"storyline", items:[{id}]}`,
created **empty**, then attached via `UPDATE_BLOCK` setting `items[0].media.storyline`
(`processing:true` → resolves to `{contentPrefix, src, meta}`):

- `contentPrefix`: `rise/courses/{courseId}/{packageKey}` — the copied bundle's location
- `src`: `{contentPrefix}/story.html` — the package entry point
- `meta`: `{title, stage{w,h}, player, scenes[], slides[{id,title,scene_index}], version, course_id, thumbnail}`

**Source is Review 360 (not a file upload).** Storyline content can only come from a
published Review 360 item — there is **no `.story` upload in Rise**. The picker calls:

```
GET api.articulate.com/review/items?includeStackItems=true&productFilter=storyline
→ items:[{ id, product:"storyline", project_id, title, url, thumbnail,
           contentPrefix, meta, package, updated_at, user_id }]
```

Selecting an item makes Rise copy that published bundle into the course's asset space and
set `media.storyline` on the block. The editable `.story` is never recoverable — only the
published output.

**Migration implication.** A Storyline block can only be recreated if the destination
account can reach the same Review 360 item (same 360 org/team). The flow is: list
`/review/items`, match by `project_id`/`title`, select it → Rise re-copies. If the
destination has no access to that Review item, the block cannot be faithfully recreated
through the API — flag it for manual handling. (Bytes are downloadable from
`articulateusercontent.com/{contentPrefix}/…`, but there is no API path to ingest a raw
bundle, so download alone doesn't enable recreation.)

---

## 8a. Mondrian ("Custom block") blockuments ✅ captured 2026-08-31

UI name **Custom block**; block JSON `{type:"custom", family:"mondrian",
variant:"mondrian", settings:{…}, blockumentId:"<uuid>"}`. The content lives in
a per-plane service — **`mondrian-api.articulate.com` (US) /
`mondrian-api.eu.articulate.com` (EU)** — as a "blockument" **parented to the
course** (`contentParent → {parentId:<courseId>, parentType:"course"}`). Auth =
the plane's bearer + first-party cookies (CORS allows the rise origin), same as
ducks. **Preview/publish boot resolves every referenced blockument server-side
(`course.mondrian.blockuments` in the boot body) and the WHOLE course 404s when
one is missing** — the proxied `{"statusCode":404,"error":"Not Found","message":
"Request failed with status code 404"}` observed on the failed EU imports; the
editor only fetches lazily (`GET …/manifest` fires when the block scrolls in),
so a dangling id looks fine in authoring. A source `blockumentId` is therefore a
CROSS-ACCOUNT REF that must be recreated + remapped, never copied verbatim.

Captured endpoints (`-mondrian{,2,3}.mitm` — EU create/edit + US plane parity):

- `GET /api/blockuments/<id>/manifest` → the FULL graph
  `{blockuments:{<id>:doc}, items:{<itemId>:item}, fonts?}`; 404 body
  `Blockuments <id> not found`. Bulk form `GET /api/blockuments/manifests?blockumentId=<id>`
  returns the same shape (only single-id captured — do not assume multi-id).
- `POST /api/blockuments/createFromBlank {parentId, parentType:"course"}` →
  fresh graph: one blockument + its root "Canvas" group item.
- `POST /api/blockuments/createFromTemplate/<templateId> {parentId, parentType}`
  → same, with `createdFromTemplateId` + per-item `clonedFromId` provenance.
- `POST /api/blockuments/<id>/transaction` — **FULL-STATE upsert** of touched
  entities: body `{blockument:<doc>}` or `{items:{<itemId>:<item>, …}}`; response
  is the plain text `OK`. The editor writes ONE entity per call when EDITING an
  existing graph. ⚠ CONSTRUCTION must ship ALL items in one call: the server
  validates the post-transaction reachability manifest and 400s
  (`pruneManifest: Item <id> was referenced in the manifest but not present`,
  live-observed 2026-08-31) when a group's `children` (or the doc's) reference
  an item that does not exist — group items carry `children` lists, so no
  sequential single-item order is ever consistent.
- `POST /api/signed-asset-url {name, blockumentId}` →
  `{asset:{id,path,name,type}, mimeType, url}` — presigned S3 PUT for
  `mondrian/assets/blockument/<bid>/<assetId>.<ext>`; followed by the standard
  ducks `CRUSH_IMAGE {courseId, original:<path>}` (capture-proven for THIS
  pipeline). Assets are served publicly by the plane's usercontent host.
- `GET /api/templates/`, `GET /api/templateCategories/` — the Add-block gallery.
- `GET /api/blockuments/<id>/contentParent` → `{parentId, parentType}`.

Document shape: `blockument {id, title, children:[{id, visualOrder,
clonedFromId?}], triggers, authoringOpened, createdFromTemplateId?, responsive,
_v}` (`_v: 47` in every capture); `item {id, blockumentId, parentId, type:
group|text|shape|image, states:{default:{…, text?:{type:"tiptap", json}, fill?:
{assetId?, crop?}, …}}, assets?:{<assetId>:{id, path, name, type, width,
height}}, breakpointOverrides, localeOverrides, clonedFromId?, removed, _v}`.
The root item's `parentId` is the blockument id itself.

⚠ Opening the Edit canvas on a blockument WRITES auto-normalization
transactions (text re-measure, sub-pixel rounding) — never open Edit on
customer content during a capture; scrolling the lesson view only reads.

## 8b. AI Scenario (`ai-scenario/ai-scenario`) ⚠ UNCAPTURED — TODO mitm session

Block JSON `{type:"interactive", family:"ai-scenario", variant:"ai-scenario",
settings:{v:2,…}, background:{media:{image:…}}, scenarioId:"<uuid>", globalBlockId}`;
arrives as a new course type `course.type:"scenario"` (AI Assistant flow,
`metadata.createdVia:"ai"`, one titleless lesson, one block). **`scenarioId` is a
CROSS-ACCOUNT REF into a service we have never captured** — host, auth, document
schema, create/upsert endpoints, asset namespace, boot resolution and EU
availability are all UNKNOWN. Player labels (`aiScenario*`) describe a Character
chat with Response options, Goals, a Passing threshold and a score, plus
"not available yet / getting set up" and "validation errors" states that imply an
external, asynchronously prepared document. Sibling translation bucket
`translationUpdates.aiScenarioUpdates`; permissions `scenario_block:create|edit`;
runtime bundle pin `ai_scenario`.

**Until captured: an export containing this block is INCOMPLETE and the course
must NOT be imported** (a verbatim `scenarioId` renders a dead block at best,
404s the boot at worst; `POST /manage/api/content {type:"scenario"}` shell
semantics are unknown). Flagging requirements + capture checklist:
`docs/findings-2026-09-13-ai-scenario.md`.

## 9. Question banks

A "Quiz" lesson stores its questions inline as blocks (§4). **Reusable question banks** are a
separate resource, used only by the `knowledgeCheck / "draw from question bank"` block.

**Catalog (REST):**
- `GET /manage/api/question-banks` — list banks; `…/locks` — edit locks
- `POST /manage/api/question-banks {folderId, title}` → `{id}` (cuid)
- `DELETE /manage/api/question-banks/question-bank/{id}`

**Content (authoring):**
- `GET /api/rise-authoring/question_banks` and `GET/PUT /api/rise-authoring/question_banks/{id}`
- `PUT` body: `{id, questions:[…], session, lock_data, update_type}` — writes the **whole**
  questions array (autosaves on each edit). Locks via `GET/POST /api/rise-authoring/locks`.
- A question = `{id, type, title(HTML), answers:[{id, title, correct}], correct, feedback}` —
  the **same shape** as inline quiz/knowledge-check question blocks.

**Linking from a block:** the draw-from-bank block is
`{family:"knowledgeCheck", variant:"draw from question bank", items:[{id, type:"DRAW_FROM_QUESTION_BANK"}]}`;
the item carries the bank id reference. To migrate such a block you must first recreate the
bank (create + PUT questions), then point the block's item at the new bank id.

---

## 10. Caveats

- Private API; expect periodic breakage and re-capture.
- Likely against Articulate ToS; confirm content ownership/licensing.
- Re-uploaded media is re-processed (not byte-identical to originals).
- Token expiry → on 401 **or 403**, boot/reload a course editor and require the
  `_articulate_rise_` JWT `exp` to advance; lifecycle refresh alone is not a
  bearer refresh.
- **Multi-language courses ("stacks")** rewrite the course document into l10n
  form (`{l10nId}` refs + per-locale translation tables in `payload.l10n`, most
  media keys INSIDE the tables) and add a family of `…/translations` +
  `rise/l10n/*` + `rise/labelSets/*` endpoints. Captured 2026-07-31/08-01 (EU
  plane) and documented separately in **`docs/rise-multilang.md`** — detect
  `course.localizationMetadata.isLocalized` (helper: `core/l10n`
  `isLocalizedStack`) and use the stack import path.

---

## 11. Status

**Fully mapped and ready to build against:** auth + token refresh; course create; course
fields + theme (round-trips verbatim); lessons (`blocks`/`section`/`quiz`); content blocks
(uniform `CREATE_BLOCKS`); question blocks (inline quiz/KC); question banks (create + PUT +
draw-from-bank link); asset upload end-to-end (`GET_YURL` → confirmed S3 `PUT` →
`CRUSH_IMAGE` / `TRANSCODE_ASSET` / `RESOLVE_ASSET` / `CHECK_STATUS`); asset download
(public-read by key); embeds; Storyline reference + Review 360 source.

**Known block variants seen** (`family/variant`): `text/*`, `list/numbered`, `image/hero`,
`multimedia/video`, `flashcard/flashcard`, `interactive-fullscreen/{labeledgraphic,process,sorting}`,
`continue/continue`, `divider/numbered divider`, `html/{inline,cdn}` (code), `360/storyline`,
`knowledgeCheck/draw from question bank`, plus question types `MATCHING`/`MULTIPLE_CHOICE`
(answers carry `correct`). The full catalog (statement, quote, gallery, accordion, tabs,
scenario, timeline, chart, table, attachment, audio, etc.) is **not individually captured** —
but the migrator is **copy-faithful** (read each block's JSON, write it back unchanged via
`CREATE_BLOCKS`), so unseen variants copy correctly as long as you handle the two things that
actually vary: **media keys** (download + re-upload + remap) and **cross-refs**
(Storyline → Review item, draw-from-bank → bank id).

**Discover-as-you-go:** scan older courses' `GET_COURSE` documents to enumerate which
`family/variant` and media-ref shapes actually occur in your library, and which carry assets.
Build the copy-faithful path first; only the media-bearing and cross-ref blocks need
per-type handling.

---

## 12. Capturing the protocol (MITM) — method + format

Everything above is reverse-engineered from man-in-the-middle captures of the live editor.
**Immutable: never wire an API shape that isn't confirmed from a capture** (see CLAUDE.md).

**How to capture.** Run mitmproxy/mitmweb (or Charles/Proxyman) with its CA trusted, drive the
Rise editor in the browser, exercise the action of interest (e.g. set a theme image; or leave
an authoring course idle ~15–20 min to catch the token renewal), then export the flows. Two
useful export formats:
- **Plain text dump** (mitmproxy `: export` / "Save as cURL/raw") — human-readable
  request+response lines (used for most sections here).
- **`.mitm` flow file** — mitmproxy's native binary. It is a sequence of **tnetstring**-encoded
  flow dicts (`<len>:<payload><type>`; types: `,`=bytes, `;`=unicode str, `#`=int, `^`=float,
  `!`=bool, `~`=null, `}`=dict, `]`=list). Response bodies are under `response.content` and may
  be `gzip`-encoded (check the `content-encoding` header). Parse with a tiny tnetstring reader
  (no mitmproxy install needed) and `gzip.decompress` the body — this is how the §2 silent-auth
  HTML (`buildMessageData()` / `postMessage`) was recovered.

**What to capture for a clean wire-up.** For any write: the full request **URL + method +
JSON body** (the field shape) AND, where rotation/state matters, the **response** incl.
`Set-Cookie`. For media: the `GET_YURL → S3 PUT → CRUSH/TRANSCODE` chain plus the `UPDATE_*`
that sets the key. Record the confirmed envelope here before coding.

**Wired & confirmed:** course `coverImage`/`cardImage`, `media` (logo), `lessonHeaderImage`
(incl. nested `originalImage`); block backgrounds (`item.background…`, via the generic block
media path). **Deferred / not wired:** user-uploaded `theme.*` image keys (skip for now);
`overlayNavigationImage` (no upload UI — inherited from cover). **Unconfirmed:** US-plane
silent-auth (only EU captured — but the authorize URL is derived from token claims, so it
should port).
