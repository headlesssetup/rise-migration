// Executor step handlers — banks (v0.9.0 restructure, phase B; split out of
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
import { findBankRef, type PlanStep, type SourceBank } from './plan';
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

export async function handleCreateBank(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'create-bank' }>,
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
          const bank = deps.input.banksById.get(step.sourceBankId);
          const resp = await send(
            // Banks live in their OWN folder namespace — NOT the course-content
            // `all` sentinel (which 500s here). Until bank-folder mapping exists
            // (protocol §5), create at the bank root with folderId: null.
            env.postBank({ folderId: null, title: step.title }),
            step.kind,
          );
          const newBankId = dryRun ? ids.remap(step.sourceBankId) : String(resp.id ?? '');
          if (!newBankId) throw new WriteError('Bank create returned no id', step.kind, JSON.stringify(resp));
          ids.set(step.sourceBankId, newBankId);
          // Pre-remap the bank's questions so their new ids are known for binding.
          const remapped = remapIds(bank?.questions ?? [], ids) as Array<{ id?: string }>;
          bankQuestionIds.set(
            step.sourceBankId,
            remapped.map((q) => String(q.id ?? '')).filter(Boolean),
          );
}

export async function handlePutBank(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'put-bank' }>,
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
          const bank = deps.input.banksById.get(step.sourceBankId) as SourceBank | undefined;
          const newBankId = ids.get(step.sourceBankId);
          if (!newBankId) throw new WriteError('put-bank before create-bank', step.kind);
          const questions = remapIds(bank?.questions ?? [], ids);
          let resp: Record<string, unknown>;
          try {
            resp = await send(
              env.putBank({
                bankId: newBankId,
                questions: questions as unknown[],
                session: mint(),
                lockData: authorProfile(author),
              }),
              step.kind,
            );
          } catch (e) {
            // The bank shell was created (create-bank) but the questions write
            // failed → an empty bank is left on the target. Record it (no delete)
            // so the report lists it for manual cleanup, then fail the course.
            result.flags.push({
              kind: 'orphan-bank',
              detail: `Empty question bank ${newBankId} left on target (question write failed) — delete manually if needed`,
            });
            throw e;
          }
          if (!dryRun && resp.version === undefined && resp.questions === undefined) {
            result.flags.push({
              kind: 'orphan-bank',
              detail: `Question bank ${newBankId} may be incomplete (PUT did not echo a saved bank) — verify/delete manually`,
            });
            throw new WriteError('Bank PUT did not echo a saved bank', step.kind, JSON.stringify(resp));
          }
}

export async function handleBindDrawFromBank(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'bind-draw-from-bank' }>,
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
          if (!step.sourceBankId) {
            result.flags.push({
              kind: 'missing-bank-ref',
              sourceBlockId: step.sourceBlockId,
              sourceLessonId: step.sourceLessonId,
              detail: 'draw-from-bank block has no resolvable source bank id',
            });
            throw new WriteError('draw-from-bank block missing a bank reference', step.kind);
          }
          // Bank may have been imported in step B (boundBanks) or created in this
          // same run (ids/bankQuestionIds). Prefer the pre-imported one.
          const bound = deps.input.boundBanks?.get(step.sourceBankId);
          const newBankId = bound?.newBankId ?? ids.get(step.sourceBankId);
          if (!newBankId) throw new WriteError('bind before bank create', step.kind);
          const meta = blockMeta.get(blockKey(step.sourceLessonId, step.sourceBlockId));
          // Same loud-fail as patch/attach: shipping an empty blockOrItemId
          // would silently bind the draw to nothing on the server.
          if (!meta) throw new WriteError('bind before block create', step.kind);
          const newLessonId = ids.get(step.sourceLessonId)!;
          const pendingItemId = mint();
          const questionList = bound?.questionIds ?? bankQuestionIds.get(step.sourceBankId) ?? [];
          await send(
            env.insertQuestionBankQuestions({
              lesson: { id: newLessonId, courseId: ctx.newCourseId },
              blockOrItemId: meta.newId,
              pendingItemId,
              mode: 'knowledgeCheck',
              drawCount: step.drawCount,
              questionDrawType: step.questionDrawType,
              questionBankId: newBankId,
              questionList,
              courseId: ctx.newCourseId,
            }),
            step.kind,
          );
}

export async function handleFlagDrawFromBank(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'flag-draw-from-bank' }>,
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
          result.flags.push({
            kind: 'draw-from-bank',
            sourceBlockId: step.sourceBlockId,
            sourceLessonId: step.sourceLessonId,
            detail:
              'Draw-from-bank block created as an unbound placeholder — attach a question bank manually (bank recreation is off)',
          });
          log(`${pfx()} ⚠ FLAG draw-from-bank — block ${step.sourceBlockId} (attach a bank manually)`);
}

