# Handover — multi-language stacks (session 2026-08-02)

> **SUPERSEDED IN PART by the 2026-08-03 verification pass (v0.6.6)** — see
> `docs/STATUS.md` §"Verification pass". That pass re-verified this session's
> work against the raw captures (verdict: genuine; 3 doc errors corrected in
> `rise-multilang.md`) and FIXED, among others: gap 6 below (the real
> `available-languages` shape — the preflight now works), the storyline
> blockId-only keying, archived-locale table leaks, and surviving placeholder
> cells (now surfaced, resolution policy still pending). §1 below (the badge
> decision) is UNCHANGED and still awaits the operator test.

Branch `claude/multilang-v0.6.0`, 15 commits ahead of `master`, **not pushed**.
`v0.6.5`, 599 tests pass, `tsc` clean, builds (manifest 0.6.5). Working tree clean.

Read first: `docs/rise-multilang.md` (protocol + import algorithm), then the
read-back subsection of `docs/rise-import-protocol.md`, then `docs/STATUS.md`.
`CLAUDE.md` carries the invariants this session added.

---

## 1. ONE OPEN DECISION — the "N source changes detected" badge

**State: undecided. Nothing built. Do not build without Sergey's explicit "build".**

### What happens
A migrated stack shows Rise's *"N source changes detected — Course translations
are out of sync"* badge (45 on `AEDTROY…`, 57 on `a4MZ…`), while the sources show
2. The imported content is correct in every language — verified cell-by-cell.

### Why (operator-verified 2026-08-02 + archive evidence)
Rise keeps a per-(cell, language) sync record. A cell is **quiet** iff either:
1. an **AI translation run** once processed it — this stamps the record and, for
   cells needing no translation (images), creates **no target row**; or
2. a **target-language value was written after** the default-language value.

Operator tests: (a) there is **no dismiss affordance** anywhere in the UI;
(b) the **only** way to clear the badge is a course-wide AI run; (c) updating a
*target*-language value never raises a warning — only source-language updates do,
and an AI run overwrites the target and clears it.

A rebuilt course has no run stamps (its only run happened on the 2-string
placeholder), so cells the source holds **only in the default language** warn:
`AEDTROY…` = 45 (41 images + 4 text), `a4MZ…` = 57 (47 + 10). Their sources are
quiet because those cells existed when the source's run happened — stamped, no
row, still following default-language edits. Predicted from the archive by
`defaultOnlyCells()`; the import logs the prediction beside what Rise reports and
flags a mismatch (which would be a real signal).

Counting caveat: badge numbers are approximate — source shows **2** for 4 pending
cells in 2 blocks; target shows **45** for 45 cells in 38 blocks. Neither "cells"
nor "blocks" explains both. The *set* is what's understood, not the tally.

### Options, with the state of each

| Option | Verdict |
|---|---|
| **Mirror** default values into missing target rows | **REJECTED by Sergey.** Creates a permanent source↔target disconnect: "I changed 1 image in English, why not in the other 20 languages?" — and no in-editor fix exists (bundle has `revertToSourceAudio` only; **no image revert**), so recovery is a manual re-swap per language. |
| **Fake the `translatedAt` stamp** | **Dead.** Appears only in reads; no captured write accepts it; server-owned field class. |
| **Native dismiss** | **Dead.** Operator-verified: no such affordance. |
| **AI updates-run** (`POST …/translations/updates {}` — capture-proven, the button's own call), then optionally re-write the few genuinely-untranslated text cells from the archive | **OPEN — the only remaining route.** Crucially it does NOT cause the disconnect Sergey rejected: a run stamps image cells **without** creating target rows (exactly the source's state), so default-language edits keep propagating. Variant A re-corrects the ~4 text cells' content (re-introducing the disconnect for those few only); Variant B accepts AI text there (no disconnect anywhere). Costs: credits for pending text segments only, an unbounded wait per stack, target must have translation available (it does — localization is free). |
| **Document the badge as expected** | Always available fallback; it is a bookkeeping artifact, not a content defect. |

