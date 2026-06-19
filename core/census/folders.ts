// Folder structure (API: GET /manage/api/folders for courses; private_folders /
// shared_folders in the question-banks index for banks). Rise organizes content
// in folders; migration must preserve the tree, so we enumerate folders, resolve
// each one's name-path via its parent, and tag the source. Import (Phase 3) then
// recreates folders, maps old→new ids, and places content/banks into them.

import { toCsv } from '@/core/util/csv';

export interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  /** folderType (course folders) or bank-private/bank-shared. */
  type: string;
  source: 'course' | 'bank';
  deleted: boolean;
  /** Resolved name path, e.g. "private / Customer A / 2024". */
  path: string;
  depth: number;
  /** Courses in this folder (course folders only), from the listing. */
  courseCount?: number;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
function asObjArray(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter(isObj);
  if (isObj(v)) return Object.values(v).filter(isObj);
  return [];
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

interface RawFolder {
  id: string;
  name: string;
  parentId: string | null;
  type: string;
  source: 'course' | 'bank';
  deleted: boolean;
}

/** Course folders from GET /manage/api/folders (array, id-map, or {folders}). */
export function extractCourseFolders(doc: unknown): RawFolder[] {
  let arr: Record<string, unknown>[] = [];
  if (isObj(doc)) {
    for (const k of ['folders', 'content', 'data', 'items']) {
      const got = asObjArray(doc[k]);
      if (got.length) {
        arr = got;
        break;
      }
    }
  }
  if (!arr.length) arr = asObjArray(doc);
  return arr
    .filter((o) => typeof o.id === 'string')
    .map((o) => ({
      id: o.id as string,
      name: str(o.name) || str(o.title) || (o.id as string),
      parentId: str(o.parentFolderId) || null,
      type: str(o.folderType) || 'folder',
      source: 'course' as const,
      deleted: o.deletedAt != null || o.deleted === true,
    }));
}

/** Bank folders from the question-banks index (private_folders + shared_folders). */
export function extractBankFolders(indexDoc: unknown): RawFolder[] {
  if (!isObj(indexDoc)) return [];
  const out: RawFolder[] = [];
  const take = (v: unknown, type: string) => {
    for (const o of asObjArray(v)) {
      if (typeof o.id !== 'string') continue;
      out.push({
        id: o.id,
        name: str(o.title) || str(o.name) || o.id,
        parentId: str(o.parent_id) || null,
        type,
        source: 'bank',
        deleted: o.deleted === true,
      });
    }
  };
  take(indexDoc.private_folders, 'bank-private');
  take(indexDoc.shared_folders, 'bank-shared');
  return out;
}

/** Combine course + bank folders, resolve name-paths, attach course counts. */
export function buildFolderInventory(
  raw: RawFolder[],
  courseCountsByFolderId: Record<string, number> = {},
): FolderNode[] {
  const byId = new Map(raw.map((f) => [f.id, f]));

  const pathOf = (f: RawFolder): { path: string; depth: number } => {
    const names: string[] = [];
    let cur: RawFolder | undefined = f;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      names.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return { path: names.join(' / '), depth: names.length - 1 };
  };

  return raw
    .map((f) => {
      const { path, depth } = pathOf(f);
      return {
        ...f,
        path,
        depth,
        courseCount: f.source === 'course' ? courseCountsByFolderId[f.id] ?? 0 : undefined,
      };
    })
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) || a.path.localeCompare(b.path),
    );
}

export function foldersToJson(folders: FolderNode[]): string {
  return JSON.stringify(folders, null, 2);
}

export function foldersToCsv(folders: FolderNode[]): string {
  const headers = ['id', 'name', 'source', 'type', 'parentId', 'depth', 'path', 'deleted', 'courseCount'];
  const rows = folders.map((f) => [
    f.id,
    f.name,
    f.source,
    f.type,
    f.parentId ?? '',
    f.depth,
    f.path,
    f.deleted ? 'yes' : 'no',
    f.courseCount ?? '',
  ]);
  return toCsv(headers, rows);
}
