# Findings — first cross-plane live run (EU→US), v0.6.6, 2026-08-04

Operator run: fresh EU source account (4 courses: 2 stacks, 1 onePage stack,
1 onePage monolingual; 3 banks; 5 folders; storyline + uploads) → exported →
imported into a US account ("Elza Upmane"). Artifacts in `_export_test_4aug/`
(3 mitm captures + extension log + the archive + `_import/` reports). Every
discrepancy below is root-caused from the captures. **Analysis only — nothing
built.**

## Headline

The run did exactly what it was for. All 4 courses landed `partial` — and every
cause decodes: ONE real v0.6.6 code bug (lesson-order pairing), TWO new
protocol facts (onePage shell lesson; US bank GET-back 404), ONE systematic
benign artifact our new honesty misclassifies (the l10n-ified empty logo slot),
and ONE instrumentation gap (pendingChangesCount is the wrong/too-early
signal). The big positive: **US-plane multilang envelope parity is now
live-confirmed** — conversion POST, the queued→…→complete lifecycle,
UPDATE_L10N_BATCH, the l10n overlay, and the FIXED preflight
(subscription.subscription_id + targetLangsIndexedBySourceLang parsed fine on
US, no WARN-skip).

## Findings

### F1 — REAL BUG: stack lesson-1 ref pairing uses raw array order
"Just a co": the archive's `lessons[]` array order is INVERTED vs the
authoritative `course.lessons` id list (array `[iWZ…, slpoacpk…]`, authoritative
`[slpoacpk…, iWZ…]`). The plan orders lessons authoritatively (`orderLessons`),
but the executor's await-stack lesson-1 pairing takes
`deps.input.course.lessons?.[0]` — the RAW array — so it mapped the WRONG
source title ref onto the target placeholder's ref. Result: the ru lesson
titles crossed (target shows "Здравствуйте" where the source has "просто имя"),
read back honestly as `cell-changed` + `missing-cell` + partial. Fix (small):
pair `ordered[0]` (authoritative), same ordering the plan and parity use.
This is the same lesson as the "do NOT sort by position" rule — raw array
order is not display order.

### F2 — NEW PROTOCOL FACT: a `onePage` shell ships WITH one pre-created lesson
Capture-verified: `POST /manage/api/content {type:"onePage"}` → the handshake
GET_COURSE already contains ONE lesson (`type:"blocks"`, empty title). Both
microlearning imports then created their own lesson → the target has TWO
lessons (`extra-lesson` divergence → partial); on the stack variant the phantom
also gets l10n-ified at conversion. Regular and `aiOutline` shells are
lessonless (also confirmed: `type:"aiOutline"` rides the create verbatim, per
the preserve-course-type rule). Fix direction: for onePage, REUSE the shell's
lesson as lesson 1 (update it — the exact pattern the stack placeholder already
uses), never create a second one. Doc updates needed in rise-api-reference §7 /
import-protocol.

### F3 — SYSTEMATIC BENIGN ARTIFACT: conversion l10n-ifies the EMPTY logo slot
All three stacks show `extra-cell en-us <uuid>` — the uuid is the TARGET's
`course.media` (cover-page logo) ref every time. The conversion mints a
ref+cell for `course.media` even when the slot is EMPTY and the source has no
logo, so courseRefMap (source-driven) can't map it. The 0.6.6 dangling-ref
guard correctly KEPT the cell (pre-0.6.6 junk cleanup would have deleted it and
left `course.media` pointing at a dead id — the guard proved itself). But
parity then counts it as an unexpected `extra-cell` → every no-logo stack goes
`partial`. Fix direction: classify a target-only ref whose SOURCE slot is
deep-empty as EXPECTED (the l10n analog of the random-default-cover rule).

### F4 — US-PLANE DIFFERENCE: single-bank GET returns 404
Second bank run: `PUT /api/rise-authoring/question_banks/{id}` → **200 with the
full bank + questions echoed** (the write SUCCEEDED), then the v0.6.5 read-back
`GET /api/rise-authoring/question_banks/{id}` → **404 {"error":"Not Found"}** —
deterministically, for all 3 banks, seconds after the 200. On EU this GET
worked. Either the US build lacks the single-bank route or it lags; the LIST
endpoint (`GET /api/rise-authoring/question_banks`) returned 200 with full
data in the same session. Consequences: (a) the 3 banks were mislabeled
"FAILED … empty bank left on target" — they are NOT empty (PUT echo proves the
questions are there); (b) they stayed out of the bound map, so draw-from-bank
blocks were flagged instead of bound. Fix direction: fall back to the LIST
read-back (find by id) when the single GET 404s; correct the failure message.

