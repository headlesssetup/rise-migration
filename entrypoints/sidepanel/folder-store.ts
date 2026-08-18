// Persist the destination FileSystemDirectoryHandle across sessions via
// IndexedDB so the operator doesn't re-pick the folder every time. Browser
// security still requires a one-click permission re-grant after a browser
// restart — handled by verifyPermission(request:true) on a user gesture.

const DB_NAME = 'rise-explorer';
const STORE = 'handles';
const KEY = 'destFolder';

/**
 * The Creator/Review pages keep their OWN folder handle under this key.
 * They used to share `destFolder` with the side panel, so picking a Creator
 * staging folder on the Creator page silently re-pointed the panel's archive —
 * an active trap now that the Creator writer refuses rise-export folders and
 * steers operators toward a dedicated Creator folder (v0.9.0).
 */
export const CREATOR_FOLDER_KEY = 'creatorFolder';

type DirHandleWithPermissions = FileSystemDirectoryHandle & {
  queryPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function saveDirHandle(
  handle: FileSystemDirectoryHandle,
  key: string = KEY,
): Promise<void> {
  await tx('readwrite', (s) => s.put(handle, key));
}

export async function loadDirHandle(
  key: string = KEY,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await tx<FileSystemDirectoryHandle | undefined>('readonly', (s) =>
      s.get(key),
    )) ?? null;
  } catch {
    return null;
  }
}

export async function clearDirHandle(key: string = KEY): Promise<void> {
  await tx('readwrite', (s) => s.delete(key));
}

/**
 * Check readwrite permission on a restored handle. With `request:true` (must be
 * called from a user gesture) it prompts for re-grant; otherwise it only
 * queries. Returns true when access is granted.
 */
export async function verifyPermission(
  handle: FileSystemDirectoryHandle,
  request = false,
): Promise<boolean> {
  const h = handle as DirHandleWithPermissions;
  const opts = { mode: 'readwrite' as const };
  if ((await h.queryPermission?.(opts)) === 'granted') return true;
  if (request && (await h.requestPermission?.(opts)) === 'granted') return true;
  return false;
}
