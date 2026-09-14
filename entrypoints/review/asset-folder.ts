// The operator's ASSET FOLDER (v0.9.12): a read-only directory of the
// designer's pictures/PDFs (e.g. `_design_for_Europe/N1..N4/*`). The prompt
// pack lists its file names so the AI references them by exact name; at
// compile time the referenced files are read, hashed (content address) and
// measured, and become uploaded media of the built course. Nothing here is
// ever written to the folder.

import { sha256Hex } from '@/core/assets/download';
import type { CourseBlueprint } from '@/core/creator/blueprint';
import type { ResolvedFile } from '@/core/style';

export interface FolderFile {
  name: string;
  /** Folder-relative path, for the operator's eyes only. */
  path: string;
  handle: FileSystemFileHandle;
}

export interface FolderListing {
  /** Unique base names → file. */
  files: Map<string, FolderFile>;
  /** Base names that occur in several sub-folders — excluded (ambiguous). */
  duplicates: string[];
  scanned: number;
}

const MEDIA_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp',
  'mp4', 'mov', 'webm', 'mp3', 'm4a', 'wav',
  'pdf',
]);

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  pdf: 'application/pdf',
};

export function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Recursively list media files by base name (hidden files skipped). */
export async function listFolderFiles(dir: FileSystemDirectoryHandle): Promise<FolderListing> {
  const files = new Map<string, FolderFile>();
  const dupes = new Set<string>();
  let scanned = 0;
  const walk = async (d: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const [name, handle] of d as unknown as AsyncIterable<
      [string, FileSystemDirectoryHandle | FileSystemFileHandle]
    >) {
      if (name.startsWith('.')) continue;
      if (handle.kind === 'directory') {
        await walk(handle, `${prefix}${name}/`);
        continue;
      }
      scanned++;
      if (!MEDIA_EXT.has(fileExt(name))) continue;
      if (files.has(name) || dupes.has(name)) {
        dupes.add(name);
        files.delete(name);
        continue;
      }
      files.set(name, { name, path: `${prefix}${name}`, handle });
    }
  };
  await walk(dir, '');
  return { files, duplicates: [...dupes].sort(), scanned };
}

/** Every folder file name a blueprint references (lesson + block images,
 *  attachment files), deduplicated, in document order. */
export function blueprintFileNames(bp: CourseBlueprint): string[] {
  const out: string[] = [];
  const add = (n: string | undefined): void => {
    if (n && !out.includes(n)) out.push(n);
  };
  for (const lesson of bp.lessons) {
    add(lesson.image);
    for (const block of lesson.blocks) {
      add(block.image);
      if (block.intent.kind === 'attachment-placeholder') add(block.intent.file);
    }
  }
  return out;
}

async function imageSize(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number } | null> {
  if (!mime.startsWith('image/') || typeof createImageBitmap !== 'function') return null;
  try {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  } catch {
    return null; // SVG/AVIF may not decode here — dimensions are optional
  }
}

/** Read, hash and measure the referenced files. Unknown names are reported,
 *  never guessed. */
export async function resolveFiles(
  listing: FolderListing,
  names: Iterable<string>,
): Promise<{ resolved: Map<string, ResolvedFile>; missing: string[] }> {
  const resolved = new Map<string, ResolvedFile>();
  const missing: string[] = [];
  for (const name of new Set(names)) {
    const f = listing.files.get(name);
    if (!f) {
      missing.push(name);
      continue;
    }
    const file = await f.handle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = fileExt(name);
    const mimeType = file.type || MIME[ext] || 'application/octet-stream';
    const size = await imageSize(bytes, mimeType);
    resolved.set(name, {
      name,
      bytes,
      sha256: await sha256Hex(bytes),
      ext,
      mimeType,
      size: bytes.byteLength,
      width: size?.width ?? null,
      height: size?.height ?? null,
    });
  }
  return { resolved, missing };
}
