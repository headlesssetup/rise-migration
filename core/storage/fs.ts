// FileSystemStorage — writes into a user-picked folder via the File System
// Access API. Layout:
//   <root>/manifest.json                    run index (stays at root)
//   <root>/courses/<id>.json                raw GET_COURSE body (never mutated)
//   <root>/courses/<id>.assets.json         per-course asset manifest
//   <root>/question-banks/<id>.json|_index  raw banks (+ per-bank asset manifest)
//   <root>/assets/<sha256>.<ext>            content-addressed media bytes (dedup)
//   <root>/account/                         raw account source: folders.json,
//                                           block-templates/typefaces/review-items
//   <root>/_metadata/                       derived reports (regenerated each run):
//                                           inventory/census/catalog/novelty/
//                                           *-inventory/*-catalog/assets-summary
//
// Note: File System Access handles only work in a window context (the side
// panel), never in the service worker — so this lives panel-side.

import type { Storage } from './storage';

const COURSES_DIR = 'courses';
const BANKS_DIR = 'question-banks';
const ASSETS_DIR = 'assets';
// Derived reports (regenerated each run) live under _metadata/; raw account-level
// source exports under account/. Content dirs + manifest.json stay at root.
const META_DIR = '_metadata';
const ACCOUNT_DIR = 'account';

export class FileSystemStorage implements Storage {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  private async coursesDir(): Promise<FileSystemDirectoryHandle> {
    return this.root.getDirectoryHandle(COURSES_DIR, { create: true });
  }

  private metaDir(): Promise<FileSystemDirectoryHandle> {
    return this.root.getDirectoryHandle(META_DIR, { create: true });
  }

  private accountDir(): Promise<FileSystemDirectoryHandle> {
    return this.root.getDirectoryHandle(ACCOUNT_DIR, { create: true });
  }

  /** Write a json+csv report pair into _metadata/. */
  private async writeMetaPair(
    base: string,
    json: string,
    csv: string,
  ): Promise<void> {
    const dir = await this.metaDir();
    await this.writeFile(dir, `${base}.json`, json);
    await this.writeFile(dir, `${base}.csv`, csv);
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

  async readManifest(): Promise<string | null> {
    try {
      const handle = await this.root.getFileHandle('manifest.json');
      return await (await handle.getFile()).text();
    } catch {
      return null;
    }
  }

  async writeInventory(json: string, csv: string): Promise<void> {
    await this.writeMetaPair('inventory', json, csv);
  }

  async readInventory(): Promise<string | null> {
    try {
      const dir = await this.metaDir();
      const handle = await dir.getFileHandle('inventory.json');
      return await (await handle.getFile()).text();
    } catch {
      return null;
    }
  }

  async writeCensus(json: string, csv: string): Promise<void> {
    await this.writeMetaPair('census', json, csv);
  }

  async writeCatalog(json: string, csv: string): Promise<void> {
    await this.writeMetaPair('catalog', json, csv);
  }

  async writeNovelty(json: string, csv: string): Promise<void> {
    await this.writeMetaPair('novelty', json, csv);
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
    await this.writeMetaPair('question-banks-catalog', json, csv);
  }

  async writeBankInventory(json: string, csv: string): Promise<void> {
    await this.writeMetaPair('question-banks-inventory', json, csv);
  }

  async writeFolders(raw: string): Promise<void> {
    const dir = await this.accountDir();
    await this.writeFile(dir, 'folders.json', raw);
  }

  async readFolders(): Promise<string | null> {
    try {
      const dir = await this.accountDir();
      const handle = await dir.getFileHandle('folders.json');
      return await (await handle.getFile()).text();
    } catch {
      return null;
    }
  }

  async writeFolderInventory(json: string, csv: string): Promise<void> {
    await this.writeMetaPair('folders-inventory', json, csv);
  }

  async writeBlockTemplates(raw: string): Promise<void> {
    const dir = await this.accountDir();
    await this.writeFile(dir, 'block-templates.json', raw);
  }

  async writeBlockTemplateInventory(json: string, csv: string): Promise<void> {
    await this.writeMetaPair('block-templates-inventory', json, csv);
  }

  async writeTypefaces(raw: string): Promise<void> {
    const dir = await this.accountDir();
    await this.writeFile(dir, 'typefaces.json', raw);
  }

  async writeTypefaceInventory(json: string, csv: string): Promise<void> {
    await this.writeMetaPair('typefaces-inventory', json, csv);
  }

  async writeReviewItems(raw: string): Promise<void> {
    const dir = await this.accountDir();
    await this.writeFile(dir, 'review-items.json', raw);
  }

  async writeReviewItemsInventory(json: string, csv: string): Promise<void> {
    await this.writeMetaPair('review-items-inventory', json, csv);
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

  async readAsset(name: string): Promise<Uint8Array | null> {
    try {
      const dir = await this.assetsDir();
      const handle = await dir.getFileHandle(name);
      const buf = await (await handle.getFile()).arrayBuffer();
      return new Uint8Array(buf);
    } catch {
      return null;
    }
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
    const dir = await this.metaDir();
    await this.writeFile(dir, 'assets-summary.json', json);
  }

  // --- Phase 3: import artifacts (under _import/, separate from the archive) ---

  private importDir(): Promise<FileSystemDirectoryHandle> {
    return this.root.getDirectoryHandle('_import', { create: true });
  }

  async writeImportArtifact(name: string, contents: string): Promise<void> {
    const dir = await this.importDir();
    await this.writeFile(dir, name, contents);
  }

  async readImportArtifact(name: string): Promise<string | null> {
    try {
      const dir = await this.importDir();
      const handle = await dir.getFileHandle(name);
      return await (await handle.getFile()).text();
    } catch {
      return null;
    }
  }
}
