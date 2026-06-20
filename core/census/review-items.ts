// Review 360 items (productFilter=storyline) — the Storyline/Mighty embeds an
// account can reach. Exported raw; this module builds an inventory that flags
// Mighty bundles and whether each item has a downloadable package. Mighty is
// treated as Storyline: reference only (we do not grab bundle bytes yet).

import { toCsv } from '@/core/util/csv';

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Review-item objects from the response (tolerant: array / {items|data|stack}). */
export function extractReviewItems(doc: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const looksItem = (o: Record<string, unknown>): boolean =>
    'id' in o && ('source' in o || 'package' in o || 'product' in o);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const c of node) walk(c);
    } else if (isObj(node)) {
      if (looksItem(node) && !seen.has(node)) {
        seen.add(node);
        out.push(node);
        return; // don't descend into an item's own sub-objects
      }
      for (const v of Object.values(node)) walk(v);
    }
  };
  walk(doc);
  return out;
}

export interface ReviewItemRow {
  id: string;
  title: string;
  product: string;
  projectId: string;
  sourceCourseId: string;
  mighty: boolean;
  slideCount: number;
  packageKey: string;
  hasDownloadablePackage: boolean;
}

const COLUMNS: (keyof ReviewItemRow)[] = [
  'id',
  'title',
  'product',
  'projectId',
  'sourceCourseId',
  'mighty',
  'slideCount',
  'packageKey',
  'hasDownloadablePackage',
];

export function buildReviewItemsInventory(
  items: Record<string, unknown>[],
): ReviewItemRow[] {
  return items
    .map((it): ReviewItemRow => {
      const source = isObj(it.source) ? it.source : {};
      const pkg = isObj(it.package) ? it.package : {};
      const packageKey = str(pkg.key);
      return {
        id: str(it.id),
        title: str(it.title || source.title),
        product: str(it.product),
        projectId: str(it.project_id ?? it.projectId),
        sourceCourseId: str(source.course_id ?? source.courseId),
        mighty: source.mighty_bundle === true,
        slideCount: Array.isArray(source.slides) ? source.slides.length : 0,
        packageKey,
        hasDownloadablePackage: packageKey !== '',
      };
    })
    .sort(
      (a, b) =>
        Number(b.mighty) - Number(a.mighty) || a.title.localeCompare(b.title),
    );
}

export function reviewItemsToJson(rows: ReviewItemRow[]): string {
  return JSON.stringify(rows, null, 2);
}

export function reviewItemsToCsv(rows: ReviewItemRow[]): string {
  return toCsv(
    COLUMNS as string[],
    rows.map((r) =>
      COLUMNS.map((c) => {
        const v = r[c];
        return typeof v === 'boolean' ? (v ? 'yes' : 'no') : (v ?? '');
      }),
    ),
  );
}
