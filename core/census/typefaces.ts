// Custom typefaces (account fonts), from ducks rise/typefaces/FETCH_TYPEFACES.
// Exported raw; this module builds a per-typeface inventory and collects the
// downloadable font keys (rise/fonts/{author}/…woff) for the asset pipeline.

import { toCsv } from '@/core/util/csv';

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Typeface objects from the ducks response (`{type, payload:{typefaces:[…]}}`). */
export function extractTypefaces(doc: unknown): Record<string, unknown>[] {
  const payload = isObj(doc) ? doc.payload : doc;
  const list = isObj(payload) ? payload.typefaces : payload;
  if (Array.isArray(list)) return list.filter(isObj);
  if (Array.isArray(doc)) return doc.filter(isObj);
  return [];
}

function fontsOf(t: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(t.fonts) ? t.fonts.filter(isObj) : [];
}

/** Every downloadable font key across all typefaces (deduped). */
export function collectFontKeys(doc: unknown): string[] {
  const out = new Set<string>();
  for (const t of extractTypefaces(doc)) {
    for (const f of fontsOf(t)) {
      if (typeof f.key === 'string' && f.key) out.add(f.key);
    }
  }
  return [...out];
}

export interface TypefaceRow {
  id: string;
  name: string;
  author: string;
  isDefault: boolean;
  deleted: boolean;
  fontCount: number;
  styles: string;
  createdAt: string;
}

const COLUMNS: (keyof TypefaceRow)[] = [
  'id',
  'name',
  'author',
  'isDefault',
  'deleted',
  'fontCount',
  'styles',
  'createdAt',
];

export function buildTypefaceInventory(
  typefaces: Record<string, unknown>[],
): TypefaceRow[] {
  return typefaces
    .map((t): TypefaceRow => {
      const fonts = fontsOf(t);
      const styles = [...new Set(fonts.map((f) => str(f.style)).filter(Boolean))]
        .sort()
        .join(' ');
      return {
        id: str(t.id),
        name: str(t.name),
        author: str(t.author),
        isDefault: t.default === true,
        deleted: t.deleted === true,
        fontCount: fonts.length,
        styles,
        createdAt: str(t.createdAt),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function typefacesToJson(rows: TypefaceRow[]): string {
  return JSON.stringify(rows, null, 2);
}

export function typefacesToCsv(rows: TypefaceRow[]): string {
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

// --- Shared-in (foreign-tenant) typefaces ------------------------------------
//
// The account's FETCH_TYPEFACES lists only typefaces the account OWNS. A course
// may reference a typeface shared in from another tenant (live DFO 2026-10-20:
// "Arkivverkets Fontsamling" in 3 courses — absent from the list, so the import
// could only flag it). The export resolves such ids per affected course and
// merges the results into account/typefaces.json, marked `foreign: true` so the
// import never re-hosts someone else's font without an operator opt-in.

/** Typeface ids a saved course document uses (`{course:{…}}` or ducks-wrapped)
 *  that are NOT in `known` — candidates for a per-course FETCH_TYPEFACES. */
export function unknownTypefaceIdsOf(courseDoc: unknown, known: ReadonlySet<string>): string[] {
  const root = isObj(courseDoc) ? (isObj(courseDoc.payload) ? courseDoc.payload : courseDoc) : null;
  const course = root && isObj(root.course) ? root.course : null;
  if (!course) return [];
  const theme = isObj(course.theme) ? course.theme : {};
  const out = new Set<string>();
  for (const src of [course, theme]) {
    for (const k of ['headingTypefaceId', 'bodyTypefaceId', 'uiTypefaceId']) {
      const v = src[k];
      if (typeof v === 'string' && v && !known.has(v)) out.add(v);
    }
  }
  return [...out];
}

/**
 * Merge typefaces found via per-course FETCH_TYPEFACES into the account doc:
 * every typeface not already listed (and not deleted) is appended with
 * `foreign: true, sharedVia: <courseId>`. Returns the merged raw doc (same
 * `{type, payload:{typefaces}}` shape the archive stores) + what was added.
 */
export function mergeForeignTypefaces(
  accountDoc: unknown,
  perCourse: { courseId: string; doc: unknown }[],
): { merged: unknown; added: { id: string; name: string; sharedVia: string }[] } {
  const base = isObj(accountDoc) ? accountDoc : {};
  const payload = isObj(base.payload) ? base.payload : null;
  const list = [...extractTypefaces(accountDoc)];
  const known = new Set(list.map((t) => String(t.id ?? '')));
  const added: { id: string; name: string; sharedVia: string }[] = [];
  for (const { courseId, doc } of perCourse) {
    for (const t of extractTypefaces(doc)) {
      const id = typeof t.id === 'string' ? t.id : '';
      if (!id || known.has(id) || t.deleted === true) continue;
      known.add(id);
      list.push({ ...t, foreign: true, sharedVia: courseId });
      added.push({ id, name: typeof t.name === 'string' ? t.name : '', sharedVia: courseId });
    }
  }
  const merged = payload
    ? { ...base, payload: { ...payload, typefaces: list } }
    : Array.isArray(accountDoc)
      ? list
      : { ...base, typefaces: list };
  return { merged, added };
}
