// SBDOC — Rise archive course → docx storyboard (docs/rise-storyboard-format.md).
// Pure, auth-free: raw archived {course, lessons} JSON → SbCourse model → .docx.

import { writeStoryboardDocx } from './docx-write';
import { renderCourseModel, type RenderModelOptions } from './from-course';
import type { GetCourseDocument } from '@/shared/types/rise';
import type { SbCourse } from './model';

export { renderCourseModel } from './from-course';
export type { RenderModelOptions } from './from-course';
export { writeStoryboardDocx } from './docx-write';
export { htmlToParas, htmlToText } from './html';
export { fnv1a8 } from './model';
export type {
  SbCourse,
  SbFidelity,
  SbLesson,
  SbPara,
  SbRow,
  SbRun,
} from './model';

export interface RenderedStoryboard {
  model: SbCourse;
  bytes: Uint8Array;
}

/** One-call render: archived course document → SBDOC model + docx bytes. */
export function renderStoryboardDocx(
  raw: GetCourseDocument,
  opts: RenderModelOptions,
): RenderedStoryboard {
  const model = renderCourseModel(raw, opts);
  return { model, bytes: writeStoryboardDocx(model) };
}
