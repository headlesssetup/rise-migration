# Test plan — v0.6.6 live verification + decision captures (2026-08-03)

Four phases. Phases 1–3 run EU→EU with the existing `_demo-30jul` archive;
phase 4 covers the US plane (the real business direction is US→EU and multilang
was captured EU-only — envelope parity is assumed, not proven). One mitm file
per phase, named below, so the analysis can tell them apart.

## Prep (before recording anything)

1. **Extension**: build + load 0.6.6 (`pnpm build` → load/reload
   `.output/chrome-mv3`); confirm the card shows **0.6.6**.
2. **mitm**: system-proxied browser as usual; start a fresh file per phase:
   `rise066_dry.mitm`, `rise066_import.mitm`, `rise066_decision.mitm`,
   `rise066_us.mitm`.
3. **Target (Konstantin S, EU)** — clean up the graveyard first, by hand:
   delete every leftover course titled `!importing:` / `!unfinished:` and the
   two pre-v0.6.3 partial stacks (`g5f3Xms…`, `5d_o5zod…` — scrambled blocks).
   Resume never repairs partials; they only pollute this test.
4. Keep **one Rise course-editor tab open** on the target account for the whole
   run (token rotation needs it) and keep the **side panel open** (its lifetime
   is the run's lifetime).
5. Archive: `_demo-30jul` as-is (assets downloaded; storyline staged for the 3
   monolingual `helloworld` courses; both stacks have no staged storyline —
   Localize gate at source). No re-export needed.
6. **Discipline**: do NOT click "Update Translations" anywhere except step 3a,
   on the one designated course, at the designated moment.

## Phase 1 — dry-run (capture `rise066_dry.mitm`, expect ZERO writes)

1. Select all 5 demo courses (3 helloworld + 2 stacks) in step C.
2. Check the "Ready to import?" line: `5 course(s) (2 multi-language)`, a rough
   time, and — new — it must NOT say "not in archive" or "unreadable/plan
   error" for any of them.
3. Run **dry-run**. Expect: plan preview only; the capture must contain no
   POST/PUT to rise.\* (reads only); no CDN HEAD bursts (dry runs are
   network-free for probes).

## Phase 2 — live import EU→EU (capture `rise066_import.mitm`)

Run the live import of all 5. Watch the log for the 0.6.6-specific lines:

- `[i/5 preflight] checking archived assets…` — new progress line.
- The locale sanity check must now RUN: no
  `WARN could not read available-languages` / `skipping the locale-code sanity
  check` line. (Its absence IS the pass signal.)
- Storyline (helloworld courses): `✓ attached storyline` per block, then
  `storyline read-back OK — …/story.html`.
- Stacks: conversion → paced await → cells; at the end the badge NOTE must
  read `as expected` per language — predicted ≈ **45** for `AEDTROY…`, **57**
  for `a4MZ…`. A `⚠ The count does NOT match the archive` or a
  `⚠ Pending-count anomaly` line is a REAL signal — stop and save the log.
- These lines must NOT appear: `placeholder cell(s) survive` (sources hold all
  title/desc rows), `⚠ FLAG locale` (no archived languages in the sources),
  `Language parity DIVERGENCES`, `Parity DIVERGENCES`.
- Final statuses: 5 × `imported` (not `partial`) is the target outcome.

Then eyeball in the Rise UI:
- Each stack: language switcher works; titles/descriptions clean in EVERY
  language (no `!importing:`); the per-language swapped image shows the right
  image per language; covers/cards/logos present (built-in covers included).
- helloworld courses: storyline blocks actually play.
- The two stacks show the "N source changes detected" badge (45 / 57) — that is
  EXPECTED and required for phase 3.

Keep the `_import/*.report.md|json` files — send them back with the captures.

## Phase 3 — decision captures (capture `rise066_decision.mitm`)

Order matters: 3a happens BEFORE any other edit on that course.

**3a. THE badge test** (handover §1 — settles the one unproven assumption).
On the freshly imported `AEDTROY…` copy (badge = 45, 41 images + 4 text):
1. Note the badge number, then click **Update Translations**. Wait for the run.
2. Observe and write down:
   - badge after: **0** (incremental runs stamp media → the cheap add-on route
     works) or **~41** (they don't → idea 2 is the road);
   - the 4 English strings in lesson 2: now Russian/AI (variant A vs B call);
   - image follow-through: swap ONE image in the DEFAULT language on a cell
     that was a fallback cell, then switch to another language — does it show
     the new image (no row was created — good) or the old one (a row was
     created — the disconnect)?
3. The capture yields the exact envelope + poll shape to wire it.

**3b. l10n lock transport** (doc gap): on the OTHER imported stack (`a4MZ…`),
edit one translated string in a non-default language, pause 10 s in the field,
save. (We're hunting the write that creates the `l10n/{courseId}/{l10nId}`
lock seen in GET_LOCKS broadcasts.)

**3c. Idea-3 envelope**: on the same `a4MZ…` copy, manually retype the course
TITLE and DESCRIPTION in one non-default language (the editor's own "fix a
placeholder" write — we mirror it if idea 3 is approved).

**3d. Idea-1 envelope (optional)**: on any scratch course, delete a lesson —
captures the DELETE-lesson envelope for the delete-placeholder-lesson variant.

## Phase 4 — US plane (capture `rise066_us.mitm`)

Multilang shapes are EU-verified only. On the US test account:

1. **Shape parity**: on a small US course, add one language via the Rise UI
   (creates a stack; AI runs — fine, it's a scratch course). While recording:
   the dashboard "Manage languages" screen (GET …/translations), open the
   course (GET_COURSE with the l10n overlay), edit one translated string
   (UPDATE_L10N_BATCH), and visit the translations screen once more
   (available-languages + subscription fire from there). We diff every shape
   against the EU captures.
2. **Export**: export that US stack (+ any monolingual US course with a
   built-in cover) with the extension into a fresh archive; confirm the log
   shows ` — multi-language (codes)` and Download assets completes.
3. **US→EU import** (the business direction): import that US archive into
   Konstantin S (EU). This is the first REAL cross-plane run: watch
   specifically for `builtin-asset` flags (US library refs probed on the EU
   CDN — plane parity is unverified; flags here are informative, not
   failures) and for the same clean read-backs as phase 2.

## Deliverables back to the desk

- The four `.mitm` files, the `_import/` report files from phases 2–4, and a
  copy of the panel log (or screenshots of the badge NOTE + any ⚠ lines).
- The three observations from 3a written down (badge after / 4 strings /
  image follow-through) — they decide §6b and pick between the updates-run
  add-on, idea 2, and idea 3.
