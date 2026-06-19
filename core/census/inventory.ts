// List-level inventory, built straight from the search listing (no GET_COURSE).
// This is the customer-facing high-level catalog: every course with the details
// the listing already exposes — produced as soon as courses are listed.

import { toCsv } from '@/core/util/csv';
import type { SearchResultItem } from '@/shared/types/rise';

export interface InventoryRow {
  id: string;
  title: string;
  type: string;
  lessonCount: number | '';
  owner: string;
  ownerEmail: string;
  folderId: string;
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
  'owner',
  'ownerEmail',
  'folderId',
  'shareId',
  'createdAt',
  'updatedAt',
  'ready',
  'deleted',
];

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

export function buildInventory(items: SearchResultItem[]): InventoryRow[] {
  return items.map((it) => {
    const profile = (it.profile ?? {}) as Record<string, unknown>;
    const owner = `${str(profile.first_name)} ${str(profile.last_name)}`.trim();
    return {
      id: str(it.id),
      title: str(it.title),
      // Courses come back with type:null in the listing — label them COURSE.
      type: str(it.type) || 'COURSE',
      lessonCount: typeof it.lessonCount === 'number' ? it.lessonCount : '',
      owner,
      ownerEmail: str(profile.email),
      folderId: str(it.folderId),
      shareId: str(it.shareId),
      createdAt: str(it.createdAt),
      updatedAt: str(it.updatedAt),
      ready: str(it.ready),
      deleted: str(it.deleted),
    };
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
