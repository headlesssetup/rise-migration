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

// --- Route B: font files from the editor's @font-face rules ------------------
//
// When even the per-course FETCH_TYPEFACES does not list a shared-in typeface
// (mig30oct 2026-10-30: "DB Head", "DB Sans", "DBNeoScreenSans"), the export
// reads the course editor's `rise-tf-<id>` @font-face rules (background
// course-fonts.ts) and rebuilds the typeface record from them. The NAME comes
// from the course document's own `course.typefaces` {id: name} map.

/** The typeface ids a saved course actually DISPLAYS: its top-level
 *  heading/body/ui slots (theme copies only when the course has none). A
 *  theme-only id beside them is a stale leftover — never worth a scrape. */
export function displayedTypefaceIdsOf(courseDoc: unknown): Set<string> {
  const root = isObj(courseDoc) ? (isObj(courseDoc.payload) ? courseDoc.payload : courseDoc) : null;
  const course = root && isObj(root.course) ? root.course : null;
  if (!course) return new Set();
  const pick = (src: Record<string, unknown>): string[] =>
    ['headingTypefaceId', 'bodyTypefaceId', 'uiTypefaceId']
      .map((k) => src[k])
      .filter((v): v is string => typeof v === 'string' && v !== '');
  const top = pick(course);
  return new Set(top.length ? top : pick(isObj(course.theme) ? course.theme : {}));
}

/** `course.typefaces` of a saved course doc (`{course}` or ducks-wrapped). */
export function courseTypefaceNameMap(courseDoc: unknown): Map<string, string> {
  const root = isObj(courseDoc) ? (isObj(courseDoc.payload) ? courseDoc.payload : courseDoc) : null;
  const course = root && isObj(root.course) ? root.course : null;
  const out = new Map<string, string>();
  const t = course && isObj(course.typefaces) ? course.typefaces : null;
  if (t) for (const [id, name] of Object.entries(t)) if (typeof name === 'string' && name) out.set(id, name);
  return out;
}

/** Rise's own slot ↔ @font-face table, read off the editor CSS (mig30oct
 *  2026-10-30 paste: built-ins emit light 300, regular 400, italic 400 italic,
 *  bold 700, black 900 — e.g. Raleway's five). Exact, never inferred: a face
 *  outside the table is rejected and reported, not squeezed into a slot. */
const SLOT_BY_FACE: Record<string, string> = {
  '300|normal': 'light',
  '400|normal': 'regular',
  '400|italic': 'italic',
  '700|normal': 'bold',
  '900|normal': 'black',
};
/** Custom (uploaded) typefaces have only these — the Add New Font form offers
 *  Regular (required), Bold, Italic. Light/black are built-in-only. */
const CUSTOM_SLOTS = new Set(['regular', 'bold', 'italic']);

function faceKey(weight: string, style: string): string {
  const w = weight.trim().toLowerCase();
  const st = style.trim().toLowerCase();
  return `${w === 'normal' ? '400' : w === 'bold' ? '700' : w}|${st || 'normal'}`;
}

/** A scraped face that could not be archived, with the reason — the caller
 *  reports every one (never a silent drop). */
export interface RejectedFontFace {
  typefaceId: string;
  name?: string;
  weight: string;
  style: string;
  url: string;
  reason: string;
}

/** Rebuild typeface records from scraped @font-face rows. Only files under the
 *  account font store (`rise/fonts/…` on articulateusercontent) count — Rise's
 *  built-ins live on the CDN and are never recreated (not rejections). Each
 *  account-font face maps to its slot by Rise's exact table; anything else is
 *  returned in `rejected`. */
export function typefacesFromFontFaces(
  faces: { typefaceId: string; weight: string; style: string; url: string }[],
  names: Map<string, string>,
): { typefaces: Record<string, unknown>[]; rejected: RejectedFontFace[] } {
  const byId = new Map<string, { key: string; style: string; original: string }[]>();
  const rejected: RejectedFontFace[] = [];
  for (const f of faces) {
    let key: string;
    try {
      const u = new URL(f.url);
      if (!/articulateusercontent\.(com|eu)$/.test(u.hostname)) continue;
      key = decodeURIComponent(u.pathname.replace(/^\//, ''));
    } catch {
      continue;
    }
    if (!key.startsWith('rise/fonts/')) continue;
    const reject = (reason: string): void => {
      rejected.push({ ...f, name: names.get(f.typefaceId), reason });
    };
    const slot = SLOT_BY_FACE[faceKey(f.weight, f.style)];
    if (!slot) {
      reject(`weight ${f.weight} / style ${f.style} is not one of Rise's typeface slots`);
      continue;
    }
    if (!CUSTOM_SLOTS.has(slot)) {
      reject(`"${slot}" is a built-in-only slot — a custom typeface has only regular, bold, italic`);
      continue;
    }
    const list = byId.get(f.typefaceId) ?? [];
    const same = list.find((x) => x.style === slot);
    if (same) {
      if (same.key !== key) reject(`second file for the "${slot}" slot (kept ${same.key})`);
      continue;
    }
    list.push({ key, style: slot, original: (key.split('/').pop() ?? '').replace(/^[A-Za-z0-9_-]{16}-/, '') });
    byId.set(f.typefaceId, list);
  }
  const typefaces: Record<string, unknown>[] = [];
  for (const [id, fonts] of byId) {
    const name = names.get(id);
    if (!name) {
      for (const font of fonts) {
        rejected.push({
          typefaceId: id,
          weight: '',
          style: font.style,
          url: font.key,
          reason: 'the course document gives this typeface no name — it cannot be matched or recreated',
        });
      }
      continue;
    }
    if (!fonts.some((x) => x.style === 'regular')) {
      rejected.push({
        typefaceId: id,
        name,
        weight: '400',
        style: 'normal',
        url: '',
        reason: 'no regular face found — Rise requires one, so the typeface is not archived',
      });
      continue;
    }
    typefaces.push({ id, name, default: false, deleted: false, recoveredFrom: 'font-face', fonts });
  }
  return { typefaces, rejected };
}
