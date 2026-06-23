# MITM sample 2 — blocks, image, video+thumbnail, theme (EU), 2026-06-23

> **Authoritative capture** (`api_calls.txt`, EU plane). The operator created a
> course, added blocks, an image (with crop), a video (with thumbnail), and changed
> the theme twice. **Headers only — no request/response bodies** in this dump, so it
> confirms the *call sequence, statuses, and timing*, not payload shapes (those are
> in `rise-mitm-sample-new-course.md` + `rise-import-protocol.md`). Re-parse with
> `scripts/mitm-to-jsonl.py`.

## Create → open → first edit timing
```
POST /manage/api/content            200   (create)
GET_COURSE                          200   +13s   ← but inflated by an OAuth re-auth
                                                    + editor page load in between
first edit (UPDATE_COURSE_FIELD_THROTTLE)  +18s   ← when the operator starts typing
```
Rise does **not** deliberately wait: `GET_COURSE` returns **200** as soon as the
editor JS runs; the ~13s is page-load + a `lifecycle/refresh`. **Takeaway for the
importer:** a paced gap (~1.6s) + a small GET_COURSE retry is ample slack. We
implemented `courseHandshakeTries` (default 3, paced) on the create-course handshake.

## Image block — the editor CRUSHES (we don't, by choice)
```
rise/uploads/GET_YURL            → S3 PUT (bytes)
rise/uploads/CRUSH_IMAGE         200      ← editor generates the crushedKey
rise/uploads/CROP_IMAGE          200      ← when the user crops
rise/lessons/UPDATE_BLOCK_DEBOUNCE 200    ← block patched with the key(s)
GET images.eu/f:jpg,…,w:100,h:100/rise/courses/{id}/{key}   ← thumbnail (transform URL)
```
Counts in this capture: `GET_YURL`×5, `CRUSH_IMAGE`×2, `CROP_IMAGE`×1. The
`CROP_IMAGE` was a **deliberate manual crop by the operator** (a user edit), not a
step in the upload pipeline. Our importer **intentionally skips CRUSH/CROP** and
re-uploads the source's existing `key` **and** `crushedKey` **verbatim** — source
assets are either deliberately uncompressed or were already compressed by Rise at
author time, so a second pass on import would only recompress + drift them for no
gain. Same end state, no re-processing. (See `envelopes.ts` note + protocol §8.)

## Video block — NO transcode; thumbnail is a transform URL over the key
```
rise/uploads/GET_YURL            → S3 PUT (video bytes)
rise/uploads/CHECK_STATUS        200 (polled ×5)   ← processing/upload status
GET .../api/rise-runtime/yurl    200               ← resolve playback url
GET articulateusercontent.eu/rise/courses/{id}/{key}   206  ← ranged video fetch
GET images.eu/f:png,w:1920,s:cover,q:65/rise/courses/{id}/{key}   ← poster/thumbnail
rise/lessons/UPDATE_BLOCK_DEBOUNCE 200
```
**`TRANSCODE_ASSET` and `RESOLVE_ASSET` were NOT called at all** (0×). The video key
is referenced directly; the **poster/thumbnail is an `images[.eu].articulate.com`
transform URL wrapping a `rise/courses/{id}/…` key** — generated server-side, not a
separately-transcoded asset. **Migration implication:** re-uploading the video
key(s) + remapping them (our generic scan rewrites keys *inside* transform URLs too)
is sufficient — no transcode step needed. (Resolves the "confirm video thumbnails"
TODO; still worth a live round-trip check.)

## Theme change
```
rise/courseTheme/FETCH_THEME_CONSTANTS  200
rise/courses/UPDATE_COURSE              200   (×2 — two theme changes)
```
The operator hit a transient "error opening a theme" — but **zero 4xx/5xx appear on
any Articulate call in the entire capture**, so it never surfaced as a failed API
request (a client-side fluke that self-recovered). Nothing to handle.

## Body-confirmed shapes (re-capture WITH bodies, `b6e21345`)

**Create:** `POST /manage/api/content {"createBookmark":false,"folderId":"all"}` → `{"id":…}`
(verbatim our envelope). **Image upload:** `GET_YURL {assetPath:"courses/{id}",
filename:<sha256>.jpg}` → `{key:"rise/courses/{id}/<short>.jpg", url:<presigned S3>}`;
then `CRUSH_IMAGE {original:<key>}` → `{key:<crushedKey>}`. The image block media:
```jsonc
"media": { "image": {
  "key":         "rise/courses/{id}/dBJqKiS92WZoXnws.jpg",   // original (uploaded)
  "crushedKey":  "rise/courses/{id}/2drjLWfISvDwnLFB.jpg",   // crush output (uploaded)
  "isSkipCrush": true, "useCrushedKey": false, "sourcedFrom": "USER",
  "originalUrl": "9f49…<sha256>.jpg",   // bare source filename — NOT a key
  "dimensions": { "originalWidth":1440, "originalHeight":810 } } }
```
Both `key` and `crushedKey` are `rise/courses/{id}/…` → our scan uploads BOTH verbatim
and remaps BOTH (no crush pass). `isSkipCrush`/`useCrushedKey`/`sourcedFrom`/`originalUrl`
are in the parity VOLATILE set (copied verbatim, not compared).

