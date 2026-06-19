# Rise Question Banks — detection, export & migration

Companion to `rise-api-reference.md` §9. Reusable **question banks** are a
resource **separate from course content**: a course's `knowledgeCheck / draw from
question bank` block only stores a **reference** to a bank id — the questions live
in the bank, not in `GET_COURSE`. So migrating those blocks requires exporting the
banks too. (Inline quiz / knowledge-check questions, by contrast, are plain blocks
inside the course and need no bank.)

## Endpoints (API ref §9)

- **List (authoring):** `GET /api/rise-authoring/question_banks`
- **One bank + questions:** `GET /api/rise-authoring/question_banks/{id}`
- **Catalog (REST):** `GET /manage/api/question-banks` (ids/titles/locks);
  `POST /manage/api/question-banks {folderId, title}` → `{id}`;
  `DELETE …/question-bank/{id}`
- **Write (recreation, Phase 3):** `PUT /api/rise-authoring/question_banks/{id}`
  with `{id, questions:[…], session, lock_data, update_type}` (whole array).

All run **inside the live Rise tab** (first-party cookies), like every other call;
URLs are relative so they work on the US and EU planes.

## List response (captured)

`GET /api/rise-authoring/question_banks` returns **the banks with their questions
inline** — there is **no need to fetch each bank by id** (the single-bank
`GET …/question_banks/{id}` returned non-2xx in testing). Shape:

```
{ question_banks: [ { id, title, questions: [ … ], author_id, folder_id,
                      last_edited_by, updated_at, version, deleted } ],
  profiles, private_folders, shared_folders, folder_state }
```

The tool saves each bank object (from this list) to `question-banks/{id}.json`
and only falls back to a per-bank fetch if a bank lacks an inline `questions`
array.

## Question schema (captured)

A question:

```
{ id, type, title (HTML),
  answers: [ { id, title, correct, matchTitle? } ],
  correct, corrects, feedback, media? }
```

Question `type`s seen across the 581-course library (as inline course blocks;
banks reuse the same shapes): `MULTIPLE_CHOICE` (291), `MULTIPLE_RESPONSE` (209),
`MATCHING` (67, answers carry `matchTitle`), `FILL_IN_THE_BLANK` (6). Bank
questions can also carry `media` (e.g. an image) and a `corrects` array
alongside the per-answer `correct` flag.

## What the tool does (Phase 0 — read-only)

"Fetch question banks" in the side panel:

1. `GET /api/rise-authoring/question_banks` → save raw to
   `question-banks/_index.json`; extract the bank objects from `question_banks`
   (tolerant of array / id-map / alternate wrappers).
2. Banks carry their `questions` **inline**, so each bank object is saved
   directly to `question-banks/{id}.json` (no per-bank network call). A bank
   missing inline questions falls back to a **paced** `GET …/question_banks/{id}`.
   Source bytes are never mutated.
3. Profile: walk every bank's questions, group by question `type`, and tally
   field-paths (core = present in every question of that type, vs optional) →
   `question-banks-catalog.json` / `.csv`. The catalog also includes a
   `mediaRefs` summary (see below).

## Media (banks carry their own assets)

Question media is **snake_case** and lives under **`rise/questionBanks/{bankId}/…`**
(distinct from course media's camelCase `rise/courses/{id}/…`):

```
media: { image: { key, crushed_key, original_url, use_crushed_key, type,
                  align, alt, tracking_context, tracking_id } }
```

The shared media scanner (`scanRefs`) detects both `rise/courses/…` and
`rise/questionBanks/…`, so bank assets are inventoried alongside course assets —
banks are treated like courses (export → mutate → re-import, media kept next to
them). The bank catalog's `mediaRefs` reports media by kind (e.g. `media-image`)
with counts. (Phase 2 downloads + re-uploads + remaps these keys, same as course
media.)

## Feedback model (captured)

`feedback_type` selects which feedback texts apply:

- **`ANY`** — one `feedback` (HTML), shown regardless.
- **`CORRECT_INCORRECT`** — `feedback_correct` + `feedback_incorrect` (HTML).
- **`CHOICE`** — per-answer `answers[].feedback` (HTML).
- **absent** — legacy questions (just `feedback`, or none).

`MULTIPLE_RESPONSE` carries all correct ids in `corrects[]` (plus `correct` = the
first); `FILL_IN_THE_BLANK` uses `settings.is_case_sensitive` and multiple
acceptable `answers` (each `correct:true`).

> **Schema not yet mitm-captured.** The bank endpoints' exact response shapes are
> parsed tolerantly and the tool logs the shape on a live run (e.g. "Found N
> question bank(s) (response shape: …)") — confirm against real traffic and
> tighten the extractors if needed, the same way the content/search shape was
> nailed down.

## Migration notes (Phase 3, not built yet)

To migrate a `draw from question bank` block: recreate the bank on the target
(`POST /manage/api/question-banks` → `PUT …/question_banks/{newId}` with the
questions), then point the block's item at the **new** bank id. Banks are also
deduplicated across courses by id — a bank referenced by N courses is recreated
once. (See `rise-api-reference.md` §4 and §9.)
