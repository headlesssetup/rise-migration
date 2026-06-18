// Panel-side orchestration: the strictly-sequential, human-paced loops.
// CLAUDE.md invariant — every list page and every GET_COURSE finishes before
// the next starts, with a ~2s + jitter gap. No parallelism anywhere.

import { scanCourse, type CourseScan } from '@/core/census/scan';
import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import type { GetCourseDocument, SearchResultItem } from '@/shared/types/rise';
import { rpc } from './rpc';

const MAX_PAGES = 200;

export type ProgressEvent =
  | { kind: 'log'; message: string }
  | { kind: 'page'; page: number; total: number }
  | { kind: 'course'; index: number; total: number; courseId: string };

function unwrap(raw: string): GetCourseDocument {
  const parsed = JSON.parse(raw) as { payload?: unknown };
  return (parsed.payload ?? parsed) as GetCourseDocument;
}

/** Paced pagination through the whole course list. */
export async function listAllCourses(
  onEvent: (e: ProgressEvent) => void,
  pacing: PacingConfig = DEFAULT_PACING,
  pageSize = 16,
): Promise<SearchResultItem[]> {
  const all: SearchResultItem[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) await pacedDelay(pacing); // pace between pages
    onEvent({ kind: 'log', message: `Fetching course list — page ${page}…` });

    const resp = await rpc({ type: 'SEARCH_COURSES', page, pageSize });
    if (resp.type !== 'SEARCH_RESULT') break;
    if (!resp.result.ok) {
      onEvent({ kind: 'log', message: `List error: ${resp.result.error}` });
      break;
    }
    const items = Array.isArray(resp.result.data.items)
      ? resp.result.data.items
      : [];
    all.push(...items);
    onEvent({ kind: 'page', page, total: all.length });
    if (items.length < pageSize) break; // reached the last page
  }
  return all;
}

export interface ExportResult {
  scans: CourseScan[];
  saved: number;
  skipped: number;
  failed: string[];
}

/** Paced, strictly-sequential GET_COURSE export of the selected courses. */
export async function exportCourses(
  courses: SearchResultItem[],
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
  pacing: PacingConfig = DEFAULT_PACING,
): Promise<ExportResult> {
  const scans: CourseScan[] = [];
  const failed: string[] = [];
  let saved = 0;
  let skipped = 0;
  let didNetwork = false;

  for (const [i, c] of courses.entries()) {
    onEvent({ kind: 'course', index: i, total: courses.length, courseId: c.id });

    // Resume: if already saved, scan from disk — no network, no pacing gap.
    if (await storage.hasCourse(c.id)) {
      const raw = await storage.readCourse(c.id);
      if (raw) {
        scans.push(scanCourse(unwrap(raw)));
        skipped += 1;
        onEvent({
          kind: 'log',
          message: `Skipped (already saved): ${c.title ?? c.id}`,
        });
        continue;
      }
    }

    if (didNetwork) await pacedDelay(pacing); // human-paced gap between fetches
    didNetwork = true;

    const resp = await rpc({ type: 'GET_COURSE', courseId: c.id });
    if (resp.type !== 'COURSE_RESULT' || !resp.result.ok) {
      const err =
        resp.type === 'COURSE_RESULT' && !resp.result.ok
          ? resp.result.error
          : 'unexpected response';
      failed.push(c.id);
      onEvent({ kind: 'log', message: `Failed ${c.id}: ${err}` });
      continue;
    }

    await storage.writeCourse(c.id, resp.result.data.raw);
    scans.push(scanCourse(resp.result.data.doc));
    saved += 1;
    onEvent({ kind: 'log', message: `Saved: ${c.title ?? c.id}` });
  }

  return { scans, saved, skipped, failed };
}
