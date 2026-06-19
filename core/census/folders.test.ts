import { describe, expect, it } from 'vitest';
import {
  buildFolderInventory,
  extractBankFolders,
  extractCourseFolders,
} from './folders';

describe('extractCourseFolders', () => {
  it('reads the id-keyed folder map from /manage/api/folders', () => {
    const f = extractCourseFolders({
      f1: { id: 'f1', name: 'private', parentFolderId: null, folderType: 'private' },
      f2: { id: 'f2', name: 'Sub', parentFolderId: 'f1', deletedAt: null },
    });
    expect(f.map((x) => x.id).sort()).toEqual(['f1', 'f2']);
    expect(f.find((x) => x.id === 'f2')?.parentId).toBe('f1');
  });
});

describe('extractBankFolders', () => {
  it('reads private_folders/shared_folders from the bank index', () => {
    const f = extractBankFolders({
      private_folders: [{ id: 'b1', title: 'Banks', parent_id: null, deleted: false }],
      shared_folders: [{ id: 'b2', title: 'Team', parent_id: 'b1' }],
    });
    expect(f.map((x) => x.id)).toEqual(['b1', 'b2']);
    expect(f[0]?.source).toBe('bank');
    expect(f[0]?.name).toBe('Banks');
  });
});

describe('buildFolderInventory', () => {
  it('resolves name-paths, depth, and course counts', () => {
    const inv = buildFolderInventory(
      [
        { id: 'f1', name: 'private', parentId: null, type: 'private', source: 'course', deleted: false },
        { id: 'f2', name: 'Customer A', parentId: 'f1', type: 'team', source: 'course', deleted: false },
      ],
      { f2: 7 },
    );
    const leaf = inv.find((f) => f.id === 'f2');
    expect(leaf?.path).toBe('private / Customer A');
    expect(leaf?.depth).toBe(1);
    expect(leaf?.courseCount).toBe(7);
  });

  it('does not loop on a cyclic parent reference', () => {
    const inv = buildFolderInventory([
      { id: 'a', name: 'A', parentId: 'b', type: 't', source: 'course', deleted: false },
      { id: 'b', name: 'B', parentId: 'a', type: 't', source: 'course', deleted: false },
    ]);
    expect(inv).toHaveLength(2);
  });
});