### F5 — INSTRUMENTATION: `stackItems[].pendingChangesCount` reads 0 at import time
Both stacks: predicted 11 / 2 pending fallback cells; `pendingChangesCount` = 0
in EVERY poll and at read-back (capture-verified). The new symmetric anomaly
warning fired — good — but its "a translation run may have fired" hypothesis is
likely wrong: the EU "45/57" evidence was the UI BADGE (the `…/translations/
updates` endpoint's `updateCount`), never `pendingChangesCount` right after an
import. So we are likely comparing the prediction against the wrong field, or
too early (lazy server-side computation). **Operator check pending:** open the
two imported stacks' Manage-languages screens now — if the badge shows 11 / 2,
the prediction is right and the read-back must use the updates endpoint (or a
delay); if 0, US stamps differently (would be a major, pleasant surprise).

### F6 — first-run bank 403s: behavior correct, message insufficient
No US course editor was ever opened → the plane's `_articulate_rise_` bearer
couldn't rotate; `reauth` correctly refused to retry (token exp hadn't
advanced), and the PUTs failed 403 `{"error":{"type":"unauthorized"}}`. Working
as designed — but the operator got "write questions failed (HTTP 403)" with no
hint. Fix direction: when a 403 fails and reauth reports no-advance, say
"open a course editor on the TARGET account and re-run" explicitly.

### F7 — same-account guard across planes (screenshot)
Source (EU) and target (US) share the operator's Articulate ID, so the guard
matched by JWT `sub` and demanded an override even though the planes differ.
Correctly cautious, but the message should be plane-aware ("same signed-in
user, DIFFERENT plane — cross-plane migration under one login needs override").

### F8 — confirmations (no action)
- Stack web export → `build/raw` HTTP 500 on both stacks at the (unsubscribed)
  source; the monolingual package exported + later uploaded fine. Matches the
  Localize gate exactly.
- Storyline upload AFTER course import does not retro-attach (resume is
  course-granular); the test-plan order (stage+upload BEFORE import) stands.
- Folders, fonts (68), typeface matching (19 on target), census/novelty,
  asset download/dedup, `[i/N preflight]`, honest partial statuses — all clean.
- US `available-languages`: the target is on a PAID plan (`plan:"pro"`,
  creditLimit 5000, creditsUsed 1670). **Idea-2 cost implication:** paid plans
  meter credits; whether OUR conversions consume them is unknown — operator
  check: compare creditsUsed now vs 1670. ("Localization is free" may only
  mean the unpaid tier exists — the docs' claim needs sharpening.)

### F9 — cosmetic
Manual-work locations print a lesson ID where the title should be on stacks
("Lesson 1 \"slpoacpk…\"") — buildBlockIndex reads the raw (ref) title; should
materialize.

## Operator cleanup on the US target
- Delete the 3 truly-empty banks from the 403 run: `rsgdp66d8qqkfry3k03zg5qd`,
  `lp9sqeuniywoof10rwp5newb`, `emom9rnw2y8l7fdkkkfjalx0`.
- The 3 banks from the second run (`koxhdakin1l4lu18ofti3bzs`,
  `z2do46u1umwspikkah9y81sk`, `dtuhf5kfx9cb846knwklrids`) DO hold the
  questions — verify in the UI, keep or delete before a re-run.
- The 4 partial courses: F1's course has crossed ru lesson titles (delete
  before re-import); the other 3 are content-correct modulo the F2 phantom
  lesson (micro courses) and unbound/unattached flags.

## Proposed fix list (NOT built — awaiting "build")
1. F1 executor lesson-1 pairing via orderLessons (small, regression-tested).
2. F2 onePage: reuse the shell's lesson as lesson 1 (+ doc updates).
3. F3 parity: target-only ref over a deep-empty source slot → expected.
4. F4 bank read-back: LIST fallback on single-GET 404 + honest message.
5. F5 pending read-back via `…/translations/updates` (and/or defer) — after
   the operator's badge check decides which signal is real.
6. F6/F7 messages; F9 materialized titles in manual-work locations.
