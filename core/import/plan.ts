// Phase 3 — the import PLAN: a deterministic, ordered list of write-step intents
// derived from a source archive. The same plan drives the DRY-RUN preview and the
// live executor (one source of ordering truth). Step ordering follows
// docs/rise-import-protocol.md §1: banks → course shell → theme → title →
// (per lesson) create → update → lock → (per block) create → media upload+patch
// or draw-from-bank bind → unlock.

import {
  collectAssetKeys,
  type OptionalAssetReason,
} from '@/core/assets/keys';
// Type-only imports back from executor-types keep this cycle-free at runtime.
import { blockKey } from './executor-types';
import {
  cellKey,
  collectCells,
  formalityGroups,
  isL10nRef,
  isLocalizedStack,
  materializeLocale,
  orphanLocaleTables,
  planCellWrites,
  requireDefaultLocale,
  resolveStackTitle,
  stackLocales,
  storylineCells,
  writableLocaleCodes,
} from '@/core/l10n';
import type { GetCourseDocument, Lesson, Block } from '@/shared/types/rise';

/** One source asset, as recorded in `courses/<id>.assets.json` (+ orphan flag). */
// --- Types + helpers — split to ./plan-types and ./plan-helpers (v0.9.0) ----
// Re-exported here so the public surface of './plan' is unchanged.
export {
  MAX_UPLOAD_BASE64,
  exceedsUploadLimit,
  type AssetEntry,
  type SourceBank,
  type PlanInput,
  type PlanStep,
} from './plan-types';
export {
  orderLessons,
  coverCardImageKey,
  courseMediaImageKey,
  findBankRef,
} from './plan-helpers';
import {
  approxMb,
  exceedsUploadLimit,
  type AssetEntry,
  type PlanInput,
  type PlanStep,
  type SourceBank,
} from './plan-types';
import { makeLessonPlanners } from './plan-lesson-body';
import {
  coverCardImageKey,
  courseMediaImageKey,
  fileBasename,
  findBankRef,
  isDrawFromBank,
  lessonTitle,
  orderLessons,
  storylineCellId,
} from './plan-helpers';

