# Rise Multi-Language Courses ("stacks") — captured protocol + import algorithm

> Sources: three MITM captures in `_multilang_capture/` (EU plane):
> `capture_31july.mitm` (convert a real German course, add ar/bs/lv via AI, edit
> a translated string, edit a block, push the stack to Review 360),
> `capture1aug.mitm` (fresh account: label sets per language, `UPDATE_LOCALE`,
> XLIFF export/import on a NON-stack course), and `capture1aug_2.mitm` (add a
> language; add/edit blocks in BOTH languages; swap an image per language; edit
> source vs translation; "Update translation"). Official docs cross-checked:
> [Articulate Localization](https://www.articulate.com/features/localization/).
>
> Companion to `docs/rise-api-reference.md` (single-language protocol) and
> `docs/rise-import-protocol.md` (write side). Everything there still applies;
> this doc covers what multilang adds. Implemented in `core/l10n/` + the stack
> branch of `core/import/plan.ts`/`executor.ts` (v0.6.0).

---

## 1. Concept

A multilang course is **one course** holding N languages with a shared
structure and per-language text — switchable in the editor, preview, and Review
360. There is a single course id, ONE set of lessons/blocks (adding/removing a
block — or an item inside a block — affects every language), and a localization
overlay. Each language is a **stack item** (aka **locale**), a UUID row.
Localization is available on every subscription (only publishing a stack to
SCORM is plan-gated). **The only way to create a stack is to add a language,
and adding a language always AI-translates** — there is no "add empty
language" call (operator-confirmed; the basis of the import design, §7).

## 2. Data model — the l10n overlay

Conversion (first `POST …/translations`) rewrites the course document
server-side: every localizable value — course `title`, `description`, `media`
(logo), `coverImage.media`, lesson `title`s, block text/media fields — is
replaced in place by a ref `{"l10nId":"<uuid>"}`, and the values move into
per-locale tables. `course.localizationMetadata={isLocalized:true,localizedAt}`
and `course.defaultLocaleId=<locale row uuid>` mark the stack. `GET_COURSE`
gains a populated `payload.l10n` (a monolingual course has only
`languageCodeMetadata` there):

```jsonc
payload.l10n = {
  "defaultLocale": "en-us",           // the DECLARED source language (not detected)
  "showLocaleSelector": false,        // learner-facing language menu
  "languageCodeMetadata": { /* ~208 codes: names, rtl, tts availability… */ },
  "locales": [                        // one row per language
    { "id": "7afe55b7-…",             // == stackItem id; default row == defaultLocaleId
      "courseId": "…", "locale": "en-us",
      "labelSetId": "kUVBZ…" | null,  // per-language label set (null → language default)
      "rightToLeft": false,           // server-set (ar → true)
      "formality": null | "default" | "more" | "less",
      "glossaryId": null, "glossaryGroupId": null,
      "createdAt": "…", "updatedAt": "…", "deletedAt": null }  // deletedAt = archived
  ],
  "translations": {                   // THE cell tables, keyed by locale code
    "en-us": { "<l10nId>": <value>, … },
    "ru":    { … }
  }
}
```

Facts that drive the migration design:

- **Cell values** are plain strings (`valueType:"plain"`), HTML (`"rich"`), or
  **full media objects** (`"mediaRecord"` — `{image:{key,crushedKey,…}}`,
  audio, video). In the 31-July course ~96 of 97 media keys lived inside the
  tables; only note **attachments** stayed in the lessons doc.
- **Cells exist in ANY subset of locales.** A block authored while viewing
  Russian has ru-only cells; a swapped image lives only in the edited locale
  (with `translationOverride:true`). Rendering falls back across locales, so
  materialization resolves `locale → defaultLocale → any` (core/l10n/materialize.ts).
- **Media IS localizable per language** ("editing a target language disconnects
  the asset from the source" — official docs). A single-row cell is what every
  language shares; that's why swapping an image sometimes "changes all
  languages" (that cell had one row).
- **Pending ("new content, untranslated") rule** (capture-derived): a cell is
  flagged per target locale iff the default-locale row is NEWER than that
  locale's row, or the target row is missing. Target-only cells are never
  flagged. ⇒ **write default-locale values BEFORE target-locale values**;
  cells that are default-only in the source stay flagged on the target —
  faithful — and the report warns: **never click "Update translation"** on a
  migrated stack (it AI-translates exactly those cells).
- `defaultLocale` is operator-DECLARED at conversion, never validated (a German
  course declared `en-us` converts happily).
- Label sets are **account-scoped**; the default locale row points at the
  course's own set (`course.labelSetId`), other rows bind per language or fall
  back to the built-in `defaultLabelSets` for their `iso639Code`.
- The learner runtime gets the same overlay (`GET /api/rise-runtime/boot/{id}`
  → base64 JSON with `l10n`); refs resolve client-side.
- The content/search listing carries `locales[]` + `defaultLocaleId` per course
  (basis of the inventory `multi_language` column — zero extra HTTP).

## 3. Stack metadata (manage/api)

`GET /manage/api/content/{courseId}/translations` — the stack state (the
"Manage languages" screen at `/manage/locales/{courseId}` polls it). **204 /
empty body = not a stack.** 200 body: `authorPermissions` (incl. the `l10n:*`
family), `type:"single-course"` (even for stacks), `defaultLocaleId`,
`canPublishToReview`, `reviewStackExists`, `glossaries`, and `stackItems[]`:
`{id, locale, title, status, formality, translateAction, glossary*,
reviewImportStatus, hasTranslations, pendingChangesCount, deletedAt, …}` with
status lifecycle `queued → preparing → translating → applying → finalizing →
complete` (also seen: `ready to translate`). Minimal-course conversions
completed in 15–70 s per language across all captures.

Related:
- `GET …/translations/updates` — pending source edits per target locale:
  `{updateCount, localeUpdateCounts, courseUpdates, lessonItemUpdates:{<lessonId>:
  {<blockId|root>:[{locale, localeId, l10nId, updatedAt, value, valueType,
  translatedAt:null, targetValue}]}}, mondrianUpdates, aiScenarioUpdates,
  inProgress}`. Storyline-block (mondrian) and AI-scenario text are separate
  translation subsystems — consistent with the placeholder policy we don't
  migrate them per-language.
- `POST …/translations/updates {}` → **"Update translation"**: AI re-translates
  only the pending cells. **The migrator never calls it**, and warns operators
  off it (see the pending rule, §2).
- `GET /manage/api/translations/recent` → `{"recentTranslations":["ar","lv"]}`.
- `GET /manage/api/translations/language-code-metadata` — the code table.
- `GET /manage/api/subscription/{subId}/available-languages` —
  `{planInfo:{creditLimit, creditsUsed, remainingCredits, translationTier},
  languagesInfo:{sourceLangs:[…], targetLangs:[{targetLang,…}], formalities…}}`.
  Informational (localization is free); the import uses it only as a pre-write
  locale-code sanity check.

## 4. Writes

### 4.1 Create / add languages (the only stack factory)

```
POST /manage/api/content/{courseId}/translations
{"sourceLanguage":"en-us","targetLanguages":["ar","bs","lv"],"formality":"more"}
→ 200, empty body
```

First call converts the course (extracts every localizable value into cells
under the DECLARED default locale, creates the default locale row) and queues
an AI job per target language (`translateAction:"translateAll"`; `formality`
is per-CALL — group target languages by formality). Later calls add languages.
Poll §3 until every stack item is `complete`, or listen on the conveyor socket:
`rise/courses/BULK_TRANSLATION_PROGRESS` / `BULK_TRANSLATION_DONE`,
`rise/l10n/UPDATE_PENDING_TRANSLATIONS` (document data never rides the socket).

### 4.2 Content writes on a stack — `translationChanges` (capture-proven)

Structure calls are the normal ducks envelopes; the l10n twist is that creates
carry the cell values inline, with **client-generated l10nIds**:

- `CREATE_LESSON {…, title:{l10nId}, translationChanges:[{action:"add",
  l10nId, locale, value, valueType:"plain"}]}`
- `CREATE_BLOCKS {…, blocks:[…{l10nId} refs…], translationChanges:[{action:
  "add", l10nId, lessonId, locale, value, valueType:"rich"|"plain"|
  "mediaRecord"}]}` — a block created while viewing ru writes ru-locale cells.
- `UPDATE_BLOCK_DEBOUNCE` ships blocks with refs verbatim (re-pointing refs is
  how the editor re-shapes a block), then the client GCs orphaned ids via a
  batch `delete` and writes edited cells via batch `update`.

### 4.3 `UPDATE_L10N_BATCH` — the cell write/delete path

```
POST /api/rise-runtime/ducks/rise/l10n/UPDATE_L10N_BATCH
{"type":"rise/l10n/UPDATE_L10N_BATCH","payload":{"courseId":"…","changes":[
  {"action":"add","l10nId":"…","lessonId":"…","locale":"ru","value":"<div>…</div>","valueType":"rich"},
  {"action":"update","l10nId":"…","locale":"ru","value":{"image":{…,"translationOverride":true}}},
  {"action":"delete","l10nId":"…"}                    // removes the id across ALL locales
]}}
→ 200 {payload:{changes:[…echo, add echoed as update…], courseId, updatedAt, contentUpdatedAt}}
```

Object (media) values are accepted (per-locale overrides carry
`translationOverride:true`). Every captured envelope is single-locale — the
migrator keeps that. Editing a translated string holds a lock
`l10n/{courseId}/{l10nId}` (normal PUT_LOCK/DEL_LOCK); success mirrors on the
socket as `UPDATE_L10N_BATCH_SUCCESS`.

### 4.4 Locale rows + label sets

- `rise/l10n/UPDATE_LOCALE {courseId, locale, labelSetId}` → the full locale
  row (binds a label set to a language).
- `rise/labelSets/CREATE_LABEL_SET {iso639Code, name}` → a new ACCOUNT-scoped
  set pre-filled with Rise's built-in labels for that language (full set incl.
  id echoed back).
- `rise/labelSets/UPDATE_LABELS {id, labels:{key:value,…}}` — partial update.
- `rise/l10n/TOGGLE_LOCALE_SELECTOR` exists (runtime bundle) but its payload is
  NOT capture-proven → the import flags `showLocaleSelector` manually.

### 4.5 Stack management (manage bundle; NOT exercised — document only)

`POST /manage/api/content/{id}/translations/<verb>`: `archive` / `restore`
(archived = stack item with `deletedAt`; the "Archived translations" screen is
client-rendered from the same data), `cancel`, `retry[?locale=]`, `breakout`
(split locales into separate courses), bare `DELETE …/translations/` (remove
languages), `PUT/POST …/translations/` (re-translate pending, carries
`overwriteLocales`). Plus `POST /manage/api/translations/import?id=` and
`import-review-updates`. **Duplicate is stack-aware**: `POST …/duplicate`
carries `copyTranslationData` (duplicate WITH translations) and `ejectLocaleId`
(materialize ONE language as a plain course — the native in-account split;
"Save as new course" in the UI).

### 4.6 XLIFF (NON-stack courses only)

`GET /api/rise-runtime/export_course_translation/{courseId}` → XLIFF 1.2 body
(file per course + per lesson; `<g>` wraps HTML). Import: `GET_YURL
{assetPath:"translations/", filename:"x.xlf"}` → presigned S3 PUT → ducks
`rise/courses/IMPORT_TRANSLATION {id, key}` → replaces the course's text in
place (response echoes the course). Not used by the migrator (blocks are
written directly); documented for completeness.

### 4.7 Review 360

`POST /api/rise-runtime/manage/content/{id}/publish/review {bundles, title,
locales:[…], reviewItemId:<defaultLocaleId>}` → one Review item carrying the
whole stack (language switcher in Review); poll `POST
/api/rise-packages/api/packages {ids:[…]}` as usual. We never publish.

## 5. Export / inventory / census (v0.6.0 behavior)

- **Export**: raw `GET_COURSE` archives verbatim — the full overlay included.
  The exporter re-fetches an archived course when the LISTING shows languages
  the archive predates (`archiveIsStaleForLocales`); log lines carry
  ` — multi-language (codes)`.
- **Inventory**: `multi_language` column (codes default-first) from the
  listing's `locales[]`.
- **Census/novelty**: stacks are scanned MATERIALIZED (default locale) so block
  profiles show real values, not `*.l10nId` noise; unresolved refs WARN.
- **Assets**: discovery scans the RAW doc — table media (incl. per-locale
  overrides) is downloaded like any media; orphan locations format as
  `translations (ru) › …`.

## 6. Import algorithm (implemented; core/import plan+executor stack branch)

0. **Preflight** (orchestrator, zero writes): every non-default source locale
   code must appear in the target's `available-languages.targetLangs`
   (sanity check only; a fetch failure downgrades to a warning).
1. Shell (`POST /manage/api/content` + GET_COURSE handshake) → **placeholder
   lesson** (plain-string title = source lesson 1's default-locale title; it IS
   the future lesson 1) → provisional `!importing:` title → placeholder
   description `'.'` (creates the description ref at conversion) → course
   images (cover/card/logo/lessonHeader) from the MATERIALIZED default locale,
   uploaded + set as plain objects (conversion refs them itself; AI never
   touches media).
2. **`convert-stack`**: one `POST …/translations` per source formality group,
   `sourceLanguage` = the source's `defaultLocale`. AI runs on the placeholder
   strings only.
3. **`await-stack`**: paced poll of §3 until every language is `complete`
   (default 240 polls ≈ 8 min ceiling), then GET_COURSE → assert l10n-ified,
   learn the target's own course-level refs (`courseRefMap` source→target by
   structural position + the lesson-1 title pair), snapshot the pre-content doc
   as the junk-cleanup baseline. Unmatched source course refs → `l10n-ref`
   manual flags.
