// Executor step handlers — course PUBLISH/EXPORT settings (handover 2026-08-31,
// blocker 3). The write is capture-proven: the Rise publish dialog sends the
// FULL exportSettings object in one `UPDATE_COURSE_DEBOUNCE {id, exportSettings}`
// (`-import_fail2.mitm` 14:20, mercedes 13:19/13:21, fonts2 15:27). Course
// SETTINGS (sidebarMode, navigationMode, …) are NOT written here — their write
// envelopes still need the focused Settings-panel capture before implementation.

import * as env from './envelopes';
import type { PlanStep } from './plan';
import type { ExecCtx } from './executor-run-state';

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

  // `quizId` → the NEW quiz lesson id. An unmapped id is dropped + flagged: the
  // archive can hold a stale id (capture 2026-08-31: after a post-export source
  // publish, live Rise corrected CRM's quizId — the archive kept the old one).
  if (typeof es.quizId === 'string' && es.quizId !== '') {
    const mapped = ids.get(es.quizId);
    if (mapped) {
      es.quizId = mapped;
    } else {
      es.quizId = null;
      result.flags.push({
        kind: 'export-settings',
        detail:
          `exportSettings.quizId ${String((src as Record<string, unknown>).quizId)} has no imported ` +
          'counterpart (stale archive id?) — select the completion quiz manually in Publish settings',
      });
      log(`${pfx} ⚠ FLAG exportSettings.quizId not mappable — completion quiz must be selected manually`);
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
  log(`${pfx} OK   publish/export settings written${es.quizId ? ` (quizId → ${String(es.quizId)})` : ''}`);
}
