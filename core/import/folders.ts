// Phase 4 — folder recreation (pure logic).
//
// The export captures the account folder tree (account/folders.json,
// GET /manage/api/folders). To rebuild it on the target we create folders
// PARENT-FIRST (a child's create needs its parent's new id), mapping old→new,
// then move each imported course into its mapped folder. Two roots exist (a
// `shared` root and a `private` root, both isRoot); a top-level folder hangs off
// the matching target root. See docs/rise-import-protocol.md §10b.

export interface SourceFolder {
  id: string;
  name: string;
  parentFolderId: string | null;
  isRoot: boolean;
  folderType: string; // 'shared' | 'private' | …
  deleted: boolean;
}

function asEntries(doc: unknown): unknown[] {
  if (Array.isArray(doc)) return doc;
  if (doc && typeof doc === 'object') {
    const o = doc as Record<string, unknown>;
    if (Array.isArray(o.folders)) return o.folders;
    // id-keyed object map (the documented GET /manage/api/folders shape)
    return Object.values(o);
  }
  return [];
}

/** Parse a `GET /manage/api/folders` doc (id-map, array, or `{folders}`) into
 *  folders keyed by id. */
export function parseFolders(doc: unknown): Map<string, SourceFolder> {
  const out = new Map<string, SourceFolder>();
  for (const raw of asEntries(doc)) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as Record<string, unknown>;
    const id = typeof f.id === 'string' ? f.id : '';
    if (!id) continue;
    out.set(id, {
      id,
      name: typeof f.name === 'string' ? f.name : id,
      parentFolderId: typeof f.parentFolderId === 'string' ? f.parentFolderId : null,
      isRoot: f.isRoot === true,
      folderType: typeof f.folderType === 'string' ? f.folderType : 'shared',
      deleted: f.deletedAt != null || f.deleted === true,
    });
  }
  return out;
}

/** The two root folder ids by type (shared / private). */
export function rootIdsByType(folders: Map<string, SourceFolder>): {
  shared?: string;
  private?: string;
} {
  const roots: { shared?: string; private?: string } = {};
  for (const f of folders.values()) {
    if (!f.isRoot) continue;
    if (f.folderType === 'private') roots.private ??= f.id;
    else roots.shared ??= f.id;
  }
  return roots;
}

/** Non-root, non-deleted folders ordered PARENT-FIRST (so each create can
 *  resolve its parent's new id). Depth = chain length to a root/absent parent. */
export function orderForCreation(folders: Map<string, SourceFolder>): SourceFolder[] {
  const depth = (f: SourceFolder, seen = new Set<string>()): number => {
    let d = 0;
    let cur: SourceFolder | undefined = f;
    while (cur && cur.parentFolderId && !seen.has(cur.id)) {
      seen.add(cur.id);
      const parent = folders.get(cur.parentFolderId);
      if (!parent || parent.isRoot) break;
      d += 1;
      cur = parent;
    }
    return d;
  };
  return [...folders.values()]
    .filter((f) => !f.isRoot && !f.deleted)
    .sort((a, b) => depth(a) - depth(b));
}

/** Owner `permissions` for a folder — the importing admin as owner (`roleId:3`).
 *  The principal MUST be the account-local Rise user id (`_articulate_user_id`);
 *  the token `sub` is rejected "Invalid users" on a cross-plane session, and a
 *  folder created with NO owner breaks the dashboard's folder-content query
 *  (500). Returns [] if we can't source a principal (then skip the owner write).
 *  Sharing with OTHER team members stays a manual post-migration step. */
export function ownerPermissions(identity: {
  userId?: string | null;
  sub?: string | null;
}): unknown[] {
  const principalId = identity.userId ?? identity.sub;
  if (!principalId) return [];
  return [
    {
      principalId,
      principalType: 0,
      roleId: 3,
      profile: { user_id: principalId },
    },
  ];
}