**Video (two shapes confirmed).** A BUILT-IN video (`Coastline.mp4` from
block-defaults) is `src/poster/thumbnail` = `cdn.eu.articulate.com/assets/rise/…`,
`key:"assets/rise/assets/block-defaults/coastline.mp4"` — kept as references
(round-trips as-is). An UPLOADED video (re-capture `be2ee1ae`) is now **body-confirmed**:
```jsonc
"media": { "video": {
  "key":       "rise/courses/{id}/69AuKcRIx23PwiOc.mp4",   // uploaded video
  "type":"video", "isSkipCrush": true, "skipProcess": true, // ← client SKIPS transcode/crush
  "thumbnail": "https://images.eu.articulate.com/f:jpg,b:fff,w:100,h:100,s:cover/rise/courses/{id}/Zf_PoJD7IS14itUy.png",
  "poster":    "https://images.eu.articulate.com/f:png,w:1920,s:cover,q:65/rise/courses/{id}/Zf_PoJD7IS14itUy.png",
  "originalUrl":"7688…<sha256>.mp4",
  "captions":  [ … ],  // a sidecar .vtt: rise/courses/{id}/FJKSfrNSucfstfWS.vtt
} }
```
So an uploaded video carries THREE+ uploaded `rise/courses/{id}/…` assets — the **mp4
key**, a **poster/thumbnail** PNG (served via `images.eu` transform URL), and a
**caption `.vtt`**. All are caught by our generic key-path scan (mp4→media-video,
poster→media-image, vtt→media-other) and re-uploaded + remapped. **`skipProcess:true`
+ `isSkipCrush:true` confirm Rise itself does NOT transcode/crush on upload** — exactly
our stance. No special video handling needed. ✅ TODO resolved.

### Persisted shape — confirmed from a settled `GET_COURSE` (view capture `b706eabc`)
A `GET_COURSE` of the finished course (the operator just *viewing* it) shows what our
export actually reads:
- **`key` / `poster` / `thumbnail` / `captions[].key`** are all `rise/courses/{id}/…`
  uploads (mp4 / png-via-`images.eu`-transform / `.vtt`) → all caught + remapped. ✅
- **`url`** persists but is a presigned READ url **derived from `key`** (regenerated per
  fetch). Our blank-then-key-remap is fine — Rise re-derives it from `key`; a stale
  signature is irrelevant. **`cancelSource`** persists as harmless empty junk
  (`{token:{promise:{},_listeners:[]}}`), copied verbatim.
- ⚠ **Open finding (stale embedded id):** `media.video.id` persists as a composite
  `"<lessonId>-items:<blockId>/items:<itemId>"`, and AI captions carry
  `"id":"ai-caption-<blockId>-<itemId>-<ts>"`. `remapIds` rewrites the `items:<id>`
  segments + the media keys, but the **leading lessonId** (and the ai-caption's embedded
  block/item ids, which aren't in `items:` form) are **left as stale SOURCE ids**. The
  `key`s migrate correctly so playback should be unaffected, and parity ignores `id`
  (VOLATILE) — but a source id technically survives inside an internal `id` field.
  NOT yet fixed: it's unclear whether Rise regenerates `media.video.id` on `CREATE_BLOCKS`
  (→ no-op) or stores it verbatim (→ stale but opaque). Decide after a live import
  round-trip before changing `remapRefString` (a speculative remap could itself break a
  format Rise expects).

**Theme (`UPDATE_COURSE {theme}`):** `themeId:"classic"`, `coverImage:
"https://cdn.eu.articulate.com/assets/rise/assets/themes/classic/cover-image/2_wfh.jpg"`,
`lessonHeaderImage: "https://articulateusercontent.eu/assets/rise/assets/themes/example-header-image.jpg"`,
plus colors/typeface ids/nav flags — copied back verbatim.

### ⚠ Bug this capture exposed (fixed)
`theme.lessonHeaderImage` is a **built-in served from the usercontent host** under
`/assets/rise/…`. Our `classifyString` classified media **by host** (`articulateusercontent.com`)
— so on the **US→EU** path the source's built-in header (`articulateusercontent.com/assets/rise/…`)
was tagged `media-image` and **blanked by `set-theme`'s `blankUploadedMediaKeys`**, silently
dropping the built-in header on the migrated course. EU only dodged it because the host
regexes were `.com`-only. **Fix:** classify uploads by the `rise/courses|questionBanks/{id}/`
**key path** (any host), and keep cdn/usercontent non-key URLs (incl. `/assets/rise/…`,
US + EU) as `cdn`. Host regexes are now plane-aware (`scan.ts`, `keys.ts`).

### No action needed
- **Default block content:** Rise seeds a new block with stock content (stock photo/video,
  lorem-ipsum text) which the user then edits. Our import sends the SOURCE block's final
  content via `CREATE_BLOCKS`, so Rise's seeding never enters our path — no impact.
