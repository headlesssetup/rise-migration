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
- **Token refresh — MITM-confirmed (2026-06-23), do NOT confuse the two calls:**
  - `POST id.articulate.com/api/v1/sessions/me/lifecycle/refresh` → **`204 No
    Content`, no body, no `Set-Cookie`**. It ONLY keeps the Okta SSO session
    (`sid`/`xids` cookies on `id.articulate.com`) warm. It does **not** rotate the
    bearer. (Same-site from the rise origin; `prefer: return=minimal`.)
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

   Blocks can be **batched**; `id`/item-`id`s are **client-generated** (cuid-style) — you
   choose them, keep internal refs consistent. `rise/lessons/UPDATE_BLOCK` for later edits
   (`UPDATE_BLOCK_DEBOUNCE` is the autosave-coalesced variant — use the plain form when scripting).

---

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
- Token expiry → refresh on 401 (`POST id.articulate.com/api/v1/sessions/me/lifecycle/refresh`).

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
