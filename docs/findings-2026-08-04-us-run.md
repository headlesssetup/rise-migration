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

### F0 — REAL BUG (found via F6+F7, capture-proven): cross-plane token poisoning
JWT decode of `capture_import` shows Konstantin's EU bearer (`auth0|b5221c80…`,
same `exp` as on rise.eu) attached to SEVEN requests on `rise.articulate.com`:
1× `GET /manage/api/content/search` (the pre-pin identity/guard probe), 3× bank
creates (accepted!), 3× question PUTs (403 "unauthorized"). Mechanism: with no
US course editor ever opened, `auth.us.token` was empty; an UNPINNED probe used
`tokenFor`'s cross-plane fallback (`latestPlane` = eu) → the EU token rode a US
request → the webRequest token sniffer keyed that request by its URL's plane
and **captured our own header into the US slot** (self-sniffing feedback loop)
→ even strict/pinned calls then got the EU token "legitimately". Consequences
observed: (a) the first bank run's 403s; (b) the same-account guard fired
because the target identity WAS Konstantin's — substantively a TRUE positive
("about to write with the source account's token") with a misleading label; the
operator overrode it believing it false. Opening a US course editor let the
SPA's genuine requests re-capture Elza's token and everything after was
correct. Fix direction: (1) the sniffer must never capture a header the
extension itself attached (e.g. skip when the value equals a token already held
in ANY slot); (2) drop the cross-plane fallback for authoring calls entirely —
an empty target-plane slot should BLOCK with "open a course editor on the
target account", never borrow; (3) the guard identity must come from the
target plane's own slot only. Supersedes the F6/F7 readings below.

### F4 — US-PLANE DIFFERENCE: single-bank GET returns 404
Second bank run: `PUT /api/rise-authoring/question_banks/{id}` → **200 with the
full bank + questions echoed** (the write SUCCEEDED), then the v0.6.5 read-back
`GET /api/rise-authoring/question_banks/{id}` → **404 {"error":"Not Found"}** —
deterministically, for all 3 banks, seconds after the 200. On EU this GET
worked. Either the US build lacks the single-bank route or it lags; the LIST
endpoint (`GET /api/rise-authoring/question_banks`) returned 200 with full
data in the same session (and the run-2 GETs carried the CORRECT Elza token —
verified against the F0 poison list — so the 404 is genuine, not auth-shaped).
Consequences: (a) the 3 banks were mislabeled "FAILED … empty bank left on
target" — they are NOT empty (PUT echo proves the questions are there);
(b) they stayed out of the bound map, so draw-from-bank blocks were flagged
instead of bound. Fix direction (operator-corrected): a deterministic 404 means
WE have the wrong route for this plane — capture the US editor's own bank read
(open Question Banks, open one bank, with mitm on) and mirror it; do not paper
over with a speculative fallback. Also correct the failure message.

