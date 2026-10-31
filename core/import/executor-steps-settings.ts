// Executor step handlers — course PUBLISH/EXPORT settings (handover 2026-08-31,
// blocker 3). The write is capture-proven: the Rise publish dialog sends the
// FULL exportSettings object in one `UPDATE_COURSE_DEBOUNCE {id, exportSettings}`
// (`-import_fail2.mitm` 14:20, mercedes 13:19/13:21, fonts2 15:27). Course
// SETTINGS (sidebarMode, navigationMode, …) are NOT written here — their write
// envelopes still need the focused Settings-panel capture before implementation.

import * as env from './envelopes';
import { payloadOf } from './executor-types';
import { remapMediaKeys, retargetMediaHosts } from './remap';
import type { PlanStep } from './plan';
import type { ExecCtx } from './executor-run-state';

/** UPDATE_COURSE_DEBOUNCE {id, settings} — the Settings panel writes the FULL
 *  object each time (capture 2026-08-31: `{aiTutorEnabled:false|true}`). A
 *  source with EMPTY settings still writes `{aiTutorEnabled:false}`: the
 *  target shell defaults the AI tutor ON, which the source does not show —
 *  behavior must follow the source. */
export async function handleSetCourseSettings(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'set-course-settings' }>,
): Promise<void> {
  const { deps, log, pfx, send } = ctx;
  const src = (deps.input.course.course as Record<string, unknown> | undefined)?.settings;
  const settings =
    src && typeof src === 'object' && !Array.isArray(src) && Object.keys(src).length > 0
      ? (src as Record<string, unknown>)
      : { aiTutorEnabled: false };
  await send(env.updateCourseSettings(ctx.newCourseId, settings), step.kind);
  log(
    `${pfx()} ${ctx.dryRun ? 'DRY  would write' : 'OK   written:'} course settings (${Object.keys(settings).join(', ')})`,
  );
}

/** UPDATE_COURSE_DEBOUNCE {id, aiTutorConfig} — capture 2026-08-31 (name +
 *  avatar). The avatar image is uploaded first via the normal chain, then the
 *  config ships with its keys remapped (no source key may survive). */
export async function handleSetAiTutorConfig(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'set-ai-tutor-config' }>,
): Promise<void> {
  const { deps, log, keyMap, pfx, send, uploadOne } = ctx;
  const src = (deps.input.course.course as Record<string, unknown> | undefined)?.aiTutorConfig;
  if (!src || typeof src !== 'object') return;
  for (const key of step.sourceKeys) {
    await uploadOne(key, key.split('/').pop() ?? 'avatar', step.kind);
  }
  const config = retargetMediaHosts(
    remapMediaKeys(src as Record<string, unknown>, keyMap),
    deps.targetPlane,
  );
  await send(env.updateCourseAiTutorConfig(ctx.newCourseId, config), step.kind);
  log(`${pfx()} ${ctx.dryRun ? 'DRY  would write' : 'OK   written:'} AI-tutor configuration`);
}

