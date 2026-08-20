// Executor step handlers — storyline (v0.9.0 restructure, phase B; split out of
// executor.ts's switch; the switch itself stays THERE for union exhaustiveness,
// each case now one `await handleX(ctx, step)`). Bodies are verbatim moves;
// the characterization test freezes the envelope order they produce.

import {
  freshClientIds,
  remapIds,
  blankUploadedMediaKeys,
  blankForeignMediaKeys,
  remapMediaKeys,
} from './remap';
import * as env from './envelopes';
import { findBankRef, type PlanStep } from './plan';
import {
  targetByName,
  usedTypefaceIds,
  resolveTypefaces,
  buildCreateTypefaceFonts,
  applyTypefaceIds,
  type Typeface,
} from './typefaces';
import {
  WriteError,
  parseJson,
  payloadOf,
  indexSource,
  blockKey,
  authorProfile,
} from './executor-types';
import {
  defaultLocaleOf,
  isL10nRef,
  isLocalizedStack,
  materializeLocale,
  pairL10nRefs,
  writableLocaleCodes,
  type L10nChange,
} from '@/core/l10n';
import { hasBuiltinRef } from './builtin-assets';
import { legacyStorylinePlaceholderBlock } from '@/core/storyline/compatibility';
import type { GetCourseDocument } from '@/shared/types/rise';
import type { ExecCtx } from './executor-run-state';

export async function handleAttachStoryline(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'attach-storyline' }>,
): Promise<void> {
  const {
    deps,
    ids,
    mint,
    pace,
    log,
    dryRun,
    author,
    result,
    shellLessons,
    blockMeta,
    keyMap,
    bankQuestionIds,
    stack,
    srcTables,
    srcDefaultLocale,
    stackRefMap,
    matDoc,
    srcLessons,
    srcBlocks,
    unmatchedCourseRefs,
    pfx,
    send,
    reportOrphanShell,
    uploadOne,
    buildCellChange,
    noteBuiltins,
  } = ctx;
          // Mirror the editor's "add from Review 360": copy the uploaded review
          // item's bundle into the course, then patch the (empty) block's
          // media.storyline to point at the copied bundle. The copy preserves the
          // review item's leaf, so contentPrefix = rise/courses/{courseId}/{leaf}.
          const norm = ctx.normBlocks.get(blockKey(step.sourceLessonId, step.sourceBlockId));
          const meta = blockMeta.get(blockKey(step.sourceLessonId, step.sourceBlockId));
          if (!norm || !meta) throw new WriteError('attach before block create', step.kind);
          const newLessonId = ids.get(step.sourceLessonId)!;
          const leaf = step.reviewPrefix.split('/').filter(Boolean).pop() ?? '';

          await send(
            env.copyReviewItem({
              courseId: ctx.newCourseId,
              reviewPrefix: step.reviewPrefix,
              blockId: meta.newId,
            }),
            step.kind,
          );

          const contentPrefix = `rise/courses/${ctx.newCourseId}/${leaf}`;
          // Rebuild FROM THE NORMALIZED (as-created) block — see normBlocks:
          // re-normalizing the raw source block would mint different ids and
          // the server 404s the update ("Block not found in lesson").
          const item = remapIds(norm, ids) as Record<string, unknown>;
          if (String(item.id ?? '') !== meta.newId) {
            throw new WriteError(
              `attach payload id ${String(item.id ?? '(none)')} != created block id ${meta.newId} — id-mint drift (code fault)`,
              step.kind,
            );
          }
          const items = Array.isArray(item.items) ? item.items : [];
          const first = items[0];
          if (first && typeof first === 'object') {
            (first as Record<string, unknown>).media = env.buildStorylineMedia({
              contentPrefix,
              meta: step.meta,
              title: step.title,
            });
          }
          await send(
            env.updateBlockDebounce({
              id: meta.newId,
              courseId: ctx.newCourseId,
              lessonId: newLessonId,
              item,
            }),
            step.kind,
          );
          result.storylineAttached = (result.storylineAttached ?? 0) + 1;
          (result.storylinePrefixes ??= []).push(contentPrefix);
          log(`${pfx()} ✓ attached storyline → ${contentPrefix}`);
}

export async function handleFlagStoryline(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'flag-storyline' }>,
): Promise<void> {
  const {
    deps,
    ids,
    mint,
    pace,
    log,
    dryRun,
    author,
    result,
    shellLessons,
    blockMeta,
    keyMap,
    bankQuestionIds,
    stack,
    srcTables,
    srcDefaultLocale,
    stackRefMap,
    matDoc,
    srcLessons,
    srcBlocks,
    unmatchedCourseRefs,
    pfx,
    send,
    reportOrphanShell,
    uploadOne,
    buildCellChange,
    noteBuiltins,
  } = ctx;
          const legacy = step.reason === 'legacy';
          result.flags.push({
            kind: 'storyline',
            sourceBlockId: step.sourceBlockId,
            sourceLessonId: step.sourceLessonId,
            ...(legacy ? { expectedReplacement: 'legacy-storyline' as const } : {}),
            detail: legacy
              ? 'Legacy Storyline package is incompatible with Review 360 — a visible placeholder was imported; republish the original .story project in current Storyline, upload it to Review 360, and attach it manually'
              : 'Storyline/Mighty block — attach manually via a reachable Review 360 item',
          });
          log(
            legacy
              ? `${pfx()} ⚠ FLAG legacy storyline — block ${step.sourceBlockId} replaced with a manual-review placeholder`
              : `${pfx()} ⚠ FLAG storyline — block ${step.sourceBlockId} needs manual Review 360 attach`,
          );
}

