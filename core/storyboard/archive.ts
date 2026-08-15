// Compatibility facade for the existing deterministic INTEA storyboard path.
// The parser's PlannedCourse is first normalized to a provider-neutral Course
// Blueprint; only the generic compiler may emit Rise JSON.

export {
  assertCleanDocument,
  findLocalAssetRefs,
  type BuiltCourse,
  type LocalAssetOccurrence,
} from '@/core/creator/compiler';

import {
  compileCourseBlueprint,
  type BuiltCourse,
} from '@/core/creator/compiler';
import { newId } from '@/core/import/ids';
import type { Mints } from './map';
import { defaultMints } from './map';
import { plannedCourseToBlueprint } from './to-blueprint';
import type { PlannedCourse } from './types';

/**
 * Existing public entry point, now explicitly routed through Course Blueprint.
 * Kept stable so the current UI and tests do not fork the build path.
 */
export function buildArchiveCourse(
  planned: PlannedCourse,
  generatedAt: string,
  mints: Mints = defaultMints(),
  mintCourseId: () => string = newId,
  originalFileName?: string,
): BuiltCourse {
  return compileCourseBlueprint(
    plannedCourseToBlueprint(planned, originalFileName),
    generatedAt,
    mints,
    mintCourseId,
  );
}