4. **Table media uploads** (`upload-l10n-asset`): every key found in the source
   tables (all locales) through the normal GET_YURL→S3 chain into `keyMap`;
   orphans blank+flag as usual.
5. **Content, copy-faithful with SOURCE l10nIds kept verbatim** (no id mapping
   for lesson/block cells): lesson 1 = `update-lesson` on the placeholder;
   lessons 2+ = `create-lesson` with `title:{l10nId:<source id>}` + inline
   default-locale title cell; every lesson's `create-blocks` ships the source
   blocks (refs intact) + inline `translationChanges` (default locale,
   media-remapped values, TARGET lesson id).
6. **`write-l10n`**: every remaining source cell, batched ~20/envelope, ONE
   locale per envelope, **default locale first** (pending rule §2), values
   media-remapped, course-level ids mapped through the ref map, `lessonId` on
   adds mapped to target lessons. Title/description cells are EXCLUDED here.
7. **`set-locale-labelset`**: for non-default locales with a custom
   `labelSetId`: `CREATE_LABEL_SET` (+ `UPDATE_LABELS` with the diff vs the
   language's default set) + `UPDATE_LOCALE` bind; deduped run-wide by source
   set id. (Course-level label sets for monolingual courses remain a documented
   gap — no captured binding envelope.)
8. **`cleanup-l10n`**: delete target cells that map to nothing in the source
   (computed against the §3 snapshot — placeholder-era only; usually empty).
9. **`set-stack-titles`** — the LAST step (partial-title invariant): clean
   title + description cells for every locale (default first) onto the
   target's own refs. A graceful Stop renames via the title CELL
   (`!unfinished:`) once the course is converted — never a plain-string title
   write, which would clobber the ref.
10. `showLocaleSelector` true → `locale-selector` manual flag (§4.4).

**Read-back**: unfiltered `findForeignMediaKeys` over the target GET_COURSE
(covers tables) + `verifyL10nParity` (locale sets; cell-by-cell equality modulo
media tokens/volatile fields; extra-cell detection) + per-language
`pendingChangesCount` recorded in the report with the standing warning. Any
divergence → the course is `partial`, never `imported`.

**Resume** policy is unchanged (course granularity): a stack that failed
mid-build keeps its `!importing:`/`!unfinished:` marker and is re-imported from
scratch; delete the partial by hand.

## 7. Known gaps / open questions

- `TOGGLE_LOCALE_SELECTOR` payload (manual flag until captured).
- Exact bodies for `archive/restore/cancel/breakout/DELETE translations/`
  (UI dialogs not opened during capture) and XLIFF stack flows.
- Stacks containing draw-from-bank or Storyline blocks: bank questions and
  mondrian translations are separate subsystems — those blocks follow the
  existing placeholder/flag policy (no per-language migration).
- Glossaries: gated behind an active Localize subscription; fields
  (`glossaryId`/`glossaryGroupId`/`glossaryStats`) mapped, no code — locale
  rows import with `glossaryId:null`.
- Publish (LMS/web) for stacks not captured (the SCORM sample in
  `_multilang_capture/scorm_sample/` is Articulate's demo: a language-gate
  loader — future reference for the "pseudo-stack" idea, out of scope).
- Multilang captured on the EU plane only; envelope parity with US assumed
  (held for the entire rest of the protocol) — first US run's read-backs verify.
- Operating assumption: the source account is quiescent during migration
  (no special handling for mid-translation sources).