Accepted requirement: badge **0** is acceptable ("no biggie"); reproducing the
source's exact badge is not required.

### THE ONE UNPROVEN ASSUMPTION — settle it before building anything
Does an **incremental** updates-run stamp pending **media** the way the initial
`translateAll` did? Capture-3's click had only text pending, so this is inferred
from the source's stamped images, not observed.

**Decisive 1-minute test:** the imported scratch course in **Konstantin S** (EU)
has 45 pending cells right now, 41 of them images. With mitm running, click
**Update Translations** on it and observe:
- badge → **0** (assumption holds: media gets stamped) or → **~41** (no route
  exists; then documenting the badge is the honest answer);
- do the 4 English strings in lesson 2 turn Russian (expected — decides A vs B);
- do image cells gain Russian **rows** (they must NOT — a row is the disconnect).

That click also yields the exact envelope + poll shape needed to wire it.

---

## 2. What shipped this session (all verified: 599 tests, tsc, build)

**Multilang, end-to-end** (`85fbd2b`, `58c0861`, `4964227`, v0.6.0):
`core/l10n/` primitives (stack detection, materializer with locale→default→any
fallback, cell/batch machinery); export hardening (staleness re-fetch, materialized
census, `translations (xx)` orphan locations); `multi_language` inventory column;
the full stack import — minimal placeholder course → `POST …/translations` per
formality group (AI as a *shape factory* only) → paced await → content
copy-faithful with **source l10nIds kept verbatim** (inline `translationChanges`)
→ table-media uploads → batched cell writes **default-locale-first** → per-language
label sets → junk cleanup → clean titles LAST; plus the "Ready to import?" estimate.

**Per-language Storyline** (`02ff1e3`, `de5710d`, `4303fbd`, v0.6.1): export
resolves a stack block's `{l10nId}` media ref through the tables (one ref per
language, one zip per distinct leaf); import attaches per language
(`copy_review_item` + a `valueType:"storyline"` cell) and **never patches the
block** (that would clobber the ref for every language). Storyline cells are never
copied verbatim — the source `contentPrefix` must not ship.

**Bugs found by live testing and fixed:**
- `65f295c` **the big one**: block/item ids are client-generated and Rise's sample
  courses reuse `"1"`,`"2"`,`"3"` in **every** lesson (40 blocks / 14 distinct ids).
  `remapIds` only re-minted cuid-shaped ids, so five lessons claimed block id `"1"`
  and the server clobbered them — whole lessons lost their cells (100 of 170 on one
  course) and parity reported `block-type-changed`. `freshClientIds` now re-mints
  non-cuid ids positionally + per block; everything addressing a source block keys
  on `lessonId+blockId`. **This was a monolingual bug too.**
- `108daa0` stale cached identity made the Source≠Target guard cry "same account"
  for two different accounts — and would have attached the previous account's
  bearer to writes. Session polls now reconcile the token with the live cookie.
- `d5c97b6` built-in ("library") assets were silently DROPPED as course images
  (sample-course covers lost). Now copied verbatim + HEAD-probed on the target
  plane, flagged when unverified. **No host is ever rewritten on faith** — plane
  parity of the two libraries is unverified.
- `d91f3e4` a forgotten "Download assets" left converted-but-empty stacks. Now
  warned at run start and each affected course is skipped **before any write**.
- `f337499` log card fills the panel height.

**Read-back coverage** (`c7337fe`, `b08a554`, `3126065`, v0.6.4–0.6.5): course
fields (theme, images, settings, title — catches a leftover `!importing:`),
typeface **identity by font name**, per-language label-set bindings, storyline
`story.html` HEAD probe, question banks GET-back after PUT (failure keeps a bank
out of the bound map so draw-from-bank stays safely unbound), folder re-list.
Also fixed: flagged storyline cells were failing the language read-back despite
the flag announcing exactly that absence.

