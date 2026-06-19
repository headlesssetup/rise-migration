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

function isItem(x: unknown): x is SearchResultItem {
  return !!x && typeof x === 'object' && 'id' in (x as object);
}

// Coerce a value into a list of content items, accepting either an array or —
// as Rise's `content` field actually is — an object MAP keyed by content id.
function asItemArray(v: unknown): SearchResultItem[] {
  if (Array.isArray(v)) return v.filter(isItem);
  if (v && typeof v === 'object') return Object.values(v).filter(isItem);
  return [];
}

// Rise returns search hits under `content` as an id-keyed object map. Be
// tolerant of other shapes too (array, alternate wrapper keys).
function extractItems(data: unknown): SearchResultItem[] {
  if (Array.isArray(data)) return data.filter(isItem);
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  for (const key of ['content', 'items', 'results', 'data', 'courses', 'collection']) {
    const items = asItemArray(obj[key]);
    if (items.length) return items;
  }
  for (const v of Object.values(obj)) {
    const items = asItemArray(v);
    if (items.length) return items;
  }
  return [];
}

function describeShape(data: unknown): string {
  if (Array.isArray(data)) return `array(${data.length})`;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const total = 'totalCount' in obj ? `; totalCount=${obj.totalCount}` : '';
    const content =
      'content' in obj
        ? `; content=${
            Array.isArray(obj.content)
              ? `array(${obj.content.length})`
              : typeof obj.content
          }`
        : '';
    return `keys: [${Object.keys(obj).join(', ')}]${total}${content}`;
  }
  return typeof data;
}

/** Paced pagination through the whole library. Pages are 0-indexed; the loop
 *  is driven by `totalCount` so it's robust to server-side pageSize capping.
 *  pageSize=16 mirrors the Rise UI (16/page) so we page like a person, per the
 *  human-pacing invariant — e.g. 579 items => 37 paced pages. */
export async function listAllCourses(
  onEvent: (e: ProgressEvent) => void,
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
    if (all.length >= total) break; // collected the whole library
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
