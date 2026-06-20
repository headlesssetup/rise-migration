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
