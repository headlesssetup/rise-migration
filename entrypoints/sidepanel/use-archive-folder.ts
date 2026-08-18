// Archive-folder handle lifecycle (pick / restore / reconnect / forget) —
// split out of App.tsx (v0.9.0 restructure). Called by App so a connected
// folder survives view navigation.
import { useCallback, useEffect, useState } from 'react';
import { FileSystemStorage } from '@/core/storage/fs';
import type { Storage } from '@/core/storage/storage';
import {
  clearDirHandle,
  loadDirHandle,
  saveDirHandle,
  verifyPermission,
} from './folder-store';

type DirPicker = (opts?: {
  mode?: 'read' | 'readwrite';
}) => Promise<FileSystemDirectoryHandle>;

export function useArchiveFolder(addLog: (message: string) => void) {
  const [storage, setStorage] = useState<Storage | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [pendingHandle, setPendingHandle] =
    useState<FileSystemDirectoryHandle | null>(null);

  // Restore the persisted destination folder on first load.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const handle = await loadDirHandle();
      if (!handle || !alive) return;
      setFolderName(handle.name);
      if (await verifyPermission(handle, false)) {
        setStorage(new FileSystemStorage(handle));
        addLog(`Folder restored: ${handle.name}`);
      } else {
        setPendingHandle(handle); // needs a click to re-grant access
      }
    })();
    return () => {
      alive = false;
    };
  }, [addLog]);

  const useFolder = useCallback((handle: FileSystemDirectoryHandle) => {
    setStorage(new FileSystemStorage(handle));
    setFolderName(handle.name);
    setPendingHandle(null);
  }, []);

  const pickFolder = useCallback(async () => {
    const picker = (window as unknown as { showDirectoryPicker?: DirPicker })
      .showDirectoryPicker;
    if (!picker) {
      addLog('File System Access API unavailable in this browser.');
      return;
    }
    try {
      const handle = await picker({ mode: 'readwrite' });
      await saveDirHandle(handle);
      useFolder(handle);
      addLog(`Folder selected: ${handle.name}`);
    } catch {
      /* user cancelled */
    }
  }, [addLog, useFolder]);

  const reconnectFolder = useCallback(async () => {
    if (!pendingHandle) return;
    if (await verifyPermission(pendingHandle, true)) {
      useFolder(pendingHandle);
      addLog(`Folder reconnected: ${pendingHandle.name}`);
    } else {
      addLog('Folder access was not granted.');
    }
  }, [pendingHandle, addLog, useFolder]);

  const forgetFolder = useCallback(async () => {
    await clearDirHandle();
    setStorage(null);
    setFolderName(null);
    setPendingHandle(null);
    addLog('Folder forgotten.');
  }, [addLog]);

  return {
    storage,
    folderName,
    pendingHandle,
    pickFolder,
    reconnectFolder,
    forgetFolder,
  };
}