export function buildPlan(input: PlanInput): PlanStep[] {
  const steps: PlanStep[] = [];
  const course = input.course.course ?? {};
  const sourceCourseId = typeof course.id === 'string' ? course.id : 'course';
  // Multi-language stack: the doc is l10n-ified ({l10nId} refs + per-locale
  // tables) — plan the stack sequence (docs/rise-multilang.md). Title/summary
  // strings and course-image objects come from the MATERIALIZED default locale.
  const stack = isLocalizedStack(input.course);
  const mat = stack ? materializeLocale(input.course).doc : input.course;
  const matCourse = (mat.course ?? {}) as Record<string, unknown>;
  const title = stack
    ? resolveStackTitle(input.course) || sourceCourseId
    : typeof course.title === 'string'
      ? course.title
      : sourceCourseId;
  // Display order comes from the course's authoritative ordered lesson-id list
  // (`course.lessons`, protocol §2) — NOT the top-level lesson-objects array order
  // and NOT the `position` field (both were observed to scramble a real course).
  const lessons = orderLessons(
    Array.isArray(input.course.lessons) ? input.course.lessons : [],
    (course as Record<string, unknown>).lessons,
  );
  // Materialized twins (same order) for display titles on a stack.
  const matLessons = orderLessons(
    Array.isArray(mat.lessons) ? mat.lessons : [],
    (matCourse as Record<string, unknown>).lessons,
  );
  const matTitle = (idx: number): string => lessonTitle(matLessons[idx] ?? lessons[idx] ?? {});

  // STACK Storyline bookkeeping (docs/rise-multilang.md §4.3b): which locales
  // hold a package per cell, and which of those the plan actually attaches —
  // the rest are flagged. Filled by the block loop, read by the flag sweep.
  const stackStorylineCells = new Map<string, string[]>();
  const stackStorylineAttached = new Map<string, Set<string>>();
  // The stack's default locale ('' for monolingual) + the steps the block loop
  // DEFERS to after the conversion (per-language storyline cell attaches —
  // they need the pairing map, which only exists post-await).
  const stackDefaultLocale = stack ? requireDefaultLocale(input.course) : '';
  const postAwaitSteps: PlanStep[] = [];
  // RAW-doc storyline cell ids by lesson+block: planLessonBody walks the
  // MATERIALIZED blocks (idea 2), where the storyline slot holds the resolved
  // OBJECT — the {l10nId} ref only exists on the raw source block.
  const rawStorylineCellByBlock = new Map<string, string>();
  if (stack) {
    for (const lesson of input.course.lessons ?? []) {
      const lid = typeof lesson.id === 'string' ? lesson.id : '';
      for (const b of (lesson.items ?? []) as Block[]) {
        const bid = typeof b.id === 'string' ? b.id : '';
        const cell = storylineCellId(b);
        if (lid && bid && cell) rawStorylineCellByBlock.set(blockKey(lid, bid), cell);
      }
    }
  }
  if (stack) {
    for (const cell of storylineCells(input.course)) {
      const locales = stackStorylineCells.get(cell.l10nId) ?? [];
      locales.push(cell.locale);
      stackStorylineCells.set(cell.l10nId, locales);
      if (!stackStorylineAttached.has(cell.l10nId)) {
        stackStorylineAttached.set(cell.l10nId, new Set());
      }
    }
  }
  const storylineCellLocales = (l10nId: string): string[] =>
    stackStorylineCells.get(l10nId) ?? [];

  const assetByKey = new Map(input.assets.map((a) => [a.key, a]));
  // Keys attached to a recreatable block (uploaded or orphan-flagged). Anything
  // else (course/lesson/theme/bank media) is flagged unsupported at the end.
  const handledKeys = new Set<string>();

  // Lesson/course-image planners — split to ./plan-lesson-body (v0.9.0).
  // The ctx members are the very objects created above, so the planners'
  // mutation semantics (steps/handledKeys/postAwaitSteps/…) are unchanged.
  const { planCourseImages, planLessonBody } = makeLessonPlanners({
    steps,
    input,
    stack,
    sourceCourseId,
    assetByKey,
    handledKeys,
    stackDefaultLocale,
    postAwaitSteps,
    rawStorylineCellByBlock,
    stackStorylineAttached,
    storylineCellLocales,
  });

  // 1. Banks first (a draw-from-bank block needs the new bank id) — ONLY when
  // bank recreation is explicitly enabled. Default: draw-from-bank blocks become
  // unbound placeholders (see the block loop), so no bank is created.
  if (input.recreateBanks) {
    const referencedBanks = new Set<string>();
    for (const l of lessons) {
      for (const b of (l.items ?? []) as Block[]) {
        if (isDrawFromBank(b)) {
          const { bankId } = findBankRef(b);
          if (bankId) referencedBanks.add(bankId);
        }
      }
    }
    for (const bankId of referencedBanks) {
      const bank = input.banksById.get(bankId);
      const bTitle = bank?.title ?? bankId;
      const qCount = Array.isArray(bank?.questions) ? bank!.questions!.length : 0;
      steps.push({
        kind: 'create-bank',
        sourceBankId: bankId,
        title: bTitle,
        summary: `Create question bank "${bTitle}"`,
      });
      steps.push({
        kind: 'put-bank',
        sourceBankId: bankId,
        questionCount: qCount,
        summary: `Write ${qCount} question(s) to bank "${bTitle}"`,
      });
    }
  }

  // 2. Course shell. The bare POST /content shell is only a CATALOG row; it
  // becomes a real course when the FIRST CREATE_LESSON materializes its runtime
  // document. So we emit the first lesson as the very next write after the shell —
  // nothing failable in between — to shrink the "never-born phantom" window to a
  // single hop (the executor rolls back an un-materialized shell if even that
  // fails). Title is best-effort and NOT the materializer, so it no longer comes
  // first; it (and the theme) are applied AFTER the lessons exist — Rise also
  // rejects theming a lesson-less course ("add a lesson before theming").
  steps.push({
    kind: 'create-course',
    sourceCourseId,
    title,
    courseType: typeof (course as Record<string, unknown>).type === 'string'
      ? ((course as Record<string, unknown>).type as string)
      : null,
    summary: `Create course "${title}"`,
  });

  // Optional authoring provenance is capture-confirmed as non-rendering. Its
  // unavailable source key must still not survive the import, but it is not a
  // broken course asset and therefore must not create a manual-work flag.
  for (const entry of input.assets) {
    if (!entry.optionalUnavailable || !entry.optionalReason) continue;
    handledKeys.add(entry.key);
    steps.push({
      kind: 'drop-optional-media',
      sourceKey: entry.key,
      reason: entry.optionalReason,
      summary: `Drop unavailable optional ${entry.optionalReason}: ${entry.key}`,
    });
  }

  // 3. Lessons in DISPLAY ORDER (already applied above via `course.lessons`,
  // the authoritative ordered id list — §2). CREATE_LESSON honors `position`, so
  // we send a sequential 0-based slot (idx) and each create appends in this exact
  // order — no reorder pass needed.
  const ordered = lessons;


  const lessonMeta = (
    lesson: Lesson,
    idx: number,
  ): { sourceLessonId: string; lType: string; icon: string | null } => ({
    sourceLessonId: typeof lesson.id === 'string' ? lesson.id : `lesson-${idx}`,
    lType: typeof lesson.type === 'string' ? lesson.type : 'blocks',
    icon: typeof lesson.icon === 'string' ? lesson.icon : null,
  });

  if (!stack) {
    ordered.forEach((lesson, idx) => {
      const { sourceLessonId, lType, icon } = lessonMeta(lesson, idx);
      const lTitle = lessonTitle(lesson);

      steps.push({
        kind: 'create-lesson',
        sourceLessonId,
        // Sequential 0-based slot in display order — NOT the raw source `position`.
        // We create lessons in this order, so slot == current length == an append;
        // sending the raw (possibly gappy/non-0-based) source position let the
        // server place lessons out of order. `idx` keeps each insert an append.
        position: idx,
        title: lTitle,
        lessonType: lType === 'section' ? 'section' : null, // type set on update
        summary: `Create lesson "${lTitle}" (${lType})`,
      });

      // Set the CLEAN course title (+ description) right after the FIRST lesson
      // materializes the course (the bare shell is a title-less catalog row, and
      // Rise rejects titling a lesson-less course). Written ONCE — the
      // `!importing:`/`!unfinished:` title markers are GONE (operator decision
      // 2026-08-04): incomplete courses are identified via the run reports and
      // the read-back / export-from-target pass, never via title mangling.
      if (idx === 0) {
        steps.push({
          kind: 'set-title',
          sourceCourseId,
          title,
          final: true,
          summary: `Set course title "${title}"`,
        });
      }

      planLessonBody(lesson, sourceLessonId, lTitle, lType, icon);
    });

    // Title for a lesson-less course (the per-first-lesson write above never
    // fired). A confirmed bare shell is a real course, so titling it is safe.
    if (ordered.length === 0) {
      steps.push({
        kind: 'set-title',
        sourceCourseId,
        title,
        final: true,
        summary: `Set course title "${title}"`,
      });
    }
  } else {
    // ------ STACK SEQUENCE — idea 2 (docs/rise-multilang.md §6, v0.6.7) ------
    // Build the FULL course in the DEFAULT language from the materialized doc
    // (the monolingual path, exactly), then convert ONCE per formality group —
    // the conversion translates the REAL content and stamps `translatedAt` on
    // every cell (badge 0) — then overwrite every TARGET-locale row from the
    // archive. No placeholders, no source l10nIds, no post-conversion default
    // writes, no junk cleanup.
    const doc = input.course;
    // Loud failure: a stack whose default locale can't be resolved is malformed
    // — silently guessing would corrupt every cell write.
    const defLocale = requireDefaultLocale(doc);
    const locales = stackLocales(doc);
    const localeCodes = locales
      .map((l) => String(l.locale ?? ''))
      .filter(Boolean);

    // 3a. Lessons + blocks from the MATERIALIZED doc — plain default-locale
    // titles and values throughout; the clean course title (+ description)
    // lands right after the first lesson materializes the course. The
    // `!importing:` marker machinery is GONE (operator decision 2026-08-04).
    ordered.forEach((lesson, idx) => {
      const { sourceLessonId, lType, icon } = lessonMeta(lesson, idx);
      const lTitle = matTitle(idx);
      steps.push({
        kind: 'create-lesson',
        sourceLessonId,
        position: idx,
        title: lTitle,
        lessonType: lType === 'section' ? 'section' : null,
        summary: `Create lesson "${lTitle}" (${lType})`,
      });
      if (idx === 0) {
        steps.push({
          kind: 'set-title',
          sourceCourseId,
          title,
          summary: `Set course title "${title}"`,
        });
      }
      planLessonBody(matLessons[idx] ?? lesson, sourceLessonId, lTitle, lType, icon);
    });
    if (ordered.length === 0) {
      steps.push({
        kind: 'set-title',
        sourceCourseId,
        title,
        summary: `Set course title "${title}"`,
      });
    }

    // 3b. Description, pre-conversion, with the MATERIALIZED default value —
    // the conversion mints the description ref + default cell from it (no
    // captured envelope adds a description to an already-converted stack).
    const matDesc =
      typeof matCourse.description === 'string' ? matCourse.description : '';
    if (matDesc) {
      steps.push({
        kind: 'set-course-description',
        value: matDesc,
        summary: 'Set course description (default language, pre-conversion)',
      });
    }

    // 3c. Course images + theme BEFORE conversion (plain objects; the
    // conversion turns localizable ones into refs + default-locale cells
    // itself — capture-proven shape; AI never touches media). Keys come from
    // the MATERIALIZED course object.
    planCourseImages(matCourse);
    if (course.theme && typeof course.theme === 'object') {
      steps.push({
        kind: 'set-theme',
        sourceCourseId,
        summary: 'Apply course theme + typefaces (verbatim round-trip)',
      });
    }

    // 3d. Convert the BUILT course: one POST per formality group; then poll to
    // completion. The orchestrator sanity-checks the locale codes against
    // available-languages pre-write.
    for (const g of formalityGroups(doc)) {
      steps.push({
        kind: 'convert-stack',
        sourceLanguage: defLocale,
        targetLanguages: g.locales,
        formality: g.formality,
        summary: `Add language(s) ${g.locales.join(', ')}${g.formality ? ` (formality: ${g.formality})` : ''} — ONE conversion of the full course`,
      });
    }
    steps.push({
      kind: 'await-stack',
      expectedLocales: localeCodes,
      summary: `Wait for the stack shape (${localeCodes.join(', ')}) to finish, then pair refs`,
    });
    // Storyline cell attaches for non-default languages (deferred from the
    // block loop — they need the pairing map from await-stack).
    steps.push(...postAwaitSteps);

    // Tables for locales the target can never have (archived rows / row-less
    // tables) are not transferable — skipped from every write and flagged
    // loudly so nothing leaves the archive unseen.
    const orphanLocales = orphanLocaleTables(doc);
    for (const o of orphanLocales) {
      steps.push({
        kind: 'flag-l10n-locale',
        locale: o.locale,
        reason: o.reason,
        cells: o.cells,
        summary: `⚠ ${o.cells} cell(s) for locale "${o.locale}" cannot be migrated (${o.reason === 'archived' ? 'language is archived at the source' : 'no locale row'}) — restore the language and re-export to migrate it`,
      });
    }
    const writableCodes = writableLocaleCodes(doc);

    // 3e. Table media of NON-DEFAULT locales (per-language overrides) — upload
    // BEFORE any cell write so values carry remapped keys. The DEFAULT locale's
    // media already rode the materialized full build (blocks/lessons/course
    // images above). Orphan-locale tables are excluded: their cells are never
    // written, so their media would be unreferenced uploads.
    const allTables = doc.l10n?.translations ?? {};
    const tables = Object.fromEntries(
      Object.entries(allTables).filter(
        ([code]) => writableCodes.has(code) && code !== defLocale,
      ),
    );
    for (const [locale, table] of Object.entries(tables)) {
      for (const ak of collectAssetKeys(table, sourceCourseId)) {
        if (handledKeys.has(ak.key)) continue;
        handledKeys.add(ak.key);
        const entry = assetByKey.get(ak.key);
        if (entry?.orphaned || (entry && !entry.file)) {
          steps.push({
            kind: 'flag-orphan-media',
            sourceLessonId: '',
            sourceBlockId: '',
            sourceKey: ak.key,
            summary: `⚠ Orphaned media in translations (${locale}) (deleted at source): ${ak.key}`,
          });
          continue;
        }
        if (exceedsUploadLimit(entry?.size)) {
          steps.push({
            kind: 'flag-unsupported-media',
            sourceKey: ak.key,
            location: `translations (${locale})`,
            summary: `⚠ Media ~${approxMb(entry!.size!)}MB too large to upload via the extension — attach manually: ${ak.key}`,
          });
          continue;
        }
        steps.push({
          kind: 'upload-l10n-asset',
          sourceKey: ak.key,
          locale,
          mediaKind: ak.kind,
          filename: fileBasename(ak.key),
          summary: `Upload ${ak.kind} ${fileBasename(ak.key)} (translations ${locale})`,
        });
      }
    }

    // 3f. Fill the TARGET languages: batched cell writes, one locale per
    // envelope, every id mapped through the pairing map at execution. The
    // DEFAULT locale is NEVER written post-conversion (its rows exist from the
    // build + conversion; a default write would re-pend the cell in every
    // locale under the US `translatedAt` rule). Excluded from the batches:
    //   - storyline cells (attached via Review 360, flagged where unattached),
    //   - course title/description cells (the final set-stack-titles step).
    const skip = new Set<string>();
    const titleDescIds = [course.title, course.description]
      .filter(isL10nRef)
      .map((r) => r.l10nId);
    for (const id of titleDescIds) {
      for (const code of Object.keys(allTables)) skip.add(cellKey(id, code));
    }
    // Storyline cells are NEVER shipped verbatim (their contentPrefix belongs to
    // the SOURCE course and storyline keys bypass the foreign-key invariant):
    // exclude them here and flag each one, grouped by cell, with its languages.
    const slCells = storylineCells(doc);
    const slByRef = new Map<string, { locales: string[]; title?: string }>();
    for (const c of slCells) {
      skip.add(cellKey(c.l10nId, c.locale));
      const entry = slByRef.get(c.l10nId) ?? { locales: [] };
      entry.locales.push(c.locale);
      const sl = (c.value as { storyline?: { title?: unknown } }).storyline;
      if (!entry.title && typeof sl?.title === 'string') entry.title = sl.title;
      slByRef.set(c.l10nId, entry);
    }
    for (const [l10nId, entry] of slByRef) {
      // Languages this plan attaches automatically (staged package) need no flag.
      const done = stackStorylineAttached.get(l10nId) ?? new Set<string>();
      const pending = entry.locales.filter((l) => !done.has(l));
      if (pending.length === 0) continue;
      steps.push({
        kind: 'flag-l10n-storyline',
        l10nId,
        locales: pending,
        ...(entry.title ? { title: entry.title } : {}),
        summary: `⚠ Storyline in a stack${entry.title ? ` ("${entry.title}")` : ''} — attach manually for: ${pending.join(', ')}`,
      });
    }
    const targetCells = collectCells(doc).filter((c) => c.locale !== defLocale);
    const batches = planCellWrites(targetCells, { skip });
    batches.forEach((batch, i) => {
      steps.push({
        kind: 'write-l10n',
        locale: batch[0]?.locale ?? defLocale,
        l10nIds: batch.map((c) => c.l10nId),
        batchIndex: i + 1,
        batchTotal: batches.length,
        summary: `Write ${batch.length} translation cell(s) [${batch[0]?.locale ?? ''}] (batch ${i + 1}/${batches.length})`,
      });
    });

    // 3h. Custom per-language label sets (account-scoped; deduped run-wide via
    // the executor's labelSetCache). The DEFAULT locale's set is the course's
    // own label set — course-level label-set migration is a documented gap.
    const archivedSets = Array.isArray((doc as Record<string, unknown>).labelSets)
      ? ((doc as Record<string, unknown>).labelSets as Record<string, unknown>[])
      : [];
    const defaultSets = Array.isArray((doc as Record<string, unknown>).defaultLabelSets)
      ? ((doc as Record<string, unknown>).defaultLabelSets as Record<string, unknown>[])
      : [];
    for (const row of locales) {
      const code = String(row.locale ?? '');
      if (!code || code === defLocale) continue;
      const setId = typeof row.labelSetId === 'string' ? row.labelSetId : null;
      if (!setId) continue; // language default applies — nothing to recreate
      const set = archivedSets.find((s) => s.id === setId);
      if (!set) continue; // not in the archive — the read-back will surface it
      const iso = typeof set.iso639Code === 'string' ? set.iso639Code : code;
      const name = typeof set.name === 'string' ? set.name : `Imported ${code}`;
      const labels = (set.labels ?? {}) as Record<string, unknown>;
      const def = defaultSets.find((s) => s.iso639Code === iso && s.defaultSet === true);
      const defLabels = (def?.labels ?? {}) as Record<string, unknown>;
      const overrides: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(labels)) {
        if (defLabels[k] !== v) overrides[k] = v;
      }
      steps.push({
        kind: 'set-locale-labelset',
        locale: code,
        iso639Code: iso,
        name,
        labels: overrides,
        sourceLabelSetId: setId,
        summary: `Recreate label set "${name}" (${Object.keys(overrides).length} custom label(s)) → ${code}`,
      });
    }
  }

  // Monolingual theme — AFTER the lessons exist (Rise rejects theming a
  // lesson-less course). The stack path emitted its own set-theme
  // pre-conversion above.
  if (!stack && course.theme && typeof course.theme === 'object') {
    steps.push({
      kind: 'set-theme',
      sourceCourseId,
      summary: 'Apply course theme + typefaces (verbatim round-trip)',
    });
  }

  // Monolingual course cover/card/logo images — the stack path already emitted
  // its set-course-images (from the MATERIALIZED course) pre-conversion.
  if (!stack) planCourseImages(course as Record<string, unknown>);

  // Media that isn't on a recreatable block OR an uploaded lesson header — theme
  // images and bank question media (lesson headers are handled per-lesson above).
  // The captured write path doesn't cover these, so flag them (manual) rather than
  // silently shipping a source key or failing the whole course.
  const flagUnsupported = (doc: unknown, ownerId: string, where: string): void => {
    for (const ak of collectAssetKeys(doc, ownerId)) {
      if (handledKeys.has(ak.key)) continue;
      handledKeys.add(ak.key);
      steps.push({
        kind: 'flag-unsupported-media',
        sourceKey: ak.key,
        location: where,
        summary: `⚠ Unsupported media location (${where}) — attach manually: ${ak.key}`,
      });
    }
  };
  flagUnsupported(input.course, sourceCourseId, 'course/lesson/theme');
  for (const [bankId, bank] of input.banksById) {
    flagUnsupported(bank, bankId, `bank ${bankId}`);
  }

  if (stack) {
    if (input.course.l10n?.showLocaleSelector === true) {
      steps.push({
        kind: 'flag-locale-selector',
        summary:
          '⚠ Source shows the learner language selector — enable it manually (Settings → Languages)',
      });
    }
    // Title + description cells for every writable NON-DEFAULT locale (D2,
    // fallback-resolved — the target displays exactly what the source
    // displays). The default locale's cells came from the conversion of the
    // clean pre-conversion title/description and are never re-written.
    steps.push({
      kind: 'set-stack-titles',
      summary: `Set course title "${title}" + description in every target language`,
    });
  }

  return steps;
}

