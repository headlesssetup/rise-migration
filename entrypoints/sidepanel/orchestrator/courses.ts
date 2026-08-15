// Course orchestration: the strictly-sequential, human-paced course loops.
// CLAUDE.md invariant — every list page and every GET_COURSE finishes before
// the next starts, with a ~2s + jitter gap. No parallelism anywhere.

import { scanCourse, type CourseScan } from '@/core/census/scan';
import {
  archiveIsStaleForLocales,
  formatLocales,
  isLocalizedStack,
  listingLocales,
  materializeLocale,
} from '@/core/l10n';
import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import type { GetCourseDocument, SearchResultItem } from '@/shared/types/rise';
import { rpc } from '../rpc';
import {
  MAX_PAGES,
  describeShape,
  extractItems,
  pageCapWarning,
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
  term?: string,
): Promise<SearchResultItem[]> {
  const all: SearchResultItem[] = [];
  let total = Infinity;
  // Every exit below is a real end-of-list / cap / error; only running the loop
  // to exhaustion means MAX_PAGES truncated the library, which must be loud.
  let exhausted = true;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await pacedDelay(pacing); // pace between pages
    onEvent({ kind: 'log', message: `Fetching course list — page ${page}…` });

    const resp = await rpc({ type: 'SEARCH_COURSES', page, pageSize, term });
    if (resp.type !== 'SEARCH_RESULT') {
      exhausted = false;
      onEvent({
        kind: 'log',
        message: `List error: ${resp.type === 'ERROR' ? resp.error : 'unexpected background response'}`,
      });
      break;
    }
    if (!resp.result.ok) {
      exhausted = false;
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
    if (items.length === 0) {
      exhausted = false; // nothing more to read — the library really ended
      break;
    }
    if (all.length >= Math.min(limit, total)) {
      exhausted = false; // reached the caller's cap / the library end
      break;
    }
  }
  if (exhausted) onEvent(pageCapWarning(all.length));
  return all.slice(0, limit);
}

export interface ExportResult {
  saved: number;
  skipped: number;
  failed: string[];
  /** Set only when continuing would repeat the same run-wide auth failure. */
  stopped?: { courseId: string; remaining: number; reason: string };
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
  let stopped: ExportResult['stopped'];

  for (const [i, c] of courses.entries()) {
    onEvent({ kind: 'course', index: i, total: courses.length, courseId: c.id });
    const pfx = `[${i + 1}/${courses.length}]`;
    // Multi-language suffix straight from the listing (empty for monolingual).
    const langs = formatLocales(listingLocales(c));
    const mlNote = langs ? ` — multi-language (${langs})` : '';

    // Resume: already on disk → skip the network (no pacing gap) — UNLESS the
    // listing shows languages the archived copy predates (a course exported
    // before its stack conversion / before a language was added would keep a
    // frozen, l10n-less archive forever). Staleness check is disk-only.
    if (await storage.hasCourse(c.id)) {
      let stale = false;
      if (langs) {
        try {
          const raw = await storage.readCourse(c.id);
          stale = !!raw && archiveIsStaleForLocales(c, unwrap(raw));
        } catch {
          stale = false; // unreadable archive is reported by the census scan
        }
      }
      if (!stale) {
        skipped += 1;
        onEvent({
          kind: 'log',
          message: `${pfx} Skipped (already saved): ${c.title ?? c.id}${mlNote}`,
        });
        continue;
      }
      onEvent({
        kind: 'log',
        message: `${pfx} Archive is missing language(s) shown by the listing — re-fetching: ${c.title ?? c.id}${mlNote}`,
      });
    }

    if (didNetwork) await pacedDelay(pacing); // human-paced gap between fetches
    didNetwork = true;

    const resp = await rpc({ type: 'GET_COURSE', courseId: c.id });
    if (resp.type !== 'COURSE_RESULT' || !resp.result.ok) {
      const err =
        resp.type === 'COURSE_RESULT' && !resp.result.ok
          ? resp.result.error
          : resp.type === 'ERROR'
            ? resp.error
            : 'unexpected response';
      failed.push(c.id);
      onEvent({ kind: 'log', message: `${pfx} Failed ${c.id}: ${err}` });
      // A token is run-wide, not course-specific. The background has already
      // tried one automatic editor bootstrap + one retry; if that bounded
      // recovery failed, draining the rest of the queue would only manufacture
      // hundreds of identical failures. Stop cleanly and leave the archive
      // resumable from the next run.
      if (
        resp.type === 'COURSE_RESULT' &&
        !resp.result.ok &&
        resp.result.code === 'AUTH_REQUIRED'
      ) {
        const remaining = courses.length - i - 1;
        stopped = { courseId: c.id, remaining, reason: err };
        onEvent({
          kind: 'log',
          message:
            `${pfx} Export stopped after automatic token recovery failed; ` +
            `${remaining} course(s) were left untouched and can be resumed safely.`,
        });
        break;
      }
      continue;
    }

    await storage.writeCourse(c.id, resp.result.data.raw);
    saved += 1;
    onEvent({ kind: 'log', message: `${pfx} Saved: ${c.title ?? c.id}${mlNote}` });
  }

  return { saved, skipped, failed, ...(stopped ? { stopped } : {}) };
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
      let doc = unwrap(raw) as GetCourseDocument;
      // Stacks are scanned as their MATERIALIZED default locale: block shapes
      // profile on real values instead of {l10nId} refs (which would flood the
      // novelty report with `*.l10nId` field noise). Asset discovery is
      // unaffected — it scans the RAW doc (core/assets), whose generic walk
      // already covers the per-locale translation tables.
      if (isLocalizedStack(doc)) {
        const m = materializeLocale(doc);
        if (m.unresolved.length > 0) {
          onEvent({
            kind: 'log',
            message: `WARN ${id}: ${m.unresolved.length} l10n ref(s) have no value in any language (kept as refs)`,
          });
        }
        doc = m.doc;
      }
      scans.push(scanCourse(doc));
    } catch {
      onEvent({ kind: 'log', message: `Skipped unreadable course: ${id}` });
    }
  }
  return scans;
}
