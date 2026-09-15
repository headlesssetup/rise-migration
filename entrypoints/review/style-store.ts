// Style profiles on disk (v0.9.12): `_creator/styles/<slug>.json` inside the
// CREATOR folder, next to the blueprint/production artifacts. Harvesting reads
// a rise-export archive folder (the designer's finished courses) and copies
// the profile's shared media into the Creator folder's content-addressed
// `assets/` store, so a styled build's asset manifest resolves locally.
// The source archive is operator-managed input: it is only ever READ.

import type { AssetManifest } from '@/core/assets/manifest';
import { FileSystemStorage } from '@/core/storage/fs';
import {
  harvestStyleProfile,
  parseStyleProfile,
  type HarvestCourseInput,
  type StyleProfile,
} from '@/core/style';
import type { GetCourseDocument } from '@/shared/types/rise';

export interface StoredStyle {
  fileName: string;
  profile: StyleProfile;
}

async function stylesDir(
  creator: FileSystemDirectoryHandle,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    const c = await creator.getDirectoryHandle('_creator', { create });
    return await c.getDirectoryHandle('styles', { create });
  } catch {
    return null;
  }
}

export async function listStyles(creator: FileSystemDirectoryHandle): Promise<StoredStyle[]> {
  const dir = await stylesDir(creator, false);
  if (!dir) return [];
  const out: StoredStyle[] = [];
  for await (const [name, handle] of dir as unknown as AsyncIterable<
    [string, FileSystemDirectoryHandle | FileSystemFileHandle]
  >) {
    if (handle.kind !== 'file' || !name.endsWith('.json')) continue;
    try {
      const raw = await (await handle.getFile()).text();
      out.push({ fileName: name, profile: parseStyleProfile(raw) });
    } catch {
      // A foreign/corrupt file in the styles folder is skipped, not fatal.
    }
  }
  return out.sort((a, b) => a.profile.name.localeCompare(b.profile.name));
}

export function styleSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'style';
}

/** The Creator folder is a dedicated staging folder. A rise-export archive
 *  (or any non-creator manifest) is REFUSED before anything is written — the
 *  same guard as the package writer (archives are operator-managed input). */
export async function assertCreatorFolder(creator: FileSystemDirectoryHandle): Promise<void> {
  const raw = await new FileSystemStorage(creator).readManifest();
  if (!raw) return;
  let origin: unknown = null;
  try {
    origin = (JSON.parse(raw) as { origin?: unknown }).origin;
  } catch {
    origin = 'unreadable';
  }
  if (origin !== 'creator') {
    throw new Error(
      `"${creator.name}" holds a ${String(origin ?? 'unknown')} archive — it cannot be the Creator folder. Use "Change Creator folder…" and pick an empty or dedicated Creator folder; style profiles and packages are written there.`,
    );
  }
}

export async function saveStyle(
  creator: FileSystemDirectoryHandle,
  profile: StyleProfile,
): Promise<string> {
  await assertCreatorFolder(creator);
  const dir = await stylesDir(creator, true);
  if (!dir) throw new Error('Could not create _creator/styles in the Creator folder.');
  const fileName = `${styleSlug(profile.name)}.json`;
  const handle = await dir.getFileHandle(fileName, { create: true });
  const w = await handle.createWritable();
  await w.write(JSON.stringify(profile, null, 2));
  await w.close();
  return `_creator/styles/${fileName}`;
}

export interface ArchiveCourseRow {
  id: string;
  title: string;
}

/** Courses listed by a rise-export archive's manifest (read-only). */
export async function listArchiveCourses(source: FileSystemDirectoryHandle): Promise<{
  origin: string | null;
  state: string | null;
  courses: ArchiveCourseRow[];
}> {
  const storage = new FileSystemStorage(source);
  const raw = await storage.readManifest();
  if (!raw) throw new Error('No manifest.json in that folder — pick a rise-export archive.');
  const m = JSON.parse(raw) as { origin?: unknown; state?: unknown; courses?: unknown };
  const rows = Array.isArray(m.courses) ? m.courses : [];
  return {
    origin: typeof m.origin === 'string' ? m.origin : null,
    state: typeof m.state === 'string' ? m.state : null,
    courses: rows
      .filter((r): r is { id: string; title?: string } => !!r && typeof (r as { id?: unknown }).id === 'string')
      .map((r) => ({ id: r.id, title: typeof r.title === 'string' ? r.title : r.id })),
  };
}

function unwrap(raw: string): GetCourseDocument {
  const parsed = JSON.parse(raw) as { payload?: GetCourseDocument } & GetCourseDocument;
  return parsed.payload ?? parsed;
}

export interface HarvestOutcome {
  profile: StyleProfile;
  report: string[];
  /** Asset files copied into the Creator folder (already-present ones skipped). */
  copied: number;
  savedAs: string;
}

/** Harvest a profile from `courseIds` of the source archive, copy its media
 *  into the Creator folder, and save it under `_creator/styles/`. */
export async function harvestFromArchive(args: {
  source: FileSystemDirectoryHandle;
  creator: FileSystemDirectoryHandle;
  courseIds: string[];
  name: string;
  toolVersion: string;
}): Promise<HarvestOutcome> {
  await assertCreatorFolder(args.creator);
  const src = new FileSystemStorage(args.source);
  const dest = new FileSystemStorage(args.creator);
  const courses: HarvestCourseInput[] = [];
  for (const id of args.courseIds) {
    const raw = await src.readCourse(id);
    if (!raw) throw new Error(`courses/${id}.json is missing in the style source archive.`);
    const assetRaw = await src.readAssetManifest('courses', id);
    // A course exported WITHOUT its media (a content-only fetch, or an export
    // stopped before the asset stage) cannot donate banners, icons or the
    // cover: refuse loudly rather than save a profile with every donor dropped.
    if (!assetRaw) {
      throw new Error(
        `courses/${id}.assets.json is missing in "${args.source.name}" — that archive was exported without media (content-only fetch or interrupted export). Pick a complete rise-export archive (state "ready", with an assets/ folder), e.g. the September export.`,
      );
    }
    courses.push({ doc: unwrap(raw), assetManifest: JSON.parse(assetRaw) as AssetManifest });
  }
  const { profile, report } = harvestStyleProfile({
    name: args.name,
    courses,
    toolVersion: args.toolVersion,
    harvestedAt: new Date().toISOString(),
  });
  let copied = 0;
  const missing: string[] = [];
  for (const a of profile.assets) {
    const name = a.file.replace(/^assets\//, '');
    if (await dest.hasAsset(name)) continue;
    const bytes = await src.readAsset(name);
    if (!bytes) {
      missing.push(a.key);
      continue;
    }
    await dest.writeAsset(name, bytes);
    copied++;
  }
  if (missing.length > 0) {
    throw new Error(
      `The style source archive lacks bytes for ${missing.length} asset(s) the profile needs (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}). Re-export the source courses with assets.`,
    );
  }
  const savedAs = await saveStyle(args.creator, profile);
  return { profile, report, copied, savedAs };
}
