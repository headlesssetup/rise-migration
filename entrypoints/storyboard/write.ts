// Storyboard review tab — the APPROVE write path.
//
// Writes the synthetic archive course into the operator's archive folder via
// the same FileSystemStorage the panel uses. The manifest's `courses` list is
// MERGED (never overwritten) so exported batches and earlier conversions stay
// visible in the import picker (same rule as the exporter — archive-merge.ts).
// Conversion artifacts (plan + production script) go under `_import/` — derived
// artifacts live outside the raw content dirs.

import type { BuiltCourse } from '@/core/storyboard';
import type { Storage } from '@/core/storage/storage';
import {
  mergeById,
  parseManifestCourses,
} from '../sidepanel/archive-merge';

export interface WrittenFiles {
  courseFile: string;
  planFile: string;
  productionFile: string;
}

export async function writeBuiltCourse(
  storage: Storage,
  built: BuiltCourse,
  generatedAt: string,
): Promise<WrittenFiles> {
  await storage.writeCourse(built.courseId, built.raw);

  // Merge the manifest course list; preserve every other recorded field.
  const raw = await storage.readManifest();
  let manifest: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') manifest = parsed as Record<string, unknown>;
    } catch {
      /* corrupt manifest — rebuild the course list below, keep nothing else */
    }
  }
  manifest.courses = mergeById(parseManifestCourses(raw), [built.manifestEntry]);
  manifest.storyboardGeneratedAt = generatedAt;
  await storage.writeManifest(manifest);

  const planFile = `storyboard-${built.courseId}.plan.json`;
  const productionFile = `storyboard-${built.courseId}.production.md`;
  await storage.writeImportArtifact(planFile, built.planJson);
  await storage.writeImportArtifact(productionFile, built.productionMd);

  return {
    courseFile: `courses/${built.courseId}.json`,
    planFile: `_import/${planFile}`,
    productionFile: `_import/${productionFile}`,
  };
}
