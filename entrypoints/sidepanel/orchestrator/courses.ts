// Course orchestration: the strictly-sequential, human-paced course loops.
// CLAUDE.md invariant — every list page and every GET_COURSE finishes before
// the next starts, with a ~2s + jitter gap. No parallelism anywhere.

import { scanCourse, type CourseScan } from '@/core/census/scan';
import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import type { SearchResultItem } from '@/shared/types/rise';
import { rpc } from '../rpc';
import {
  MAX_PAGES,
  describeShape,
  extractItems,
  unwrap,
  type ProgressEvent,
} from './shared';

/** One cheap page-0 search to read the library's total course count without
 *  listing everything. Returns null if unavailable. */
export async function countCourses(): Promise<number | null> {
  const resp = await rpc({ type: 'SEARCH_COURSES', page: 0, pageSize: 1 });
  if (resp.type === 'SEARCH_RESULT' && resp.result.ok) {
    const tc = (resp.result.data as Record<string, unknown>).totalCount;
    return typeof tc === 'number' ? tc : null;
  }
  return null;
}

/** Paced pagination through the library. Pages are 0-indexed; the loop is
 *  driven by `totalCount` (robust to server-side pageSize capping) and stops
 *  once `limit` courses are collected. pageSize=16 mirrors the Rise UI so we
 *  page like a person, per the human-pacing invariant. */
export async function listAllCourses(
  onEvent: (e: ProgressEvent) => void,
  limit = Infinity,
  pacing: PacingConfig = DEFAULT_PACING,
  pageSize = 16,
): Promise<SearchResultItem[]> {
  const all: SearchResultItem[] = [];
  let total = Infinity;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await pacedDelay(pacing); // pace between pages
    onEvent({ kind: 'log', message: `Fetching course list — page ${page}…` });

    const resp = await rpc({ type: 'SEARCH_COURSES', page, pageSize });
    if (resp.type !== 'SEARCH_RESULT') break;
    if (!resp.result.ok) {
      onEvent({ kind: 'log', message: `List error: ${resp.result.error}` });
      break;
    }
    const data = resp.result.data;
    const items = extractItems(data);
    const totalCount = (data as Record<string, unknown>)?.totalCount;
    if (page === 0) {
      if (typeof totalCount === 'number') total = totalCount;
      onEvent({
        kind: 'log',
        message: `Search OK (HTTP ${resp.result.status}); ${describeShape(
          data,
        )}; extracted ${items.length} item(s).`,
      });
    }
    all.push(...items);
    onEvent({ kind: 'page', page, total: all.length });
    if (items.length === 0) break; // safety: nothing more to read
    if (all.length >= Math.min(limit, total)) break; // reached cap / library end
  }
  return all.slice(0, limit);
}

export interface ExportResult {
  saved: number;
  skipped: number;
  failed: string[];
}

/** Paced, strictly-sequential GET_COURSE fetch of the selected courses. Only
 *  performs the network fetch + save; census/catalog/novelty are built
 *  afterwards from EVERY saved course (scanSavedCourses), so a partial or
 *  multi-attempt run still yields a complete report. */
export async function exportCourses(
  courses: SearchResultItem[],
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
  pacing: PacingConfig = DEFAULT_PACING,
): Promise<ExportResult> {
  const failed: string[] = [];
  let saved = 0;
  let skipped = 0;
  let didNetwork = false;

  for (const [i, c] of courses.entries()) {
    onEvent({ kind: 'course', index: i, total: courses.length, courseId: c.id });

    // Resume: already on disk → skip the network (no pacing gap).
    if (await storage.hasCourse(c.id)) {
      skipped += 1;
      onEvent({
        kind: 'log',
        message: `Skipped (already saved): ${c.title ?? c.id}`,
      });
      continue;
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
    saved += 1;
    onEvent({ kind: 'log', message: `Saved: ${c.title ?? c.id}` });
  }

  return { saved, skipped, failed };
}

/** Scan EVERY course saved in the folder (from disk, no network) — the basis
 *  for census/catalog/novelty, so the report always covers the whole folder
 *  regardless of what was selected this run. */
export async function scanSavedCourses(
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
): Promise<CourseScan[]> {
  const ids = await storage.listSaved();
  onEvent({ kind: 'log', message: `Scanning ${ids.length} saved course(s)…` });
  const scans: CourseScan[] = [];
  for (const id of ids) {
    const raw = await storage.readCourse(id);
    if (!raw) continue;
    try {
      scans.push(scanCourse(unwrap(raw)));
    } catch {
      onEvent({ kind: 'log', message: `Skipped unreadable course: ${id}` });
    }
  }
  return scans;
}
