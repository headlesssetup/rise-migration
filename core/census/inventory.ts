// List-level inventory, built straight from the search listing (no GET_COURSE).
// This is the customer-facing high-level catalog: every course with the details
// the listing already exposes — produced as soon as courses are listed.

import { toCsv } from '@/core/util/csv';
import { formatLocales, listingLocales } from '@/core/l10n/stack';
import type { SearchResultItem } from '@/shared/types/rise';

export interface InventoryRow {
  id: string;
  title: string;
  type: string;
  lessonCount: number | '';
  /** Multi-language stack: locale codes, default first ("en-us | ar | bs").
   *  Blank for monolingual courses. Straight from the search listing. */
  multi_language: string;
  owner: string;
  ownerEmail: string;
  folderId: string;
  /** Resolved folder name-path ("private / Customer A / 2024") — the operator's
   *  "location". Blank when no folder tree is available yet, or when the id is
   *  absent from it: the raw `folderId` is always kept, so a later re-list (or
   *  {@link withFolderPaths}) can fill this in without re-fetching courses. */
  folderPath: string;
  shareId: string;
  createdAt: string;
  updatedAt: string;
  ready: string;
  deleted: string;
}

const INVENTORY_COLUMNS: (keyof InventoryRow)[] = [
  'id',
  'title',
  'type',
  'lessonCount',
  'multi_language',
  'owner',
  'ownerEmail',
  'folderId',
  'folderPath',
  'shareId',
  'createdAt',
  'updatedAt',
  'ready',
  'deleted',
];

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

export function buildInventory(
  items: SearchResultItem[],
  pathByFolderId: Map<string, string> = new Map(),
): InventoryRow[] {
  return items.map((it) => {
    const profile = (it.profile ?? {}) as Record<string, unknown>;
    const owner = `${str(profile.first_name)} ${str(profile.last_name)}`.trim();
    return {
      id: str(it.id),
      title: str(it.title),
      // Courses come back with type:null in the listing — label them COURSE.
      type: str(it.type) || 'COURSE',
      lessonCount: typeof it.lessonCount === 'number' ? it.lessonCount : '',
      multi_language: formatLocales(listingLocales(it)),
      owner,
      ownerEmail: str(profile.email),
      folderId: str(it.folderId),
      folderPath: pathByFolderId.get(str(it.folderId)) ?? '',
      shareId: str(it.shareId),
      createdAt: str(it.createdAt),
      updatedAt: str(it.updatedAt),
      ready: str(it.ready),
      deleted: str(it.deleted),
    };
  });
}

/**
 * Fill `folderPath` on rows that don't have one yet (or whose folder has since
 * been renamed/moved). Applied to the MERGED set before writing, so rows carried
 * over from an earlier listing — which may predate any folder export — gain a
 * location without re-listing those courses. A row whose folder id isn't in the
 * tree keeps whatever path it had.
 */
export function withFolderPaths(
  rows: InventoryRow[],
  pathByFolderId: Map<string, string>,
): InventoryRow[] {
  if (!pathByFolderId.size) return rows;
  return rows.map((r) => {
    const path = r.folderId ? pathByFolderId.get(r.folderId) : undefined;
    return path && path !== r.folderPath ? { ...r, folderPath: path } : r;
  });
}

export function inventoryToJson(rows: InventoryRow[]): string {
  return JSON.stringify(rows, null, 2);
}

export function inventoryToCsv(rows: InventoryRow[]): string {
  return toCsv(
    INVENTORY_COLUMNS as string[],
    rows.map((r) => INVENTORY_COLUMNS.map((c) => r[c] ?? '')),
  );
}
