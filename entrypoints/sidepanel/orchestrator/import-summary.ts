// The end-of-run summary block — split out of ./import (v0.9.0 restructure).

import type { ProgressEvent } from './shared';
import type { CourseImportOutcome, CourseStatus, ImportRunResult } from './import';

/** Emit a run-level summary: counts by status + the ids needing attention or
 *  manual cleanup (resumable partials, orphaned shells, orphaned banks, not-started). */
export function emitRunSummary(
  onEvent: (e: ProgressEvent) => void,
  outcomes: CourseImportOutcome[],
  notStarted: string[],
  stopped: boolean,
  dryRun: boolean,
): void {
  const by = (s: CourseStatus): CourseImportOutcome[] => outcomes.filter((o) => o.status === s);
  const imported = by('imported');
  const planned = by('planned');
  const partial = by('partial');
  const stoppedC = by('stopped');
  const failed = by('failed');

  onEvent({ kind: 'log', message: `— Run summary${stopped ? ' (STOPPED)' : ''} —` });
  const parts: string[] = [];
  parts.push(dryRun ? `${planned.length} planned` : `${imported.length} imported`);
  if (partial.length) parts.push(`${partial.length} partial`);
  if (stoppedC.length) parts.push(`${stoppedC.length} stopped`);
  if (failed.length) parts.push(`${failed.length} failed`);
  if (notStarted.length) parts.push(`${notStarted.length} not started`);
  onEvent({ kind: 'log', message: `  ${parts.join(', ')}` });

  if (partial.length) {
    onEvent({
      kind: 'log',
      message:
        `  needs review (re-run only retries supported writes): ` +
        partial.map((o) => `"${o.title ?? o.courseId}"`).join(', '),
    });
  }
  if (stoppedC.length) {
    onEvent({
      kind: 'log',
      message: `  stopped/resumable (re-run to continue): ${stoppedC.map((o) => `"${o.title ?? o.courseId}"`).join(', ')}`,
    });
  }
  const orphanCourses = outcomes.filter((o) => o.orphanedCourseId);
  if (orphanCourses.length) {
    onEvent({
      kind: 'log',
      message: `  orphaned course shells left in place (delete manually if needed): ${orphanCourses.map((o) => o.orphanedCourseId).join(', ')}`,
    });
  }
  const orphanBanks = outcomes.flatMap((o) =>
    o.report.flags.filter((f) => f.kind === 'orphan-bank').map((f) => f.detail),
  );
  if (orphanBanks.length) {
    onEvent({ kind: 'log', message: `  orphaned/incomplete banks left in place (delete manually if needed):` });
    for (const d of orphanBanks) onEvent({ kind: 'log', message: `    - ${d}` });
  }
  if (notStarted.length) {
    onEvent({ kind: 'log', message: `  not started: ${notStarted.length} course(s) — re-run to import` });
  }
}
