// FileSystemStorage — writes into a user-picked folder via the File System
// Access API. Layout per course folder:
//   <root>/courses/<courseId>.json   raw GET_COURSE body (never mutated)
//   <root>/census.json               full census
//   <root>/census.csv                flat census
//   <root>/manifest.json             run index
//
// Note: File System Access handles only work in a window context (the side
// panel), never in the service worker — so this lives panel-side.

import type { Storage } from './storage';

const COURSES_DIR = 'courses';

export class FileSystemStorage implements Storage {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  private async coursesDir(): Promise<FileSystemDirectoryHandle> {
    return this.root.getDirectoryHandle(COURSES_DIR, { create: true });
  }

  private async writeFile(
    dir: FileSystemDirectoryHandle,
    name: string,
    contents: string,
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
      if (handle.kind === 'file' && name.endsWith('.json')) {
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
}
