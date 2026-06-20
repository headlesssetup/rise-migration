// FileSystemStorage — writes into a user-picked folder via the File System
// Access API. Layout per course folder:
//   <root>/courses/<courseId>.json          raw GET_COURSE body (never mutated)
//   <root>/courses/<courseId>.assets.json   per-course asset manifest (Phase 2)
//   <root>/assets/<sha256>.<ext>            content-addressed media bytes (dedup)
//   <root>/assets-summary.json              run-wide asset totals + assertion
//   <root>/census.json                      full census
//   <root>/census.csv                       flat census
//   <root>/manifest.json                    run index
//
// Note: File System Access handles only work in a window context (the side
// panel), never in the service worker — so this lives panel-side.

import type { Storage } from './storage';

const COURSES_DIR = 'courses';
const BANKS_DIR = 'question-banks';
const ASSETS_DIR = 'assets';

export class FileSystemStorage implements Storage {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  private async coursesDir(): Promise<FileSystemDirectoryHandle> {
    return this.root.getDirectoryHandle(COURSES_DIR, { create: true });
  }

  private async writeFile(
    dir: FileSystemDirectoryHandle,
    name: string,
    contents: string | BufferSource | Blob,
  ): Promise<void> {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();
  }

  async writeCourse(courseId: string, raw: string): Promise<void> {
    const dir = await this.coursesDir();
    await this.writeFile(dir, `${courseId}.json`, raw);
  }

  async readCourse(courseId: string): Promise<string | null> {
    try {
      const dir = await this.coursesDir();
      const handle = await dir.getFileHandle(`${courseId}.json`);
      const file = await handle.getFile();
      return await file.text();
    } catch {
      return null;
    }
  }

  async hasCourse(courseId: string): Promise<boolean> {
    try {
      const dir = await this.coursesDir();
      await dir.getFileHandle(`${courseId}.json`);
      return true;
    } catch {
      return false;
    }
  }

