// Rise Creator package writer. One source file = one course; within a
// CREATOR-origin folder the manifest MERGES (successive builds accumulate in
// `courses`), and a folder holding any OTHER manifest — a rise-export archive,
// a legacy/unknown index — is REFUSED before anything is written: replacing a
// rise-export manifest silently hid every exported course from Import
// (v0.9.0 guard; the archive is operator-managed input, never rewritten).
// A build.lock spans all writes so an interrupted build is visible next time.

import {
  LOCAL_ARCHIVE_FORMAT,
  LOCAL_ARCHIVE_VERSION,
  buildCourseEntry,
  createManifestV1,
  mergeById,
  type LocalArchiveCourseEntryV1,
  type LocalArchiveManifestV1,
} from '@/core/local-archive';
import type { BuiltCourse } from '@/core/creator/compiler';
import type { Storage } from '@/core/storage/storage';

const BUILD_LOCK = 'build.lock';

export interface WrittenFiles {
  courseFile: string;
  manifestFile: string;
  planFile: string;
  /** Absent when the blueprint carried no narration entries. */
  productionFile?: string;
  /** Present when a lock from an earlier interrupted build was replaced. */
  priorBuildWarning?: string;
}

export async function readCreatorBuildWarning(storage: Storage): Promise<string | null> {
  const raw = await storage.readCreatorArtifact(BUILD_LOCK);
  if (!raw) return null;
  try {
    const lock = JSON.parse(raw) as { startedAt?: unknown; sourceFile?: unknown };
    const when = typeof lock.startedAt === 'string' ? ` started ${lock.startedAt}` : '';
    const source = typeof lock.sourceFile === 'string' ? ` for ${lock.sourceFile}` : '';
    return `A previous Creator build${source}${when} did not finish. Review or clear the folder before relying on its contents.`;
  } catch {
    return 'A previous Creator build did not finish. Review or clear the folder before relying on its contents.';
  }
}

/**
 * The prior manifest's course entries IF the folder may be built into:
 * none (fresh folder), or an existing CREATOR-origin v1 manifest (merge).
 * Throws — before anything is written — for every other occupant.
 */
async function priorCreatorCourses(
  storage: Storage,
): Promise<LocalArchiveCourseEntryV1[]> {
  const raw = await storage.readManifest();
  if (!raw) return [];
  let prior: LocalArchiveManifestV1 | null = null;
  try {
    prior = JSON.parse(raw) as LocalArchiveManifestV1;
  } catch {
    prior = null;
  }
  if (
    !prior ||
    prior.format !== LOCAL_ARCHIVE_FORMAT ||
    prior.formatVersion !== LOCAL_ARCHIVE_VERSION
  ) {
    throw new Error(
      'This folder already holds a manifest that is not a rise-local-archive v1 index. ' +
        'A Creator build would replace it. Choose an empty folder or a dedicated Creator folder.',
    );
  }
  if (prior.origin !== 'creator') {
    const n = Array.isArray(prior.courses) ? prior.courses.length : 0;
    const src = prior.sourceAccount?.name;
    throw new Error(
      `This folder holds a ${prior.origin} archive (${n} course(s)${src ? `, source: ${src}` : ''}). ` +
        'A Creator build would replace its manifest and hide those courses from Import. ' +
        'Choose an empty folder or a dedicated Creator folder.',
    );
  }
  return Array.isArray(prior.courses) ? prior.courses : [];
}

export async function writeBuiltCourse(
  storage: Storage,
  built: BuiltCourse,
  generatedAt: string,
  toolVersion: string,
  sourceFile?: string,
): Promise<WrittenFiles> {
  // Refuse a foreign-origin folder BEFORE the build.lock or any other write.
  const priorCourses = await priorCreatorCourses(storage);
  const priorBuildWarning = await readCreatorBuildWarning(storage);
  await storage.writeCreatorArtifact(
    BUILD_LOCK,
    JSON.stringify({ startedAt: generatedAt, courseId: built.courseId, sourceFile }, null, 2),
  );

  await storage.writeCourse(built.courseId, built.raw);
  // The entry is derived AFTER writeCourse — it hashes what is actually on disk.
  const entry = await buildCourseEntry(storage, built.courseId, built.manifestEntry.title);
  const manifestArgs = {
    origin: 'creator' as const,
    createdAt: generatedAt,
    toolVersion,
    // Merge within a creator folder: earlier builds stay listed; a rebuild of
    // the same course id refreshes its entry. `creatorSummary` describes the
    // LATEST build only.
    courses: mergeById(priorCourses, [entry]),
    compilerRegistryRevision: built.registryRevision,
    creatorSummary: {
      sourceFile: sourceFile ?? null,
      lessonCount: built.lessonCount,
      blockCount: built.blockCount,
      registryWarnings: built.registryWarnings,
    },
  };

  // A concurrent/early import sees `building` and is blocked. `ready` is the
  // final write, after the course and review artifacts are safely on disk.
  await storage.writeManifest(createManifestV1({ ...manifestArgs, state: 'building' }));

  const planName = `${built.courseId}.blueprint.json`;
  const productionName = `${built.courseId}.production.md`;
  await storage.writeCreatorArtifact(planName, built.planJson);
  if (built.productionMd !== null) {
    await storage.writeCreatorArtifact(productionName, built.productionMd);
  }

  await storage.writeManifest(createManifestV1({ ...manifestArgs, state: 'ready' }));
  await storage.removeCreatorArtifact(BUILD_LOCK);

  return {
    courseFile: `courses/${built.courseId}.json`,
    manifestFile: 'manifest.json',
    planFile: `_creator/${planName}`,
    ...(built.productionMd !== null ? { productionFile: `_creator/${productionName}` } : {}),
    ...(priorBuildWarning ? { priorBuildWarning } : {}),
  };
}
