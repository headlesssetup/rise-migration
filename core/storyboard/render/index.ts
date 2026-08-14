// SBDOC — Rise archive course → docx storyboard (docs/rise-storyboard-format.md).
// Pure, auth-free: raw archived {course, lessons} JSON → SbCourse model → .docx.

import { writeStoryboardDocx } from './docx-write';
import { writeStoryboardDocxProse, type ResolvedImage } from './docx-write-prose';
import { renderCourseModel, type RenderModelOptions } from './from-course';
import type { GetCourseDocument } from '@/shared/types/rise';
import type { SbCourse } from './model';

export { renderCourseModel } from './from-course';
export type { RenderModelOptions } from './from-course';
export { writeStoryboardDocx } from './docx-write';
export { writeStoryboardDocxProse } from './docx-write-prose';
export type { ResolvedImage } from './docx-write-prose';
export { htmlToParas, htmlToText } from './html';
export { fnv1a8 } from './model';
export type {
  SbCourse,
  SbFidelity,
  SbImage,
  SbLesson,
  SbPara,
  SbRow,
  SbRun,
} from './model';

export interface RenderedStoryboard {
  model: SbCourse;
  bytes: Uint8Array;
}

/** One-call render: archived course document → SBDOC model + table-based docx bytes. */
export function renderStoryboardDocx(
  raw: GetCourseDocument,
  opts: RenderModelOptions,
): RenderedStoryboard {
  const model = renderCourseModel(raw, opts);
  return { model, bytes: writeStoryboardDocx(model) };
}

/** One-call render: archived course document → SBDOC model + flowing-prose docx bytes. */
export function renderStoryboardDocxV2(
  raw: GetCourseDocument,
  opts: RenderModelOptions,
  images?: Map<string, ResolvedImage>,
): RenderedStoryboard {
  const model = renderCourseModel(raw, opts);
  return { model, bytes: writeStoryboardDocxProse(model, images) };
}
