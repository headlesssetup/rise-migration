import { sha256Hex } from '@/core/assets';
import type { Storage } from '@/core/storage/storage';
import type { GetCourseDocument } from '@/shared/types/rise';
import {
  LOCAL_ARCHIVE_FORMAT,
  LOCAL_ARCHIVE_VERSION,
  type LocalArchiveCourseEntryV1,
  type LocalArchiveManifestV1,
  type LocalArchiveOrigin,
} from './types';

function unwrap(raw: string): GetCourseDocument {
  const parsed = JSON.parse(raw) as { payload?: GetCourseDocument } & GetCourseDocument;
  return parsed.payload ?? parsed;
}

async function hashText(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value));
}

export async function buildCourseEntry(
  storage: Storage,
  id: string,
  title?: string,
): Promise<LocalArchiveCourseEntryV1> {
  const raw = await storage.readCourse(id);
  if (!raw) throw new Error(`courses/${id}.json is missing after write.`);
  const doc = unwrap(raw);
  const resolvedTitle = title ?? (typeof doc.course?.title === 'string' ? doc.course.title : undefined);
  const type =
    typeof doc.course?.type === 'string' || doc.course?.type === null
      ? doc.course.type
      : undefined;
  const assetRaw = await storage.readAssetManifest('courses', id);
  return {
    id,
    ...(resolvedTitle ? { title: resolvedTitle } : {}),
    ...(type !== undefined ? { type } : {}),
    file: `courses/${id}.json`,
    sha256: await hashText(raw),
    ...(assetRaw
      ? {
          assetManifest: `courses/${id}.assets.json`,
          assetManifestSha256: await hashText(assetRaw),
        }
      : {}),
  };
}

export async function buildCourseEntries(
  storage: Storage,
  courses: ReadonlyArray<{ id: string; title?: string }>,
): Promise<LocalArchiveCourseEntryV1[]> {
  const entries: LocalArchiveCourseEntryV1[] = [];
  for (const course of courses) {
    entries.push(await buildCourseEntry(storage, course.id, course.title));
  }
  return entries;
}

export function createManifestV1(args: {
  origin: LocalArchiveOrigin;
  state?: LocalArchiveManifestV1['state'];
  createdAt: string;
  toolVersion: string;
  courses: LocalArchiveCourseEntryV1[];
  sourceAccount?: LocalArchiveManifestV1['sourceAccount'];
  compilerRegistryRevision?: string;
  exportSummary?: Record<string, unknown>;
  creatorSummary?: Record<string, unknown>;
}): LocalArchiveManifestV1 {
  return {
    format: LOCAL_ARCHIVE_FORMAT,
    formatVersion: LOCAL_ARCHIVE_VERSION,
    state: args.state ?? 'ready',
    origin: args.origin,
    createdAt: args.createdAt,
    toolVersion: args.toolVersion,
    courses: args.courses,
    ...(args.sourceAccount ? { sourceAccount: args.sourceAccount } : {}),
    ...(args.compilerRegistryRevision ? { compilerRegistryRevision: args.compilerRegistryRevision } : {}),
    ...(args.exportSummary ? { exportSummary: args.exportSummary } : {}),
    ...(args.creatorSummary ? { creatorSummary: args.creatorSummary } : {}),
  };
}