  async listSaved(): Promise<string[]> {
    const dir = await this.coursesDir();
    const ids: string[] = [];
    const entries = (
      dir as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries();
    for await (const [name, handle] of entries) {
      if (
        handle.kind === 'file' &&
        name.endsWith('.json') &&
        !name.endsWith('.assets.json')
      ) {
        ids.push(name.replace(/\.json$/, ''));
      }
    }
    return ids;
  }

  async writeManifest(manifest: unknown): Promise<void> {
    await this.writeFile(
      this.root,
      'manifest.json',
      JSON.stringify(manifest, null, 2),
    );
  }

  async writeInventory(json: string, csv: string): Promise<void> {
    await this.writeFile(this.root, 'inventory.json', json);
    await this.writeFile(this.root, 'inventory.csv', csv);
  }

  async readInventory(): Promise<string | null> {
    try {
      const handle = await this.root.getFileHandle('inventory.json');
      return await (await handle.getFile()).text();
    } catch {
      return null;
    }
  }

  async writeCensus(json: string, csv: string): Promise<void> {
    await this.writeFile(this.root, 'census.json', json);
    await this.writeFile(this.root, 'census.csv', csv);
  }

  async writeCatalog(json: string, csv: string): Promise<void> {
    await this.writeFile(this.root, 'catalog.json', json);
    await this.writeFile(this.root, 'catalog.csv', csv);
  }

  async writeNovelty(json: string, csv: string): Promise<void> {
    await this.writeFile(this.root, 'novelty.json', json);
    await this.writeFile(this.root, 'novelty.csv', csv);
  }

  private async banksDir(): Promise<FileSystemDirectoryHandle> {
    return this.root.getDirectoryHandle(BANKS_DIR, { create: true });
  }

  async writeBankIndex(raw: string): Promise<void> {
    const dir = await this.banksDir();
    await this.writeFile(dir, '_index.json', raw);
  }

  async writeQuestionBank(bankId: string, raw: string): Promise<void> {
    const dir = await this.banksDir();
    await this.writeFile(dir, `${bankId}.json`, raw);
  }

  async readQuestionBank(bankId: string): Promise<string | null> {
    try {
      const dir = await this.banksDir();
      const handle = await dir.getFileHandle(`${bankId}.json`);
      return await (await handle.getFile()).text();
    } catch {
      return null;
    }
  }

  async hasQuestionBank(bankId: string): Promise<boolean> {
    try {
      const dir = await this.banksDir();
      await dir.getFileHandle(`${bankId}.json`);
      return true;
    } catch {
      return false;
    }
  }

  async listSavedBanks(): Promise<string[]> {
    const dir = await this.banksDir();
    const ids: string[] = [];
    const entries = (
      dir as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries();
    for await (const [name, handle] of entries) {
      if (
        handle.kind === 'file' &&
        name.endsWith('.json') &&
        !name.endsWith('.assets.json') &&
        name !== '_index.json'
      ) {
        ids.push(name.replace(/\.json$/, ''));
      }
    }
    return ids;
  }

  async readBankIndex(): Promise<string | null> {
    try {
      const dir = await this.banksDir();
      const handle = await dir.getFileHandle('_index.json');
      return await (await handle.getFile()).text();
    } catch {
      return null;
    }
  }

  async writeBankCatalog(json: string, csv: string): Promise<void> {
    await this.writeFile(this.root, 'question-banks-catalog.json', json);
    await this.writeFile(this.root, 'question-banks-catalog.csv', csv);
  }

  async writeBankInventory(json: string, csv: string): Promise<void> {
    await this.writeFile(this.root, 'question-banks-inventory.json', json);
    await this.writeFile(this.root, 'question-banks-inventory.csv', csv);
  }

  async writeFolders(raw: string): Promise<void> {
    await this.writeFile(this.root, 'folders.json', raw);
  }

  async readFolders(): Promise<string | null> {
    try {
      const handle = await this.root.getFileHandle('folders.json');
      return await (await handle.getFile()).text();
    } catch {
      return null;
    }
  }

  async writeFolderInventory(json: string, csv: string): Promise<void> {
    await this.writeFile(this.root, 'folders-inventory.json', json);
    await this.writeFile(this.root, 'folders-inventory.csv', csv);
  }

  // --- Phase 2: assets --------------------------------------------------------

  private async assetsDir(): Promise<FileSystemDirectoryHandle> {
    return this.root.getDirectoryHandle(ASSETS_DIR, { create: true });
  }

  private scopeDir(
    scope: 'courses' | 'question-banks',
  ): Promise<FileSystemDirectoryHandle> {
    return scope === 'courses' ? this.coursesDir() : this.banksDir();
  }

  async writeAsset(name: string, bytes: Uint8Array): Promise<void> {
    const dir = await this.assetsDir();
    // Cast: BufferSource is pinned to ArrayBuffer in the DOM lib, but a
    // Uint8Array view is an accepted write chunk at runtime.
    await this.writeFile(dir, name, bytes as BufferSource);
  }

  async hasAsset(name: string): Promise<boolean> {
    try {
      const dir = await this.assetsDir();
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async writeAssetManifest(
    scope: 'courses' | 'question-banks',
    id: string,
    json: string,
  ): Promise<void> {
    const dir = await this.scopeDir(scope);
    await this.writeFile(dir, `${id}.assets.json`, json);
  }

  async hasAssetManifest(
    scope: 'courses' | 'question-banks',
    id: string,
  ): Promise<boolean> {
    try {
      const dir = await this.scopeDir(scope);
      await dir.getFileHandle(`${id}.assets.json`);
      return true;
    } catch {
      return false;
    }
  }

  async readAssetManifest(
    scope: 'courses' | 'question-banks',
    id: string,
  ): Promise<string | null> {
    try {
      const dir = await this.scopeDir(scope);
      const handle = await dir.getFileHandle(`${id}.assets.json`);
      return await (await handle.getFile()).text();
    } catch {
      return null;
    }
  }

  async writeAssetsSummary(json: string): Promise<void> {
    await this.writeFile(this.root, 'assets-summary.json', json);
  }
}
