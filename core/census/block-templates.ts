// Block templates — the account's saved reusable blocks (team library), from
// ducks rise/blockTemplates/FETCH_BLOCK_TEMPLATES. Exported raw; this module
// builds a per-template inventory row (mirrors core/census/inventory.ts).

import { toCsv } from '@/core/util/csv';

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Block-template objects from the ducks response (`{type, payload:[…]}`). */
export function extractBlockTemplates(doc: unknown): Record<string, unknown>[] {
  const payload = isObj(doc) ? doc.payload : doc;
  if (Array.isArray(payload)) return payload.filter(isObj);
  if (Array.isArray(doc)) return doc.filter(isObj);
  return [];
}

export interface BlockTemplateRow {
  id: string;
  name: string;
  author: string;
  shared: boolean;
  blockCount: number;
  sourceCourseId: string;
  sourceLessonId: string;
  state: string;
  createdAt: string;
  tenantId: string;
}

const COLUMNS: (keyof BlockTemplateRow)[] = [
  'id',
  'name',
  'author',
  'shared',
  'blockCount',
  'sourceCourseId',
  'sourceLessonId',
  'state',
  'createdAt',
  'tenantId',
];

export function buildBlockTemplateInventory(
  templates: Record<string, unknown>[],
): BlockTemplateRow[] {
  return templates
    .map((t): BlockTemplateRow => {
      const profile = isObj(t.profile) ? t.profile : {};
      const author =
        [profile.first_name, profile.last_name]
          .filter((x) => typeof x === 'string')
          .join(' ')
          .trim() || str(t.author);
      return {
        id: str(t.id),
        name: str(t.name),
        author,
        shared: t.shared === true,
        blockCount: Array.isArray(t.items) ? t.items.length : 0,
        sourceCourseId: str(t.sourceCourseId),
        sourceLessonId: str(t.sourceLessonId),
        state: str(t.state),
        createdAt: str(t.createdAt),
        tenantId: str(t.tenantId),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function blockTemplatesToJson(rows: BlockTemplateRow[]): string {
  return JSON.stringify(rows, null, 2);
}

export function blockTemplatesToCsv(rows: BlockTemplateRow[]): string {
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
