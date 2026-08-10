// Storyboard phase 2 — emit the SYNTHETIC SOURCE ARCHIVE course.
//
// The converter's output is a course in the exact layout the exporter produces
// (`courses/<id>.json` = a raw `{course, lessons}` body + a manifest entry), so
// the EXISTING import phase runs on it verbatim — creation handshake, paced
// writes, freshClientIds, read-back — with no forked build path
// (docs/rise-storyboard-plan.md, architecture decision).
//
// Validation is LOUD and runs on every build: a text-only storyboard course
// must reference NO media keys, NO l10n refs, NO cross-refs (banks/storyline).
// Any hit is a code fault in the mapper — abort, never ship.

import { collectAssetKeys } from '@/core/assets/keys';
import { newId } from '@/core/import/ids';
import { findStorylineBlocks } from '@/core/storyline/detect';
import type { GetCourseDocument, Lesson } from '@/shared/types/rise';
import { defaultMints, mapLesson, type MappedBlockRecord, type Mints } from './map';
import { StoryboardError, type PlannedCourse } from './types';

export interface BuiltCourse {
  courseId: string;
  /** Raw `{course, lessons}` JSON body for `courses/<id>.json`. */
  raw: string;
  manifestEntry: { id: string; title: string };
  /** Full conversion record (plan + per-block mapping) for the review artifact. */
  planJson: string;
  /** The filming-script report (Audio teksts per lesson/slide). */
  productionMd: string;
  lessonCount: number;
  blockCount: number;
  /** Review-facing notes, prefixed with lesson + slide. */
  notes: string[];
}

/** Assert the built document is text-only clean. Throws on any violation. */
export function assertCleanDocument(doc: GetCourseDocument): void {
  const media = collectAssetKeys(doc);
  if (media.length > 0) {
    throw new StoryboardError(
      `mapper emitted media key(s) in a text-only course: ${media
        .map((m) => `${m.key} @ ${m.paths[0]}`)
        .join('; ')}`,
    );
  }
  if (JSON.stringify(doc).includes('"l10nId"')) {
    throw new StoryboardError('mapper emitted an l10n ref in a monolingual course');
  }
  const storyline = findStorylineBlocks(doc);
  if (storyline.length > 0) {
    throw new StoryboardError(
      `mapper emitted storyline block(s): ${storyline.map((s) => s.blockId).join(', ')}`,
    );
  }
  if (JSON.stringify(doc).includes('DRAW_FROM_QUESTION_BANK')) {
    throw new StoryboardError('mapper emitted a draw-from-bank cross-ref');
  }
}

function productionReport(planned: PlannedCourse): string {
  const lines: string[] = [
    `# Producēšanas materiāls — ${planned.title}`,
    '',
    'Audio teksts (filmēšanas skripts) pa nodarbībām. Šis teksts NAV kursā —',
    'tas ir ekspertiem/producentiem video ierakstīšanai.',
    '',
  ];
  let lesson = '';
  for (const p of planned.production) {
    if (p.lesson !== lesson) {
      lesson = p.lesson;
      lines.push(`## ${lesson}`, '');
    }
    const slide = p.slideNo != null ? `Slaids ${p.slideNo}` : 'Slaids ?';
    lines.push(`### ${slide} — ${p.experience.replace(/\s+/g, ' ').trim()}`, '', p.audioText, '');
  }
  if (planned.production.length === 0) lines.push('_(nav audio tekstu)_', '');
  return lines.join('\n');
}

/**
 * Build the synthetic archive course from an approved PlannedCourse.
 * `generatedAt` is injectable (ISO string) so the build stays deterministic in
 * tests; callers pass `new Date().toISOString()`.
 */
export function buildArchiveCourse(
  planned: PlannedCourse,
  generatedAt: string,
  mints: Mints = defaultMints(),
  mintCourseId: () => string = newId,
): BuiltCourse {
  if (planned.lessons.length === 0) {
    throw new StoryboardError('plānā nav nevienas nodarbības — nav ko būvēt');
  }

  const courseId = `sb-${mintCourseId()}`;
  const lessons: Lesson[] = [];
  const records: (MappedBlockRecord & { lessonId: string; lesson: string })[] = [];
  const notes: string[] = [];
  let blockCount = 0;

  for (let i = 0; i < planned.lessons.length; i++) {
    const pl = planned.lessons[i]!;
    const mapped = mapLesson(pl.title, pl.blocks, mints);
    const lessonId = mints.cuid();
    lessons.push({
      id: lessonId,
      courseId,
      type: 'blocks',
      position: i,
      title: pl.title,
      items: mapped.blocks,
    });
    blockCount += mapped.blocks.length;
    for (const r of mapped.records) records.push({ ...r, lessonId, lesson: pl.title });
    for (const n of mapped.notes) notes.push(`${pl.title}: ${n}`);
  }

  const doc: GetCourseDocument = {
    course: {
      id: courseId,
      title: planned.title,
      description: '',
      // Regular course (capture-proven: a normal course has `type: null`).
      type: null,
    },
    lessons,
  };

  assertCleanDocument(doc);

  return {
    courseId,
    raw: JSON.stringify(doc, null, 2),
    manifestEntry: { id: courseId, title: planned.title },
    planJson: JSON.stringify(
      {
        generatedAt,
        courseId,
        source: 'storyboard-docx',
        planned,
        blocks: records,
        unparsedCount: planned.unparsed.length,
      },
      null,
      2,
    ),
    productionMd: productionReport(planned),
    lessonCount: lessons.length,
    blockCount,
    notes,
  };
}
