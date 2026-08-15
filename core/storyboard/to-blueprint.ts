import {
  COURSE_BLUEPRINT_FORMAT,
  COURSE_BLUEPRINT_VERSION,
  type BlueprintSourceRef,
  type CourseBlueprint,
} from '@/core/creator/blueprint';
import type { PlannedCourse, Provenance } from './types';

function sourceRef(provenance: Provenance): BlueprintSourceRef {
  return {
    label:
      provenance.slideNo != null
        ? `Storyboard slide ${provenance.slideNo}`
        : `Storyboard table row ${provenance.tableRow}`,
    slideNo: provenance.slideNo,
    row: provenance.tableRow,
    ...(provenance.rawScreenText ? { excerpt: provenance.rawScreenText } : {}),
  };
}

/** Deterministic adapter from the existing INTEA parser into the generic IR. */
export function plannedCourseToBlueprint(
  planned: PlannedCourse,
  originalFileName?: string,
): CourseBlueprint {
  return {
    format: COURSE_BLUEPRINT_FORMAT,
    formatVersion: COURSE_BLUEPRINT_VERSION,
    source: {
      kind: 'intea-storyboard',
      ...(originalFileName ? { originalFileName } : {}),
    },
    title: planned.title,
    lessons: planned.lessons.map((lesson) => ({
      title: lesson.title,
      blocks: lesson.blocks.map((block) => ({
        intent: block.intent,
        sourceRef: sourceRef(block.provenance),
        notes: [...block.notes],
      })),
    })),
    assets: [],
    unresolved: planned.unparsed.map((row) => ({
      sourceRef: sourceRef(row.provenance),
      reason: row.reason,
    })),
    production: planned.production.map((item) => ({
      kind: 'narration',
      lesson: item.lesson,
      sourceRef: {
        label:
          item.slideNo != null
            ? `Storyboard slide ${item.slideNo}`
            : `Storyboard production item`,
        slideNo: item.slideNo,
        ...(item.experience ? { excerpt: item.experience } : {}),
      },
      text: item.audioText,
    })),
  };
}
