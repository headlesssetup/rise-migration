# MITM sample — New-Course creation (EU), 2026-06-23

> **Authoritative capture.** Parsed from a raw mitmproxy recording of the operator
> **creating blank courses in the Rise editor and exiting to the dashboard**, a few
> times, on the **EU** plane (`rise.eu.articulate.com`). This is the flow the
> original `http_api.jsonl` capture lacked (that one was an *edit of an existing*
> course). Re-parse the raw `.mitm` with `scripts/mitm-to-jsonl.py` (unfiltered).
> Tokens scrubbed. **This file is the source of truth for how a course is born.**

## The one thing that matters

**Course creation is a single atomic call.** `POST /manage/api/content` returns a
**fully-materialized** course; the editor opens and `GET_COURSE` returns it **200
immediately**. There is **no separate "materializing write"**. A bare titleless,
lessonless shell is a valid, dashboard-safe course (it carries the classic theme +
a random built-in cover).

## Exact sequence (one creation, trimmed to authoring calls)

```
POST /manage/api/content                         → 200 {"id":"cyZV…"}     # create
GET  /authoring/{id}                             → 200                     # editor page
POST …/ducks/rise/courses/GET_COURSE {courseId}  → 200 {course:{…}}        # handshake
POST …/ducks/rise/courses/GET_COURSE_SHARE_DISABLED → 200 false
POST …/ducks/rise/courseTheme/FETCH_THEME_CONSTANTS  → 200
POST …/ducks/rise/typefaces/FETCH_TYPEFACES          → 200
POST …/ducks/rise/uploads/CHECK_STATUS               → 200
… (editor reads: instant-links, job-group/workflows, course_fonts.css) …
GET  /manage  (operator exits to dashboard)      → 200                     # nothing else written
```

A second creation in the same capture was a **microlearning** (preview browser
first), the only difference being the `type` field on create (below).

## Key request/response bodies

### Create — standard course
```jsonc
POST /manage/api/content
req : {"createBookmark":false,"folderId":"all"}
resp: {"id":"cyZVdaCwFMhwYSdrUUHKKZc-t9szeauO"}
```

### Create — microlearning (one-page)
```jsonc
POST /manage/api/content
req : {"createBookmark":false,"folderId":"all","type":"onePage"}
resp: {"id":"YmFJemFVprCqfBzTY9y902fQibq723N-"}
```
`GET_COURSE` then reports `course.type:"onePage"` (a standard course is
`course.type:null`). → **Preserve `course.type` on the create call.**

### The fresh shell (GET_COURSE `payload.course`, before ANY edit)
```jsonc
{
  "id": "cyZV…",
  "title": "",                // empty
  "description": "",
  "lessons": [],              // none
  "coverImage": {},           // no USER cover
  "cardImage": null,
  "type": null,               // "onePage" for a microlearning
  "navigationMode": "",
  "headingTypefaceId": "t1Nkx9Ab7dQb4z_F5v8EgdA0Q11M3_If",  // account default fonts
  "bodyTypefaceId":    "4WU3aD0SmCMkBB58YOWNqgGKf2ItM29g",
  "uiTypefaceId":      "t1Nkx9Ab7dQb4z_F5v8EgdA0Q11M3_If",
  "theme": {
    "themeId": "classic",
    "coverImage": "https://cdn.eu.articulate.com/assets/rise/assets/themes/classic/cover-image/52_abstract.jpg",
    // …full default theme: colorAccent, blockCorners, navigation*, lessonHeader*, paddings, etc.
  }
}
```
The "random cover image" the operator sees is the **classic theme's built-in
cover** (`…/themes/classic/cover-image/52_abstract.jpg`) — a `cdn.eu.articulate.com`
URL, **not an uploaded asset** → kept as a reference on migration.

### Title / description = the editor's debounced typing (not a materializer)
```jsonc
// one UPDATE_COURSE_FIELD_THROTTLE per debounce tick as the user types "name":
POST …/ducks/rise/courses/UPDATE_COURSE_FIELD_THROTTLE
req : {"course":{"id":"cyZV…","title":"n"}}        → "name" → "nameit" …
req : {"course":{"id":"cyZV…","description":"<div data-editor-id=\"…\"><p>desc</p></div>"}}
```

### Lesson lifecycle (when the operator adds one) — confirms our envelopes
```jsonc
POST …/ducks/rise/lessons/CREATE_LESSON
req : {"author":"auth0|…","courseId":"cyZV…","position":0,"selectedAuthorId":"auth0|…","title":"lessonone","type":null}
resp: {"course":{"id":"cyZV…","lessons":["9WB3…"]},"lesson":{"id":"9WB3…","type":null,"headerImage":{},"items":[], …}}

POST …/ducks/rise/lessons/UPDATE_LESSON
req : {"icon":"Article","id":"9WB3…","type":"blocks","updatedAt":"…","courseId":"cyZV…",
       "bulkUpdateBlocks":{"deletes":[],"creates":[],"updates":[],"moves":[]}}

POST …/ducks/rise/lessons/CREATE_BLOCKS          # a default text block from a template
req : {"courseId":"cyZV…","lessonId":"9WB3…","previousBlockId":null,
       "blocks":[{"family":"text","id":"cmqq…","type":"text","variant":"heading paragraph",
                  "items":[{"id":"cmqq…","heading":"<strong>Heading</strong>","paragraph":"<p>…</p>"}],
                  "settings":{"paddingTop":3,"paddingBottom":3,"paddingLinked":true, …}}]}
resp: {"success":true,"blockMetadata":[{"id":"cmqq…","globalBlockId":"a97a…","createdAt":"…"}]}
```
The editor also takes a `locks/PUT_LOCK` on open and `locks/DEL_LOCK` on exit
(collaboration guard — a solo import skips it).

## Conclusions (what this changes for the importer)

1. **`POST /content` is atomic + self-materializing.** Our prior "never-born from an
   incomplete create" model was wrong; **mirror the editor with a `GET_COURSE`
   handshake** right after create (see CLAUDE.md invariant + protocol §0).
2. **A `GET_COURSE`-404 / `content/search`-500 row ⇒ partial delete**, not a create
   gap. Investigate the delete/purge path if a phantom recurs; don't build repair.
3. **Preserve `course.type`** (`onePage`) on create.
4. The default cover is a built-in CDN theme image — already handled (kept as a ref).
