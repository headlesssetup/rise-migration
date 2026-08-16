import { describe, expect, it } from 'vitest';
import {
  buildInventory,
  inventoryToCsv,
  inventoryToJson,
  withImportability,
  withFolderPaths,
  type InventoryRow,
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
      'id,title,type,lessonCount,multi_language,owner,ownerEmail,folderId,folderPath,shareId,createdAt,updatedAt,ready,deleted,importability',
    );
    expect(csv).toContain('"Course, with comma"');
  });

  it('adds general importability comments while leaving unscanned rows alone', () => {
    const two = [...rows, { ...rows[0]!, id: 'other' }];
    const updated = withImportability(two, new Map([['abc', 'Legacy Storyline']]));
    expect(updated[0]!.importability).toBe('Legacy Storyline');
    expect(updated[1]!.importability).toBeUndefined();
    expect(inventoryToCsv(updated)).toContain('Legacy Storyline');
  });

  describe('multi_language column', () => {
    it('lists a stack\'s locales, default first; blank for monolingual', () => {
      const stack: SearchResultItem = {
        id: 'stk',
        title: 'Stack',
        defaultLocaleId: 'row-de',
        locales: [
          { id: 'row-ar', locale: 'ar' },
          { id: 'row-de', locale: 'de' },
        ],
      };
      const [stackRow, plainRow] = buildInventory([stack, items[0]!]);
      expect(stackRow!.multi_language).toBe('de | ar');
      expect(plainRow!.multi_language).toBe('');
    });

    it('CSV serializes rows merged from pre-0.6.0 inventories (field absent)', () => {
      const legacy = buildInventory(items).map((r) => {
        const { multi_language: _drop, ...rest } = r;
        return rest as InventoryRow;
      });
      const csv = inventoryToCsv(legacy);
      expect(csv.split('\n')[1]).toContain('abc');
    });
  });

  describe('folderPath (the operator-facing "location")', () => {
    const paths = new Map([['f1', 'private / Customer A / 2024']]);
    const pathOf = (rs: InventoryRow[]): string | undefined => rs[0]?.folderPath;

    it('resolves the folder id to a name-path', () => {
      expect(buildInventory(items, paths)[0]).toMatchObject({
        folderId: 'f1',
        folderPath: 'private / Customer A / 2024',
      });
    });

    it('leaves the path blank (keeping the raw id) when the tree is unknown', () => {
      expect(buildInventory(items)[0]).toMatchObject({ folderId: 'f1', folderPath: '' });
    });

    it('quotes a path containing the CSV separator', () => {
      const csv = inventoryToCsv(buildInventory(items, new Map([['f1', 'a, b / c']])));
      expect(csv).toContain('"a, b / c"');
    });

    it('backfills rows carried over from an earlier listing', () => {
      const stale = buildInventory(items); // written before any folder export
      expect(pathOf(withFolderPaths(stale, paths))).toBe('private / Customer A / 2024');
    });

    it('refreshes a path that changed (folder renamed or moved)', () => {
      const before = buildInventory(items, new Map([['f1', 'private / Old']]));
      expect(pathOf(withFolderPaths(before, paths))).toBe('private / Customer A / 2024');
    });

    it('keeps existing rows untouched when there is no tree to resolve against', () => {
      const before = buildInventory(items, paths);
      expect(withFolderPaths(before, new Map())).toBe(before);
    });

    it('leaves a row whose folder is absent from the tree alone', () => {
      const before = buildInventory(items, paths);
      expect(pathOf(withFolderPaths(before, new Map([['other', 'x']])))).toBe(
        'private / Customer A / 2024',
      );
    });
  });
});
