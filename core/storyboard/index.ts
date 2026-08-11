// Storyboard → Rise converter (docs/rise-storyboard-plan.md).
// Pure, auth-free: docx bytes → PlannedCourse → synthetic archive course.

export { parseSdDocx, DocxError, cellText, paraText } from './docx';
export type { SdDoc, SdPara, SdRun, SdCell, SdTable } from './docx';
export { parseStoryboard, GREEN_CORRECT } from './parse';
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
