// The end-of-run summary block — split out of ./import (v0.9.0 restructure).

import { fmtElapsed } from '../log-lines';
import type { ProgressEvent } from './shared';
import type { CourseImportOutcome, CourseStatus, ImportRunResult } from './import';

/** Emit a run-level summary: counts by status + the ids needing attention or
 *  manual cleanup (resumable partials, orphaned shells, orphaned banks, not-started).
 *  The verdict line is ✓ only when every course is imported/planned; anything
 *  partial/stopped/failed/not-started makes it ⚠, and every list of courses
 *  needing attention is ⚠ too — the run verdict must never be the quietest
 *  line in the log. */
export function emitRunSummary(
  onEvent: (e: ProgressEvent) => void,
  outcomes: CourseImportOutcome[],
  notStarted: string[],
  stopped: boolean,
  dryRun: boolean,
  elapsedMs?: number,
): void {
  const by = (s: CourseStatus): CourseImportOutcome[] => outcomes.filter((o) => o.status === s);
  const imported = by('imported');
  const planned = by('planned');
  const partial = by('partial');
  const stoppedC = by('stopped');
  const failed = by('failed');
  const clean =
    partial.length + stoppedC.length + failed.length + notStarted.length === 0 && !stopped;

  const took = elapsedMs != null ? ` in ${fmtElapsed(elapsedMs)}` : '';
  onEvent({
    kind: 'log',
    message: `${stopped ? '⚠ ' : ''}— Run summary${stopped ? ' (STOPPED)' : ''}${took} —`,
  });
  const parts: string[] = [];
  parts.push(dryRun ? `${planned.length} planned` : `${imported.length} imported`);
  if (partial.length) parts.push(`${partial.length} partial`);
  if (stoppedC.length) parts.push(`${stoppedC.length} stopped`);
  if (failed.length) parts.push(`${failed.length} failed`);
  if (notStarted.length) parts.push(`${notStarted.length} not started`);
  onEvent({ kind: 'log', message: `  ${clean ? (dryRun ? 'DRY' : '✓') : '⚠'} ${parts.join(', ')}` });

  if (partial.length) {
    onEvent({
      kind: 'log',
      message:
        `  ⚠ needs review (re-run only retries supported writes): ` +
        partial.map((o) => `"${o.title ?? o.courseId}"`).join(', '),
    });
  }
  if (stoppedC.length) {
    onEvent({
      kind: 'log',
      message: `  ⚠ stopped/resumable (re-run to continue): ${stoppedC.map((o) => `"${o.title ?? o.courseId}"`).join(', ')}`,
    });
  }
  const orphanCourses = outcomes.filter((o) => o.orphanedCourseId);
  if (orphanCourses.length) {
    onEvent({
      kind: 'log',
      message: `  ⚠ orphaned course shells left in place (delete manually if needed): ${orphanCourses.map((o) => o.orphanedCourseId).join(', ')}`,
    });
  }
  const orphanBanks = outcomes.flatMap((o) =>
    (o.report.flags ?? []).filter((f) => f.kind === 'orphan-bank').map((f) => f.detail),
  );
  if (orphanBanks.length) {
    onEvent({ kind: 'log', message: `  ⚠ orphaned/incomplete banks left in place (delete manually if needed):` });
    for (const d of orphanBanks) onEvent({ kind: 'log', message: `    - ${d}` });
  }
  if (notStarted.length) {
    onEvent({ kind: 'log', message: `  ⚠ not started: ${notStarted.length} course(s) — re-run to import` });
  }
}