/** A flat, human-readable preview of the plan (the dry-run output). */
export function summarizePlan(steps: PlanStep[]): string[] {
  return steps.map((s, i) => `${String(i + 1).padStart(3, ' ')}. ${s.summary}`);
}

/** Plan rollup for the dry-run header + fidelity preview. */
export interface PlanStats {
  total: number;
  banks: number;
  lessons: number;
  blocks: number;
  uploads: number;
  storylineFlags: number;
  orphanFlags: number;
  drawFromBank: number;
  /** Multi-language stack: number of languages ('' /0 for monolingual). */
  locales: number;
  /** Translation cells written via batches (excludes create-inlined cells). */
  l10nCells: number;
  /** UPDATE_L10N_BATCH envelopes planned. */
  l10nBatches: number;
}

export function planStats(steps: PlanStep[]): PlanStats {
  const count = (k: PlanStep['kind']): number =>
    steps.filter((s) => s.kind === k).length;
  const blocks = steps.reduce(
    (n, s) => (s.kind === 'create-blocks' ? n + s.blocks.length : n),
    0,
  );
  const l10nCells = steps.reduce(
    (n, s) => (s.kind === 'write-l10n' ? n + s.l10nIds.length : n),
    0,
  );
  const awaitStep = steps.find((s) => s.kind === 'await-stack');
  return {
    total: steps.length,
    banks: count('create-bank'),
    lessons: count('create-lesson'),
    blocks,
    uploads:
      count('upload-asset') + count('upload-lesson-media') + count('upload-l10n-asset'),
    storylineFlags: count('flag-storyline') + count('flag-l10n-storyline'),
    orphanFlags: count('flag-orphan-media'),
    drawFromBank: count('bind-draw-from-bank'),
    locales: awaitStep?.kind === 'await-stack' ? awaitStep.expectedLocales.length : 0,
    l10nCells,
    l10nBatches: count('write-l10n'),
  };
}
