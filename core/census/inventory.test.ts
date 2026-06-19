import { describe, expect, it } from 'vitest';
import {
  buildInventory,
  inventoryToCsv,
  inventoryToJson,
} from './inventory';
import type { SearchResultItem } from '@/shared/types/rise';

const items: SearchResultItem[] = [
  {
    id: 'abc',
    title: 'Course, with comma',
    type: null as unknown as string, // courses come back with type:null
    lessonCount: 4,
    folderId: 'f1',
    shareId: 's1',
    createdAt: '2026-01-01',
    updatedAt: '2026-06-01',
    ready: true,
    deleted: false,
    profile: { email: 'office@intea.lv', first_name: 'INTEA', last_name: 'Team' },
  } as SearchResultItem,
];

describe('inventory', () => {
  const rows = buildInventory(items);

  it('derives owner name + labels null type as COURSE', () => {
    expect(rows[0]).toMatchObject({
      id: 'abc',
      type: 'COURSE',
      lessonCount: 4,
      owner: 'INTEA Team',
      ownerEmail: 'office@intea.lv',
    });
  });

  it('JSON round-trips', () => {
    expect(JSON.parse(inventoryToJson(rows))[0].id).toBe('abc');
  });

  it('CSV has a header and quotes values with commas', () => {
    const csv = inventoryToCsv(rows);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(
      'id,title,type,lessonCount,owner,ownerEmail,folderId,shareId,createdAt,updatedAt,ready,deleted',
    );
    expect(csv).toContain('"Course, with comma"');
  });
});
