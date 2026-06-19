// Folder orchestration: fetch the course folder tree and build the combined
// (course + bank) folder inventory from whatever is saved on disk.

import {
  buildFolderInventory,
  extractBankFolders,
  extractCourseFolders,
  foldersToCsv,
  foldersToJson,
  type FolderNode,
} from '@/core/census/folders';
import type { Storage } from '@/core/storage/storage';
import { rpc } from '../rpc';
import type { ProgressEvent } from './shared';

/** Fetch the course folder tree (GET /manage/api/folders) and save it raw. */
export async function fetchFolders(
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
): Promise<void> {
  const resp = await rpc({ type: 'LIST_FOLDERS' });
  if (resp.type !== 'FOLDERS_RESULT' || !resp.result.ok) {
    const err =
      resp.type === 'FOLDERS_RESULT' && !resp.result.ok
        ? resp.result.error
        : 'unexpected response';
    onEvent({ kind: 'log', message: `Folders unavailable: ${err}` });
    return;
  }
  await storage.writeFolders(resp.result.data.raw);
}

/** Build the combined folder inventory from whatever is saved (course folders.json
 *  + bank index), resolving name-paths and per-folder course counts (from the
 *  saved inventory). Self-consistent regardless of which action ran. Returns the
 *  nodes (empty if no folder data yet). */
export async function buildFolders(storage: Storage): Promise<FolderNode[]> {
  const raws: ReturnType<typeof extractCourseFolders> = [];
  const foldersRaw = await storage.readFolders();
  if (foldersRaw) {
    try {
      raws.push(...extractCourseFolders(JSON.parse(foldersRaw)));
    } catch {
      /* ignore malformed */
    }
  }
  const bankIndex = await storage.readBankIndex();
  if (bankIndex) {
    try {
      raws.push(...extractBankFolders(JSON.parse(bankIndex)));
    } catch {
      /* ignore malformed */
    }
  }
  if (!raws.length) return [];

  // Course counts per folder, from the saved list-level inventory.
  const counts: Record<string, number> = {};
  const invRaw = await storage.readInventory();
  if (invRaw) {
    try {
      for (const row of JSON.parse(invRaw) as { folderId?: string }[]) {
        if (row.folderId) counts[row.folderId] = (counts[row.folderId] ?? 0) + 1;
      }
    } catch {
      /* ignore malformed */
    }
  }

  const inventory = buildFolderInventory(raws, counts);
  await storage.writeFolderInventory(
    foldersToJson(inventory),
    foldersToCsv(inventory),
  );
  return inventory;
}
