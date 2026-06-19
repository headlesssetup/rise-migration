// Panel-side orchestration: the strictly-sequential, human-paced loops.
// CLAUDE.md invariant — every list page and every GET_COURSE finishes before
// the next starts, with a ~2s + jitter gap. No parallelism anywhere.

import { extractBanks, hasInlineQuestions } from '@/core/census/question-banks';
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

export interface BankFetchResult {
  bankCount: number;
  saved: number;
  skipped: number;
  failed: string[];
}

/** Detect reusable question banks, then paced-fetch + save each raw (API ref §9).
 *  Banks are separate from course content and referenced by draw-from-bank
 *  blocks, so they're needed for that block's migration. */
export async function fetchQuestionBanks(
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
  pacing: PacingConfig = DEFAULT_PACING,
): Promise<BankFetchResult> {
  onEvent({ kind: 'log', message: 'Listing question banks…' });
  const listResp = await rpc({ type: 'LIST_QUESTION_BANKS' });
  if (listResp.type !== 'BANKS_RESULT' || !listResp.result.ok) {
    const err =
      listResp.type === 'BANKS_RESULT' && !listResp.result.ok
        ? listResp.result.error
        : 'unexpected response';
    onEvent({ kind: 'log', message: `Question banks unavailable: ${err}` });
    return { bankCount: 0, saved: 0, skipped: 0, failed: [] };
  }

  await storage.writeBankIndex(listResp.result.data.raw);
  const banks = extractBanks(listResp.result.data.doc);
  onEvent({
    kind: 'log',
    message: `Found ${banks.length} question bank(s)${
      banks.length === 0 ? ` (response shape: ${describeShape(listResp.result.data.doc)})` : ''
    }.`,
  });

  const failed: string[] = [];
  let saved = 0;
  let didNetwork = false;

  for (const [i, b] of banks.entries()) {
    onEvent({ kind: 'course', index: i, total: banks.length, courseId: b.id });

    // The list already carries questions inline — save directly, no fetch.
    if (hasInlineQuestions(b.doc)) {
      await storage.writeQuestionBank(b.id, JSON.stringify(b.doc));
      saved += 1;
      continue;
    }

    // Fallback: a bank without inline questions → fetch it by id.
    if (didNetwork) await pacedDelay(pacing);
    didNetwork = true;
    const resp = await rpc({ type: 'GET_QUESTION_BANK', bankId: b.id });
    if (resp.type !== 'BANK_RESULT' || !resp.result.ok) {
      failed.push(b.id);
      onEvent({ kind: 'log', message: `Failed bank ${b.id}` });
      continue;
    }
    await storage.writeQuestionBank(b.id, resp.result.data.raw);
    saved += 1;
    onEvent({ kind: 'log', message: `Saved bank: ${b.title ?? b.id}` });
  }
  return { bankCount: banks.length, saved, skipped: 0, failed };
}

/** Load every saved question bank from disk for profiling. */
export async function scanSavedBanks(
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
): Promise<{ id: string; doc: unknown }[]> {
  const ids = await storage.listSavedBanks();
  onEvent({ kind: 'log', message: `Scanning ${ids.length} saved bank(s)…` });
  const out: { id: string; doc: unknown }[] = [];
  for (const id of ids) {
    const raw = await storage.readQuestionBank(id);
    if (!raw) continue;
    try {
      out.push({ id, doc: JSON.parse(raw) });
    } catch {
      onEvent({ kind: 'log', message: `Skipped unreadable bank: ${id}` });
    }
  }
  return out;
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
