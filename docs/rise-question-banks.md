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

## Question schema (from API ref + inline-question captures)

A question:

```
{ id, type, title (HTML), answers: [{ id, title, correct, matchTitle? }],
  feedback, correct? }
```

Question `type`s seen across the 581-course library (as inline blocks; banks
reuse the same shapes): `MULTIPLE_CHOICE` (291), `MULTIPLE_RESPONSE` (209),
`MATCHING` (67, answers carry `matchTitle`), `FILL_IN_THE_BLANK` (6).

## What the tool does (Phase 0 — read-only)

"Fetch question banks" in the side panel:

1. `GET /api/rise-authoring/question_banks` → save raw to
   `question-banks/_index.json`; extract bank refs (`{id, title}`), tolerant of
   array / id-map / `{questionBanks|banks|content|…}` wrappers.
2. For each bank, **strictly sequential + paced** (~2s + jitter),
   `GET …/question_banks/{id}` → save raw to `question-banks/{id}.json`
   (skips already-saved). Source bytes are never mutated.
3. Profile: walk every bank's questions, group by question `type`, and tally
   field-paths (core = present in every question of that type, vs optional) →
   `question-banks-catalog.json` / `.csv`.

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
