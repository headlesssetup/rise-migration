// Shared orchestration helpers + types. The orchestrator is split by domain
// (courses / folders / banks / assets); this module holds what they have in
// common — the progress event type and the tolerant response-shape parsers.

import type { GetCourseDocument, SearchResultItem } from '@/shared/types/rise';

export const MAX_PAGES = 200;

export type ProgressEvent =
  | { kind: 'log'; message: string }
  | { kind: 'page'; page: number; total: number }
  | { kind: 'course'; index: number; total: number; courseId: string; title?: string }
  // Live import status for the log-header countdown. `etaSeconds` is null until
  // there's enough signal to estimate; `done` marks the run finished.
  | { kind: 'import-status'; label: string; etaSeconds: number | null; done: boolean };

/**
 * Build a live countdown (`import-status`) event from elapsed wall-clock and the
 * fraction of work done. Self-correcting and pacing-agnostic. The ETA is null
 * until there's a little signal (>2% done AND >3s elapsed) so the first estimate
 * isn't wildly noisy; the header shows "estimating…" until then. Shared by the
 * import, storyline export, and storyline upload loops.
 */
export function etaStatus(args: {
  label: string;
  doneFraction: number;
  runStartMs: number;
  nowMs: number;
}): Extract<ProgressEvent, { kind: 'import-status' }> {
  const f = Math.max(0, Math.min(1, args.doneFraction));
  const elapsed = args.nowMs - args.runStartMs;
  const etaSeconds =
    f > 0.02 && elapsed > 3000 ? Math.round((elapsed * (1 - f)) / f / 1000) : null;
  return { kind: 'import-status', label: args.label, etaSeconds, done: false };
}

/** Unwrap a saved raw body — accept either the ducks envelope (`{payload}`) or
 *  the bare payload — into the course document we scan. */
export function unwrap(raw: string): GetCourseDocument {
  const parsed = JSON.parse(raw) as { payload?: unknown };
  return (parsed.payload ?? parsed) as GetCourseDocument;
}

export function isItem(x: unknown): x is SearchResultItem {
  return !!x && typeof x === 'object' && 'id' in (x as object);
}

// Coerce a value into a list of content items, accepting either an array or —
// as Rise's `content` field actually is — an object MAP keyed by content id.
export function asItemArray(v: unknown): SearchResultItem[] {
  if (Array.isArray(v)) return v.filter(isItem);
  if (v && typeof v === 'object') return Object.values(v).filter(isItem);
  return [];
}

// Rise returns search hits under `content` as an id-keyed object map. Be
// tolerant of other shapes too (array, alternate wrapper keys).
export function extractItems(data: unknown): SearchResultItem[] {
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

export function describeShape(data: unknown): string {
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