---

## 3. Known gaps / next candidates (not started)

1. **Course settings are not migrated at all** — `sidebarMode`, `navigationMode`,
   `markComplete`, `allowSearch`, `color`, `aiTutorConfig`… The v0.6.4 read-back
   now reports them honestly as `course-field-changed`. The write is small and its
   envelope is captured: `UPDATE_COURSE_DEBOUNCE {id, settings:{…}}` (capture1aug,
   `aiTutorEnabled` toggle). **Highest-value next item.**
2. **Stack web export / publish is Localize-subscription gated** —
   `build/{id}/raw` → **HTTP 500** for a stack without it (monolingual courses in
   the same account export fine). Since Stage D sources Storyline bundles from
   that export, a stack's embeds can only be migrated from a subscribed account;
   otherwise those blocks import empty + flagged. Not a tool bug.
3. `TOGGLE_LOCALE_SELECTOR` payload uncaptured → manual flag.
4. Monolingual course-level label sets unmigrated (pre-existing).
5. Glossaries out of scope (Localize-subscription gated).
6. `GET /manage/api/subscription` parse: returns 200 but our `id` lookup fails →
   `WARN could not read available-languages`. Harmless (sanity check only); needs
   the response shape from a capture.
7. Per-course folder **move** still response-trusted (best-effort + warned).
8. Typeface-name check assumes the target's `course.typefaces` map is populated
   right after our theme write — plausible from source docs, unobserved live. If
   it lags, expect spurious `typeface-unresolved` and downgrade to expected.
9. v0.7.0 recorded: parallel course creation (two internally-sequential pipelines).

---

## 4. Test-run state (Konstantin S, EU)

Left over from the v0.6.2 run, **before** the id-collision fix: 2 partial stacks
(`g5f3Xms…`, `5d_o5zod…`) plus earlier partials, all with `!importing:` titles or
scrambled blocks. **Delete them by hand** — resume re-imports a failed course from
scratch as a NEW course.

`_demo-30jul` archive is current (re-exported after the 0.6.2 build, assets
downloaded). Storyline packages staged only for the 3 monolingual `helloworld`
courses; both stacks failed the web export (gap 2 above).

**Next live run should show:** language parity clean or near-clean (id fix +
storyline-cell tolerance), covers migrated (built-in copy), the new read-backs
reporting inline, and the badge still at 45/57 until the decision in §1 is made.

---

## 5. Captures (`_multilang_capture/`, EU plane)

| File | Contents |
|---|---|
| `capture_31july.mitm` (+ `api_articulate_capture_31july.txt`) | convert a real course, add ar/bs/lv via AI, edit a translated string, edit a block, push stack to Review 360 |
| `capture1aug.mitm` | per-language label sets, `UPDATE_LOCALE`, XLIFF export/import (non-stack), `aiTutorEnabled` settings write |
| `capture1aug_2.mitm` | add a language; add/edit blocks in BOTH languages; **image swap per language** (`translationOverride`); source vs translation edits; "Update translation" click |
| `capture2aug.mitm` | **per-language Storyline attach** via Review 360; draw-from-bank inside a stack |
| `scorm_sample/` | Articulate's own 3-language SCORM export (language gate) — reference for a future "pseudo-stack" idea, out of scope |

Extraction recipe (mitmdump addon → per-flow req/resp files) is in the session
scratchpad; re-derive with `mitmdump -nr <file> -s <addon>` if needed.

---

## 6. Working agreements

- **Build only on Sergey's explicit "build".** Agreement with an approach, or
  relaxing a requirement, is NOT authorization. A "don't do anything yet" stands
  until he lifts it.
- Never wire an API shape that isn't capture-confirmed (`docs/rise-api-reference.md`
  is authoritative). Analysis/captures/read-only inspection are always fine.
- All invariants in `CLAUDE.md` apply — pacing, loud failure, copy-faithful,
  no source media keys, archive immutability.
