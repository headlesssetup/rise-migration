// Phase 3 — the import EXECUTOR. Walks the plan (core/import/plan.ts) and, for
// each step, builds the write envelope(s) (core/import/envelopes.ts), relays them
// through an injected Relay (the background runs them in the live Rise tab),
// asserts the response shape (loud-fail, protocol §12), and records server-
// assigned ids into the IdMap (resumable job log, §6). Strictly sequential +
// human-paced; DRY-RUN collects the envelopes without sending.
//
// All I/O is injected so the whole executor is unit-testable without a browser
// or a live Rise account.

import { remapMediaKeys, findForeignMediaKeys, findLocalAssetRefs } from './remap';
import type { PlanStep } from './plan';
import { WriteError } from './executor-types';
import type { ExecutorDeps, ExecResult } from './executor-types';
import { makeExecCtx } from './executor-run-state';
import {
  handleCreateBank,
  handlePutBank,
  handleBindDrawFromBank,
  handleFlagDrawFromBank,
} from './executor-steps-banks';
import {
  handleCreateCourse,
  handleSetTheme,
  handleSetTitle,
  handleCreateLesson,
  handleUpdateLesson,
  handleLockLesson,
  handleUnlockLesson,
  handleCreateBlocks,
} from './executor-steps-lifecycle';
import {
  handleSetCourseImages,
  handleUploadAsset,
  handleUploadLessonMedia,
  handlePatchBlockMedia,
  handleFlagOrphanMedia,
  handleDropOptionalMedia,
  handleFlagUnsupportedMedia,
} from './executor-steps-media';
import {
  handleAttachStoryline,
  handleFlagStoryline,
  handleAttachStorylineL10n,
  handleFlagL10nStoryline,
} from './executor-steps-storyline';
import {
  handleSetCourseDescription,
  handleConvertStack,
  handleAwaitStack,
  handleUploadL10nAsset,
  handleWriteL10n,
  handleSetLocaleLabelset,
  handleSetStackTitles,
  handleFlagL10nLocale,
  handleFlagLocaleSelector,
} from './executor-steps-l10n';
export type { ExecCtx } from './executor-run-state';

// Re-export the executor contracts/types so `@/core/import` keeps the same
// surface after they moved to ./executor-types (see that file's header).
export {
  blockKey,
  summarizeFlags,
  WriteError,
  type RelayResponse,
  type Relay,
  type AssetBytes,
  type ExecutorDeps,
  type ManualFlag,
  type ExecResult,
} from './executor-types';


