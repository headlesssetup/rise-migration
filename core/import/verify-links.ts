// Parity check — intra-course lesson links (v0.9.10; split out of verify.ts to
// keep that module under the size cap). `verify.ts` re-exports the name, so
// import sites are unchanged.

import { orderedLessons } from './verify';
import type { ParityIssue } from './verify';
import type { ManualFlag } from './executor-types';
import type { GetCourseDocument } from '@/shared/types/rise';

/**
 * Intra-course lesson links must NAME A REAL TARGET LESSON.
 *
 * `canonicalize` tokenises every id-shaped string to `#id`, which is right for
 * ids we deliberately re-mint but blind here: a live lesson id and a dead one
 * compare equal, so a broken link passed parity silently (live 2026-08-31, the
 * Mercedes CRM "Impressum" button). This is the same assertion
 * `compareExportSettings` already makes for `exportSettings.quizId`, applied to
 * the cross-ref the block walk cannot see.
 *
 * Only `type: "lesson"` destinations are checked — siblings put a URL (`link`)
 * or the literal `exit-course` in that same field. A block the import already
 * flagged `lesson-link` is an EXPECTED divergence, not a blocking one.
 */
export function compareLessonLinks(
  source: GetCourseDocument,
  target: GetCourseDocument,
  flags: ManualFlag[],
  issues: ParityIssue[],
  expected: ParityIssue[],
): void {
  const sourceLessonIds = new Set(
    orderedLessons(source).map((l) => String(l.id ?? '')),
  );
  const targetLessonIds = new Set(
    orderedLessons(target).map((l) => String(l.id ?? '')),
  );
  const flaggedBlocks = new Set(
    flags
      .filter((f) => f.kind === 'lesson-link')
      .map((f) => f.sourceBlockId ?? ''),
  );
  orderedLessons(target).forEach((lesson, li) => {
    (lesson.items ?? []).forEach((block, bi) => {
      const dests: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        const o = node as Record<string, unknown>;
        if (o.type === 'lesson' && typeof o.destination === 'string')
          dests.push(o.destination);
        for (const v of Object.values(o)) walk(v);
      };
      walk(block);
      for (const d of dests) {
        if (targetLessonIds.has(d)) continue;
        const bid = String((block as { id?: unknown }).id ?? bi);
        const issue: ParityIssue = {
          kind: 'content-changed',
          path: `lessons[${li}] / blocks[${bi}] lesson link`,
          detail: sourceLessonIds.has(d)
            ? `destination ${d} is still the SOURCE lesson id — the link was never remapped`
            : `destination ${d} names no target lesson`,
        };
        if (flaggedBlocks.has(bid)) expected.push({ ...issue, expected: true });
        else issues.push(issue);
      }
    });
  });
}
