// Rise Creator package writer. The operator chooses the destination folder and
// is responsible for choosing an empty one; this module does not scan or block
// non-empty folders. It does, however, leave a build.lock across all writes so
// an interrupted build is visible on the next attempt.

import { buildCourseEntry, createManifestV1 } from '@/core/local-archive';
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

export async function writeBuiltCourse(
  storage: Storage,
  built: BuiltCourse,
  generatedAt: string,
  toolVersion: string,
  sourceFile?: string,
): Promise<WrittenFiles> {
  const priorBuildWarning = await readCreatorBuildWarning(storage);
  await storage.writeCreatorArtifact(
    BUILD_LOCK,
    JSON.stringify({ startedAt: generatedAt, courseId: built.courseId, sourceFile }, null, 2),
  );

  // One source file = one course = one complete manifest. No archive merge.
  await storage.writeCourse(built.courseId, built.raw);
  const entry = await buildCourseEntry(storage, built.courseId, built.manifestEntry.title);
  const manifestArgs = {
    origin: 'creator' as const,
    createdAt: generatedAt,
    toolVersion,
    courses: [entry],
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
