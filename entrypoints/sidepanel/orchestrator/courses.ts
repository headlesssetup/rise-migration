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
import {
  blockumentManifest,
  collectBlockumentIds,
  type BlockumentArchive,
  type BlockumentGraph,
} from '@/core/mondrian';
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

/**
 * Fetch + archive every mondrian (Custom block) blockument a course references
 * → `blockuments/<courseId>.json`. Paced single-manifest reads on the SOURCE
 * plane's mondrian-api (docs/rise-api-reference.md §mondrian). Returns true
 * when the archive now covers every referenced id; false is LOUD — a course
 * whose blockuments are missing cannot be imported (a dangling `blockumentId`
 * 404s preview/publish boot on the target, 2026-08-31 root cause).
 */
export async function fetchCourseBlockuments(
  courseId: string,
  doc: unknown,
  plane: 'us' | 'eu' | null,
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
  pacing: PacingConfig,
  pfx: string,
): Promise<boolean> {
  const ids = collectBlockumentIds(doc);
  if (ids.length === 0) return true;

  // Resume: keep graphs an earlier run already archived; fetch only the rest.
  const existing: Record<string, BlockumentGraph> = {};
  try {
    const prior = await storage.readBlockuments(courseId);
    if (prior) {
      const parsed = JSON.parse(prior) as BlockumentArchive;
      Object.assign(existing, parsed.blockuments ?? {});
    }
  } catch {
    /* unreadable prior file → refetch everything */
  }
  const missing = ids.filter((id) => !existing[id]);
  if (missing.length === 0) {
    onEvent({
      kind: 'log',
      message: `${pfx} Custom-block documents already archived (${ids.length})`,
    });
    return true;
  }
  if (plane !== 'us' && plane !== 'eu') {
    onEvent({
      kind: 'log',
      message: `${pfx} ERROR: course references ${missing.length} Custom-block document(s) but the Rise plane is unknown — cannot address mondrian-api. Re-run with a logged-in Rise tab.`,
    });
    return false;
  }
  let failed = 0;
  for (const [j, bid] of missing.entries()) {
    await pacedDelay(pacing);
    onEvent({
      kind: 'log',
      message: `${pfx} [${j + 1}/${missing.length} blockuments] fetching ${bid}…`,
    });
    const resp = await rpc({ type: 'RELAY_WRITE', spec: blockumentManifest(plane, bid) });
    if (resp.type !== 'WRITE_RESULT' || !resp.result.ok) {
      failed += 1;
      const err =
        resp.type === 'WRITE_RESULT'
          ? `HTTP ${resp.result.status}${resp.result.text ? `: ${resp.result.text.slice(0, 120)}` : ''}`
          : resp.type === 'ERROR'
            ? resp.error
            : 'unexpected response';
      onEvent({
        kind: 'log',
        message: `${pfx} ERROR: blockument ${bid} manifest failed (${err}) — the course cannot be imported until this is archived`,
      });
      continue;
    }
    try {
      const graph = JSON.parse(resp.result.text) as BlockumentGraph;
      if (!graph.blockuments?.[bid]) throw new Error('manifest has no blockument doc');
      existing[bid] = graph;
      const v = graph.blockuments[bid]?._v;
      if (v !== undefined && v !== 47) {
        // Novelty tripwire: every 2026-08-31 capture was `_v: 47`. A different
        // schema version is archived verbatim but must not pass unnoticed.
        onEvent({
          kind: 'log',
          message: `${pfx} WARN: blockument ${bid} has schema _v=${String(v)} (captures were 47) — review before import`,
        });
      }
    } catch (e) {
      failed += 1;
      onEvent({
        kind: 'log',
        message: `${pfx} ERROR: blockument ${bid} manifest unparseable (${String(e)})`,
      });
    }
  }
  const archive: BlockumentArchive = {
    courseId,
    generatedAt: new Date().toISOString(),
    blockuments: existing,
  };
  await storage.writeBlockuments(courseId, JSON.stringify(archive));
  onEvent({
    kind: 'log',
    message: `${pfx} Archived ${Object.keys(existing).length}/${ids.length} Custom-block document(s)${failed ? ` — ${failed} FAILED` : ''}`,
  });
  return failed === 0;
}

/** Paced, strictly-sequential GET_COURSE fetch of the selected courses. Only
 *  performs the network fetch + save; census/catalog/novelty are built
 *  afterwards from EVERY saved course (scanSavedCourses), so a partial or
 *  multi-attempt run still yields a complete report. Blockuments (Custom-block
 *  documents) are fetched right after each course — including as a BACKFILL for
 *  an already-saved course whose archive predates 0.9.9. */
export async function exportCourses(
  courses: SearchResultItem[],
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
  pacing: PacingConfig = DEFAULT_PACING,
  plane: 'us' | 'eu' | null = null,
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
        // Backfill: a pre-0.9.9 archive has the course but not its Custom-block
        // documents — fetch just those so a re-run completes the archive.
        try {
          const raw = await storage.readCourse(c.id);
          if (raw) {
            const ok = await fetchCourseBlockuments(
              c.id, unwrap(raw), plane, storage, onEvent, pacing, pfx,
            );
            if (!ok) failed.push(c.id);
          }
        } catch {
          /* unreadable archive is reported by the census scan */
        }
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

    // Custom-block (mondrian) documents ride the course export — without them
    // the course can never import (dangling blockumentId → boot 404 on target).
    try {
      const ok = await fetchCourseBlockuments(
        c.id, unwrap(resp.result.data.raw), plane, storage, onEvent, pacing, pfx,
      );
      if (!ok) failed.push(c.id);
    } catch (e) {
      failed.push(c.id);
      onEvent({ kind: 'log', message: `${pfx} ERROR archiving Custom-block documents: ${String(e)}` });
    }
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
