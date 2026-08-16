// Deterministic Course Blueprint → Rise archive compiler.
//
// The compiler is the only Creator module allowed to emit Rise JSON. It uses
// registry-backed donor mappers and aborts on unresolved local asset refs,
// media keys, l10n refs, or cross-course references.

import { collectAssetKeys } from '@/core/assets/keys';
import type { CourseBlueprint } from '@/core/creator/blueprint';
import { newId } from '@/core/import/ids';
import { findLocalAssetRefs } from '@/core/local-assets';
import {
  RISE_TEMPLATE_REGISTRY_REVISION,
  registryWarnings,
} from '@/core/rise-format';
import { findStorylineBlocks } from '@/core/storyline/detect';
import {
  defaultMints,
  mapLesson,
  type MappedBlockRecord,
  type Mints,
} from '@/core/storyboard/map';
import { StoryboardError } from '@/core/creator/errors';
import type { GetCourseDocument, Lesson } from '@/shared/types/rise';

export interface BuiltCourse {
  courseId: string;
  /** Raw `{course, lessons}` JSON body for `courses/<id>.json`. */
  raw: string;
  manifestEntry: { id: string; title: string };
  planJson: string;
  /** Narration companion (markdown), or null when there is none to report. */
  productionMd: string | null;
  lessonCount: number;
  blockCount: number;
  notes: string[];
  registryRevision: string;
  registryWarnings: string[];
}

export { findLocalAssetRefs, type LocalAssetOccurrence } from '@/core/local-assets';

/** Assert the compiler output contains no unresolved/local or foreign refs. */
export function assertCleanDocument(doc: GetCourseDocument): void {
  const local = findLocalAssetRefs(doc);
  if (local.length > 0) {
    throw new StoryboardError(
      `compiler emitted unresolved local asset ref(s): ${local
        .map((item) => `${item.assetPath} @ ${item.path}`)
        .join('; ')}`,
    );
  }
  const media = collectAssetKeys(doc);
  if (media.length > 0) {
    throw new StoryboardError(
      `compiler emitted media key(s) without an asset adapter: ${media
        .map((item) => `${item.key} @ ${item.paths[0]}`)
        .join('; ')}`,
    );
  }
  if (JSON.stringify(doc).includes('"l10nId"')) {
    throw new StoryboardError('compiler emitted an l10n ref in a monolingual course');
  }
  const storyline = findStorylineBlocks(doc);
  if (storyline.length > 0) {
    throw new StoryboardError(
      `compiler emitted storyline block(s): ${storyline.map((item) => item.blockId).join(', ')}`,
    );
  }
  if (JSON.stringify(doc).includes('DRAW_FROM_QUESTION_BANK')) {
    throw new StoryboardError('compiler emitted a draw-from-bank cross-ref');
  }
}

/** Narration companion report; null when the blueprint carries no narration
 *  (the writer then skips the file entirely). Content stays in the source
 *  language — only the report scaffolding is English. */
function productionReport(blueprint: CourseBlueprint): string | null {
  if (blueprint.production.length === 0) return null;
  const lines: string[] = [
    `# Production material — ${blueprint.title}`,
    '',
    'Narration / voice-over scripts per lesson. This text is NOT course',
    'content — it is for the experts and producers recording the media.',
    '',
  ];
  let lesson = '';
  for (const item of blueprint.production) {
    if (item.lesson !== lesson) {
      lesson = item.lesson;
      lines.push(`## ${lesson}`, '');
    }
    const slide = item.sourceRef.slideNo != null
      ? `Slide ${item.sourceRef.slideNo}`
      : item.sourceRef.label;
    const experience = item.sourceRef.excerpt?.replace(/\s+/g, ' ').trim();
    lines.push(`### ${slide}${experience ? ` — ${experience}` : ''}`, '', item.text, '');
  }
  return lines.join('\n');
}

/** Compile an approved blueprint into the standard local archive course body. */
export function compileCourseBlueprint(
  blueprint: CourseBlueprint,
  generatedAt: string,
  mints: Mints = defaultMints(),
  mintCourseId: () => string = newId,
): BuiltCourse {
  if (blueprint.lessons.length === 0) {
    throw new StoryboardError('blueprint has no lessons — nothing to build');
  }
  if (blueprint.assets.length > 0) {
    throw new StoryboardError(
      'blueprint contains local assets, but no registry-backed local-asset adapter is enabled',
    );
  }

  const courseId = `sb-${mintCourseId()}`;
  const lessons: Lesson[] = [];
  const records: (MappedBlockRecord & { lessonId: string; lesson: string })[] = [];
  const notes: string[] = [];
  const usedKinds = blueprint.lessons.flatMap((lesson) =>
    lesson.blocks.map((block) => block.intent.kind),
  );
  let blockCount = 0;

  for (let index = 0; index < blueprint.lessons.length; index++) {
    const plannedLesson = blueprint.lessons[index]!;
    const mapped = mapLesson(plannedLesson.title, plannedLesson.blocks, mints);
    const lessonId = mints.cuid();
    lessons.push({
      id: lessonId,
      courseId,
      type: 'blocks',
      position: index,
      title: plannedLesson.title,
      items: mapped.blocks,
    });
    blockCount += mapped.blocks.length;
    for (const record of mapped.records) {
      records.push({ ...record, lessonId, lesson: plannedLesson.title });
    }
    for (const note of mapped.notes) notes.push(`${plannedLesson.title}: ${note}`);
  }

  const doc: GetCourseDocument = {
    course: {
      id: courseId,
      title: blueprint.title,
      description: '',
      type: null,
    },
    lessons,
  };
  assertCleanDocument(doc);
  const warnings = registryWarnings(usedKinds);

  return {
    courseId,
    raw: JSON.stringify(doc, null, 2),
    manifestEntry: { id: courseId, title: blueprint.title },
    planJson: JSON.stringify(
      {
        generatedAt,
        courseId,
        source: blueprint.source,
        blueprint,
        registryRevision: RISE_TEMPLATE_REGISTRY_REVISION,
        blocks: records,
        unresolvedCount: blueprint.unresolved.length,
        registryWarnings: warnings,
      },
      null,
      2,
    ),
    productionMd: productionReport(blueprint),
    lessonCount: lessons.length,
    blockCount,
    notes,
    registryRevision: RISE_TEMPLATE_REGISTRY_REVISION,
    registryWarnings: warnings,
  };
}
