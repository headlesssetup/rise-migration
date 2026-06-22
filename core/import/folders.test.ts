import { describe, it, expect } from 'vitest';
import {
  parseFolders,
  rootIdsByType,
  orderForCreation,
  ownerPermissions,
} from './folders';

// id-keyed map shape (the documented GET /manage/api/folders response)
const DOC = {
  rootS: { id: 'rootS', name: 'Shared', isRoot: true, folderType: 'shared', parentFolderId: null },
  rootP: { id: 'rootP', name: 'Private', isRoot: true, folderType: 'private', parentFolderId: null },
  a: { id: 'a', name: 'A', folderType: 'shared', parentFolderId: 'rootS' },
  b: { id: 'b', name: 'B', folderType: 'shared', parentFolderId: 'a' },
  c: { id: 'c', name: 'C', folderType: 'shared', parentFolderId: 'b' },
  p: { id: 'p', name: 'P', folderType: 'private', parentFolderId: 'rootP' },
  gone: { id: 'gone', name: 'Old', folderType: 'shared', parentFolderId: 'rootS', deletedAt: '2026-01-01' },
};

describe('parseFolders', () => {
  it('parses an id-map and flags deleted/root', () => {
    const m = parseFolders(DOC);
    expect(m.get('a')!.parentFolderId).toBe('rootS');
    expect(m.get('rootS')!.isRoot).toBe(true);
    expect(m.get('gone')!.deleted).toBe(true);
  });
  it('also accepts an array', () => {
    expect(parseFolders([{ id: 'x', name: 'X' }]).get('x')!.name).toBe('X');
  });
});

describe('rootIdsByType', () => {
  it('finds the shared + private roots', () => {
    expect(rootIdsByType(parseFolders(DOC))).toEqual({ shared: 'rootS', private: 'rootP' });
  });
});

describe('orderForCreation', () => {
  it('orders parents before children and drops roots + deleted', () => {
    const ordered = orderForCreation(parseFolders(DOC)).map((f) => f.id);
    expect(ordered).not.toContain('rootS');
    expect(ordered).not.toContain('gone');
    // a (depth0) before b (depth1) before c (depth2)
    expect(ordered.indexOf('a')).toBeLessThan(ordered.indexOf('b'));
    expect(ordered.indexOf('b')).toBeLessThan(ordered.indexOf('c'));
    expect(ordered).toContain('p');
  });
});

describe('ownerPermissions', () => {
  it('uses the account-local userId as the owner principal (NOT the token sub)', () => {
    const [p] = ownerPermissions({ userId: 'auth0|local', sub: 'auth0|okta' }) as Array<Record<string, unknown>>;
    expect(p).toBeDefined();
    expect(p!.principalId).toBe('auth0|local');
    expect(p!.roleId).toBe(3);
    expect((p!.profile as { user_id: string }).user_id).toBe('auth0|local');
  });
  it('falls back to sub when no account-local userId is known', () => {
    const [p] = ownerPermissions({ sub: 'auth0|okta' }) as Array<Record<string, unknown>>;
    expect(p!.principalId).toBe('auth0|okta');
  });
  it('is empty when no principal can be sourced (skip the owner write)', () => {
    expect(ownerPermissions({})).toEqual([]);
  });
});
