// Storyboard ⇄ Rise (docs/rise-storyboard-plan.md, docs/rise-storyboard-format.md).
// Pure, auth-free, both directions:
//   SD docx bytes → PlannedCourse → synthetic archive course   (import)
//   archived course → SBDOC model → storyboard docx bytes      (export, ./render)

export * from './render';

export { parseSdDocx, DocxError, cellText, paraText } from './docx';
export type { SdDoc, SdPara, SdRun, SdCell, SdTable } from './docx';
export { parseStoryboard, GREEN_CORRECT } from './parse';
export { plannedCourseToBlueprint } from './to-blueprint';
export { mapIntent, mapLesson, defaultMints } from './map';
export type { Mints, MappedLesson } from './map';
export { buildArchiveCourse, assertCleanDocument } from './archive';
export type { BuiltCourse } from './archive';
export { StoryboardError } from './types';
export type {
  BlockIntent,
  IntentItem,
  KcOption,
  KcQuestion,
  PlannedBlock,
  PlannedCourse,
  PlannedLesson,
  ProductionItem,
  Provenance,
  UnparsedRow,
} from './types';