export async function handleAttachStorylineL10n(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'attach-storyline-l10n' }>,
): Promise<void> {
  const {
    deps,
    ids,
    mint,
    pace,
    log,
    dryRun,
    author,
    result,
    shellLessons,
    blockMeta,
    keyMap,
    bankQuestionIds,
    stack,
    srcTables,
    srcDefaultLocale,
    stackRefMap,
    matDoc,
    srcLessons,
    srcBlocks,
    unmatchedCourseRefs,
    pfx,
    send,
    reportOrphanShell,
    uploadOne,
    buildCellChange,
    noteBuiltins,
  } = ctx;
          // STACK per-language attach, idea-2 form (docs/rise-multilang.md
          // §4.3b): the DEFAULT language's package was patched onto the block
          // pre-conversion; each further language copies ITS uploaded package
          // and writes the storyline CELL for that locale — addressed through
          // the pairing map. If the conversion did NOT l10n-ify the block's
          // storyline media (no paired ref), a per-language package is
          // impossible on this course: flag it, write nothing (R3).
          const meta = blockMeta.get(blockKey(step.sourceLessonId, step.sourceBlockId));
          if (!meta) throw new WriteError('attach before block create', step.kind);
          const cellId = dryRun
            ? (stackRefMap.get(step.l10nId) ?? step.l10nId)
            : stackRefMap.get(step.l10nId);
          if (!cellId) {
            result.flags.push({
              kind: 'l10n-storyline',
              detail:
                `${step.title ? `"${step.title}" — ` : ''}the conversion did not localize this ` +
                `block's Storyline slot, so a per-language package cannot be attached for ` +
                `"${step.locale}" — every language shares the default package; attach manually if needed`,
            });
            log(
              `${pfx()} ⚠ FLAG storyline [${step.locale}] — block's storyline slot not l10n-ified on target (no per-language attach possible)`,
            );
            return;
          }
          const leaf = step.reviewPrefix.split('/').filter(Boolean).pop() ?? '';
          await send(
            env.copyReviewItem({
              courseId: ctx.newCourseId,
              reviewPrefix: step.reviewPrefix,
              blockId: meta.newId,
            }),
            step.kind,
          );
          const contentPrefix = `rise/courses/${ctx.newCourseId}/${leaf}`;
          const value = env.buildStorylineMedia({
            contentPrefix,
            meta: step.meta,
            title: step.title,
          });
          // The cell EXISTS post-conversion (the default package was extracted
          // into it), so a further language is a bare `update` — the
          // capture-proven shape for the 2nd language on an existing cell
          // (capture2aug §4.3b).
          await send(
            env.updateL10nBatch(ctx.newCourseId, [
              { action: 'update', l10nId: cellId, locale: step.locale, value },
            ]),
            step.kind,
          );
          result.storylineAttached = (result.storylineAttached ?? 0) + 1;
          (result.storylinePrefixes ??= []).push(contentPrefix);
          log(`${pfx()} ✓ attached storyline [${step.locale}] → ${contentPrefix}`);
}

export async function handleFlagL10nStoryline(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'flag-l10n-storyline' }>,
): Promise<void> {
  const {
    deps,
    ids,
    mint,
    pace,
    log,
    dryRun,
    author,
    result,
    shellLessons,
    blockMeta,
    keyMap,
    bankQuestionIds,
    stack,
    srcTables,
    srcDefaultLocale,
    stackRefMap,
    matDoc,
    srcLessons,
    srcBlocks,
    unmatchedCourseRefs,
    pfx,
    send,
    reportOrphanShell,
    uploadOne,
    buildCellChange,
    noteBuiltins,
  } = ctx;
          // The source cell's storyline contentPrefix belongs to the SOURCE
          // course and storyline keys bypass the foreign-key invariant, so the
          // cell is deliberately NOT written (docs/rise-multilang.md §4.3b).
          result.flags.push({
            kind: 'l10n-storyline',
            detail: `${step.title ? `"${step.title}" — ` : ''}attach the Storyline package manually for: ${step.locales.join(', ')}`,
          });
          log(
            `${pfx()} ⚠ FLAG storyline in stack — cell ${step.l10nId} not copied; attach per language (${step.locales.join(', ')})`,
          );
}