export async function executePlan(
  steps: PlanStep[],
  deps: ExecutorDeps,
): Promise<ExecResult> {
  const ctx = makeExecCtx(steps, deps);
  // Stable references (objects/functions) — identical bindings to the ctx's own;
  // only the mutable primitives go through ctx.* below.
  const {
    ids,
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
    total,
    pfx,
    send,
    reportOrphanShell,
    uploadOne,
    buildCellChange,
    noteBuiltins,
  } = ctx;
  const mint = ctx.mint;

  try {
    let done = 0;
    for (const step of steps) {
      // Cooperative stop checkpoint: only BETWEEN steps (the previous write has
      // fully finished), so we never abandon a half-sent write. The partial
      // course is kept + resumable via the job log — no rollback.
      if (deps.shouldStop?.()) {
        result.stopped = true;
        result.idMap = ids.toJSON();
        // No title marker is written (operator decision 2026-08-04: the
        // `!importing:`/`!unfinished:` mangling is gone) — the partial course
        // keeps its clean title and is identified via the run report/summary,
        // which lists its id for manual cleanup before a re-import.
        log(
          `Stopped before step ${ctx.stepIdx + 1}/${total} — partial course ${ctx.newCourseId || '(none)'} kept ` +
            '(no title marker; see the run report for cleanup)',
        );
        return result;
      }
      ctx.stepIdx++;
      switch (step.kind) {
        case 'create-bank': {
          await handleCreateBank(ctx, step);
          break;
        }
        case 'put-bank': {
          await handlePutBank(ctx, step);
          break;
        }
        case 'create-course': {
          await handleCreateCourse(ctx, step);
          break;
        }
        case 'set-theme': {
          await handleSetTheme(ctx, step);
          break;
        }
        case 'set-course-images': {
          await handleSetCourseImages(ctx, step);
          break;
        }
        case 'set-title': {
          await handleSetTitle(ctx, step);
          break;
        }
        case 'create-lesson': {
          await handleCreateLesson(ctx, step);
          break;
        }
        case 'update-lesson': {
          await handleUpdateLesson(ctx, step);
          break;
        }
        case 'lock-lesson': {
          await handleLockLesson(ctx, step);
          break;
        }
        case 'unlock-lesson': {
          await handleUnlockLesson(ctx, step);
          break;
        }
        case 'create-blocks': {
          await handleCreateBlocks(ctx, step);
          break;
        }
        case 'bind-draw-from-bank': {
          await handleBindDrawFromBank(ctx, step);
          break;
        }
        case 'upload-asset': {
          await handleUploadAsset(ctx, step);
          break;
        }
        case 'upload-lesson-media': {
          await handleUploadLessonMedia(ctx, step);
          break;
        }
        case 'patch-block-media': {
          await handlePatchBlockMedia(ctx, step);
          break;
        }
        case 'attach-storyline': {
          await handleAttachStoryline(ctx, step);
          break;
        }
        case 'flag-storyline': {
          await handleFlagStoryline(ctx, step);
          break;
        }
        case 'flag-draw-from-bank': {
          await handleFlagDrawFromBank(ctx, step);
          break;
        }
        case 'flag-orphan-media': {
          await handleFlagOrphanMedia(ctx, step);
          break;
        }
        case 'drop-optional-media': {
          await handleDropOptionalMedia(ctx, step);
          break;
        }
        case 'flag-unsupported-media': {
          await handleFlagUnsupportedMedia(ctx, step);
          break;
        }

        // ---- Multi-language stacks (docs/rise-multilang.md) ----
        case 'set-course-description': {
          await handleSetCourseDescription(ctx, step);
          break;
        }
        case 'convert-stack': {
          await handleConvertStack(ctx, step);
          break;
        }
        case 'await-stack': {
          await handleAwaitStack(ctx, step);
          break;
        }
        case 'upload-l10n-asset': {
          await handleUploadL10nAsset(ctx, step);
          break;
        }
        case 'write-l10n': {
          await handleWriteL10n(ctx, step);
          break;
        }
        case 'set-locale-labelset': {
          await handleSetLocaleLabelset(ctx, step);
          break;
        }
        case 'set-stack-titles': {
          await handleSetStackTitles(ctx, step);
          break;
        }
        case 'attach-storyline-l10n': {
          await handleAttachStorylineL10n(ctx, step);
          break;
        }
        case 'flag-l10n-storyline': {
          await handleFlagL10nStoryline(ctx, step);
          break;
        }
        case 'flag-l10n-locale': {
          await handleFlagL10nLocale(ctx, step);
          break;
        }
        case 'flag-locale-selector': {
          await handleFlagLocaleSelector(ctx, step);
          break;
        }
      }
      result.idMap = ids.toJSON();
      deps.onProgress?.(++done, steps.length);
    }

    // Materialization guard (belt-and-suspenders): the create-course handshake
    // already confirmed the shell with a 200 GET_COURSE, so this normally never
    // fires. If somehow a course id exists without that confirmation, treat the
    // shell as suspect and roll it back rather than report a hollow success.
    if (!dryRun && ctx.newCourseId && !ctx.materialized) {
      reportOrphanShell('course never confirmed by the GET_COURSE handshake');
      result.ok = false;
      result.error =
        'Course shell was not confirmed by the post-create GET_COURSE handshake — left in place (delete manually if needed)';
      result.idMap = ids.toJSON();
      return result;
    }

    // CLAUDE.md invariant: "each distinct [built-in] reference is HEAD-probed
    // on the TARGET plane" — EVERY reference, not just course images. Built-in
    // refs ship verbatim, so a sweep of the SOURCE doc covers everything the
    // target received: block defaults (posters/thumbnails), theme images, and
    // a stack's table cells. Values already probed by set-course-images are
    // deduped by notedBuiltinValues; probes by the run-wide cache. Live runs
    // only — a dry run must not burst HEAD requests at the CDN.
    if (!dryRun) await noteBuiltins(deps.input.course, 'course document');

    // Final invariant (protocol §8/§12): every uploaded media key in the rebuilt
    // course must belong to a TARGET owner (new course id / new bank ids) — any
    // other is a source/foreign key that wasn't remapped. Runs UNFILTERED: every
    // flagged key (orphan / oversize / unsupported-location) was BLANKED via the
    // keyMap, so a hit here is a real failure — including in a dry run, whose
    // prediction must not be silently discarded.
    const targetOwners = new Set<string>();
    if (ctx.newCourseId) targetOwners.add(ctx.newCourseId);
    for (const bankId of deps.input.banksById.keys()) {
      const nb = ids.get(bankId);
      if (nb) targetOwners.add(nb);
    }
    const rebuilt = remapMediaKeys(deps.input.course, keyMap);
    result.survivingKeys = [
      ...findForeignMediaKeys(rebuilt, targetOwners),
      ...findLocalAssetRefs(rebuilt).map((ref) => `local-asset:${ref.assetPath}@${ref.path}`),
    ];

    result.ok = result.survivingKeys.length === 0;
    if (!result.ok) {
      result.error = `Foreign or unresolved media references ${dryRun ? 'would survive (dry-run prediction)' : 'survived'}: ${result.survivingKeys.slice(0, 5).join(', ')}`;
    }
    result.idMap = ids.toJSON();
    return result;
  } catch (e) {
    result.ok = false;
    result.idMap = ids.toJSON();
    // Report (do NOT delete) ONLY a shell the GET_COURSE handshake never
    // confirmed. Once confirmed, the course is real, queryable and resumable (a
    // bare titleless/lessonless shell is a VALID Rise course — capture-confirmed),
    // so a later failure leaves a real, resumable course we keep. An unconfirmed
    // shell is the suspect state → report it (left in place; no auto-delete).
    if (!ctx.materialized) reportOrphanShell('import failed before the course was confirmed');
    if (e instanceof WriteError) {
      // Surface a snippet of the server's response body — a 4xx/5xx body usually
      // says exactly what it rejected (the live diagnostic).
      const body = e.raw ? ` — body: ${e.raw.slice(0, 300)}` : '';
      result.error = `[${e.step}] ${e.message}${body}`;
    } else {
      result.error = String(e);
    }
    return result;
  }


}