export async function handleSetExportSettings(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'set-export-settings' }>,
): Promise<void> {
  const { deps, ids, log, result, pfx, send } = ctx;
  const src = (deps.input.course.course as Record<string, unknown> | undefined)?.exportSettings;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return;
  const es: Record<string, unknown> = { ...(src as Record<string, unknown>) };

  // `identifier` derives from the course id (capture: `<courseId>_rise`).
  if (typeof es.identifier === 'string' && es.identifier !== '') {
    es.identifier = `${ctx.newCourseId}_rise`;
  }
  // `shareId` must be the TARGET's own (server-assigned at create, read at the
  // handshake) — a source shareId is a foreign reference.
  if ('shareId' in es) {
    if (ctx.targetShareId) es.shareId = ctx.targetShareId;
    else delete es.shareId; // dry-run / unknown → the server keeps its own
  }
  // `activeEdition` is target publish lifecycle (advances per publish) — never
  // carried over; null matches a never-published course.
  if ('activeEdition' in es) es.activeEdition = null;

  // `quizId` → the NEW quiz lesson id. The archive can hold a STALE id that
  // names no lesson (capture 2026-08-31: after a post-export source publish,
  // live Rise corrected CRM's quizId — the archive kept the old one; mig30oct
  // 2026-10-30: 4 of 11 courses). A stale id with exactly ONE quiz lesson in the
  // course is repaired to that lesson — the Publish dialog shows that same quiz
  // as selected. Otherwise it is dropped, and flagged only when it matters:
  // completion rides the quiz (`completeWith: 'quiz'`), or the id named a real
  // source lesson that did not import.
  if (typeof es.quizId === 'string' && es.quizId !== '') {
    const srcQuizId = es.quizId;
    const lessons = Array.isArray(deps.input.course.lessons) ? deps.input.course.lessons : [];
    const namesSourceLesson = lessons.some((l) => l.id === srcQuizId);
    const quizLessons = lessons.filter((l) => l.type === 'quiz' && typeof l.id === 'string');
    const mapped = ids.get(srcQuizId);
    const repaired =
      !mapped && !namesSourceLesson && quizLessons.length === 1
        ? ids.get(quizLessons[0]!.id as string)
        : undefined;
    if (mapped) {
      es.quizId = mapped;
    } else if (repaired) {
      es.quizId = repaired;
      const t = quizLessons[0]!.title;
      ctx.decide(
        'Completion quiz',
        `The archived completion-quiz id (${srcQuizId}) names no lesson; bound completion to the course's only quiz${typeof t === 'string' && t ? ` "${t}"` : ''}`,
      );
    } else {
      es.quizId = null;
      if (namesSourceLesson || es.completeWith === 'quiz') {
        result.flags.push({
          kind: 'export-settings',
          detail:
            `exportSettings.quizId ${srcQuizId} has no imported counterpart` +
            (namesSourceLesson ? '' : ` (stale archive id; ${quizLessons.length} quiz lessons)`) +
            ' — select the completion quiz manually in Publish settings',
        });
        log(`${pfx()} ⚠ FLAG exportSettings.quizId not mappable — completion quiz must be selected manually`);
      } else {
        ctx.decide(
          'Completion quiz',
          `The archived completion-quiz id (${srcQuizId}) names no lesson and completion does not use a quiz (completeWith: ${String(es.completeWith ?? 'unset')}); cleared it`,
        );
      }
    }
  }
  // `storylineId` (completion via a Storyline block) — same rule.
  if (typeof es.storylineId === 'string' && es.storylineId !== '') {
    const mapped = ids.get(es.storylineId);
    if (mapped) {
      es.storylineId = mapped;
    } else {
      es.storylineId = null;
      result.flags.push({
        kind: 'export-settings',
        detail:
          'exportSettings.storylineId has no imported counterpart — select the completion Storyline block manually in Publish settings',
      });
    }
  }

  await send(env.updateCourseExportSettings(ctx.newCourseId, es), step.kind);
  log(
    `${pfx()} ${ctx.dryRun ? 'DRY  would write' : 'OK   written:'} publish/export settings${es.quizId ? ` (quizId → ${String(es.quizId)})` : ''}`,
  );
}

/** Bind the course's label set (UPDATE_COURSE {id, labelSetId}). A built-in
 *  set binds the TARGET's own built-in for the language (ids are account-
 *  specific; GET_COURSE at the create handshake listed them). A custom set is
 *  recreated once per run (labelSetCache, keyed by SOURCE set id). Anything
 *  unbindable is flagged — the course still imports. */
export async function handleSetCourseLabelset(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'set-course-labelset' }>,
): Promise<void> {
  const { deps, dryRun, log, mint, result, pfx, send } = ctx;
  let targetSetId: string | undefined;
  if (step.builtin) {
    const match = ctx.targetLabelSets.find(
      (s) => s.defaultSet === true && s.deleted !== true && s.iso639Code === step.iso639Code,
    );
    // A dry run predicts from the sets pre-read at run start; only when those
    // could not be read (logged) does it assume the language exists.
    targetSetId =
      typeof match?.id === 'string' ? match.id : dryRun && ctx.targetLabelSets.length === 0 ? mint() : undefined;
  } else {
    const cache = deps.labelSetCache;
    targetSetId = step.sourceLabelSetId ? cache?.get(step.sourceLabelSetId) : undefined;
    if (targetSetId) {
      log(`${pfx()} reuse label set "${step.name}" (already recreated this run)`);
    } else {
      const created = payloadOf(
        await send(env.createLabelSet({ iso639Code: step.iso639Code, name: step.name }), step.kind),
      );
      targetSetId = dryRun ? mint() : typeof created.id === 'string' ? created.id : undefined;
      if (targetSetId && Object.keys(step.labels).length > 0) {
        await send(env.updateLabels({ id: targetSetId, labels: step.labels }), step.kind);
      }
      if (targetSetId && step.sourceLabelSetId) cache?.set(step.sourceLabelSetId, targetSetId);
    }
  }
  if (!targetSetId) {
    result.flags.push({
      kind: 'label-set',
      detail: `Interface language "${step.name}" (${step.iso639Code}) could not be bound — open Settings → Labels and select it`,
    });
    log(`${pfx()} ⚠ FLAG label set "${step.name}" not available on the target — select it manually`);
    return;
  }
  await send(env.updateCourseLabelSet(ctx.newCourseId, targetSetId), step.kind);
  log(`${pfx()} ${dryRun ? 'DRY  would bind' : 'OK   bound'} label set "${step.name}" (${step.iso639Code})`);
  ctx.decide(
    'Interface language',
    step.sourceLabelSetId === null
      ? `The source course names no label set (it used its account's default, which the export cannot see); set "${step.name}" (${step.iso639Code}) as chosen for this run`
      : step.builtin
        ? `Bound the target account's own built-in "${step.name}" (${step.iso639Code}) label set`
        : `Recreated the custom label set "${step.name}" (${step.iso639Code}) on the target and bound it`,
  );
}