### F5 — INSTRUMENTATION: pending counts are lazy AND in different units
(RESOLVED by the operator's UI check, 2026-08-04.) `pendingChangesCount` = 0 in
every poll and at read-back (capture-verified) — but hours later the badges
show: "Just a co" **8** (predicted 0 — but that course is corrupted by F1, and
its crossed/missing rows ARE pending cells), Email **63** (predicted 11),
LOCALIZED micro **4** (predicted 2). Conclusions: (1) the badge/pending number
materializes LAZILY — reading stackItems seconds after import is useless;
(2) the badge counts **text segments**, not cells (the Articulate docs' term;
the EU 45=45 coincidence held only because those cells were 41 IMAGES ≈ 1 unit
each; Email's 11 text-heavy cells → 63 segments; micro's 2 → 4) — so
predicted-vs-shown TALLIES can never be compared 1:1. Fix direction: compare
the SET of pending cells, not counts — `GET …/translations/updates` lists each
pending (l10nId, locale) entry; read it (possibly delayed / on a later pass or
documented as operator-checked) and match l10nIds against `defaultOnlyCells`.
**Capture wanted:** open Manage-languages of the three imported stacks with
mitm on — the updates payloads are the recalibration data.

### F6 — first-run bank 403s: SUPERSEDED by F0
Initial reading ("valid token, no editor open, reauth rightly refused") was
incomplete: the PUTs 403'd because they carried the SOURCE account's EU bearer
(F0 poisoning), which rise-authoring rejected as "unauthorized". The message
improvement stands: on a 403 with a non-advancing token, tell the operator to
open a course editor on the TARGET account.

### F7 — same-account guard match: SUPERSEDED by F0
The operator used two DIFFERENT Articulate IDs (Konstantin EU / Elza US). The
guard matched because the target identity was computed from the POISONED US
slot holding Konstantin's token — a true positive in substance (the run really
was about to write with the source account's credentials), mislabeled as
"same account". The fix is F0 (never borrow cross-plane; block on an empty
target slot), after which this situation reads "no token for the target plane —
open a course editor there" instead of tempting an override.

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
1. **F0 token poisoning** (top priority — safety class): sniffer never
   captures our own attached header; no cross-plane fallback for authoring
   calls (empty target slot ⇒ BLOCK with "open a course editor on the target
   account"); guard identity from the target plane's slot only.
2. F1 executor lesson-1 pairing via orderLessons (small, regression-tested).
3. F2 onePage: reuse the shell's lesson as lesson 1 (+ doc updates).
4. F3 parity: target-only ref over a deep-empty source slot → expected.
5. F4 bank read-back: mirror the US editor's own read route (needs the US
   bank mitm) + honest failure message.
6. F5 pending comparison by SET via `…/translations/updates` (needs the
   Manage-languages mitm of the three imported stacks).
7. F9 materialized titles in manual-work locations (cosmetic).

## Capture round 2 (`capture_banks-and-count.mitm`, 2026-08-04) — F4 + F5 RESOLVED

### F4 resolution: the US editor has NO per-id bank GET
Opening a bank in the US editor fires ONLY:
- `GET /api/rise-authoring/question_banks` (the LIST — full bank objects WITH
  `questions[]` inline: keys `{author_id, deleted, folder_id, id,
  last_edited_by, questions, title, updated_at, version}`), and
- `GET /api/rise-runtime/question-banks/{id}/transcodes` (media transcodes).
So the per-id authoring GET our read-back used does not exist on US (the 404
was the genuine answer), and the CORRECT read-back — the editor's own route —
is the LIST, filtered by id. Fix direction updated accordingly (this satisfies
"use the right address": it IS what the editor does).
Side observation to eyeball: the LIST shows `emom9rnw…` (a 403-run "empty"
bank) with 1 question — reconcile in the UI before deleting.

### F5 resolution: the REAL pending rule (US, capture-proven from full payloads)
The three `…/translations/updates` payloads (updateCount 63 / 8 / 4, matching
the badges exactly) list **255 / 25 / 8 pending (cell, locale) entries** —
essentially EVERY target-locale text cell we wrote, not just the predicted
default-only cells (11 / 0 / 2). Decisive fields: every entry carries
`targetValue` = our proofread Russian (Rise SEES the target rows) and
`translatedAt: null` (except the 3 conversion-stamped placeholder cells). So on
US the rule is: **pending ⟺ default row's `updatedAt` > the cell's
`translatedAt` (AI stamp) — a manually-written target row does NOT clear it.**
The EU-derived rule ("target row newer than default ⇒ quiet"), which the
write-order invariant was built on, is FALSIFIED on the US plane — either
plane version skew or the EU 45-badge measurement needs re-examination
(re-measure on EU when convenient). `updateCount` (the badge number) is a
smaller segment-ish tally (63 for 255 cells) — decorative; the SET is the
truth. `mondrianUpdates`/`aiScenarioUpdates` are non-empty (2/2) on every
course — separate subsystems, not ours.

Consequences for the §6b badge decision:
- On US targets, EVERY migrated stack pends ~all its text cells; "document the
  badge" means a huge badge and a full pending list — much less palatable.
- The updates-run route inflates: an AI run would overwrite ALL proofread
  target text (not 4 cells) with AI. It can still work as: run → re-write ALL
  target rows from the archive (target edits never flag — that rule IS
  operator-verified) → badge 0 with correct content; but that is a full AI
  pass (credits, on paid plans) + a full second write pass + transient AI text.
- **Idea 2 (full course first, convert once) is now clearly the superior
  shape**: the initial conversion stamps every cell BEFORE we overwrite the
  target rows, and default rows are never touched post-conversion — quiet
  under BOTH rule models, no second pass, no post-hoc run. Its open cost
  question stays: does the conversion consume credits on paid plans
  (creditsUsed check pending).
