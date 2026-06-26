// Panel-side orchestration — the strictly-sequential, human-paced loops.
// CLAUDE.md invariant: every list page and every GET_COURSE finishes before the
// next starts, with a ~2s + jitter gap. No parallelism (except the public CDN
// asset downloads in ./assets, which are scoped out of the pacing invariant).
//
// Split by domain; this barrel keeps `import … from './orchestrator'` stable.

export type { ProgressEvent } from './shared';
export {
  countCourses,
  exportCourses,
  listAllCourses,
  scanSavedCourses,
  type ExportResult,
} from './courses';
export { buildFolders, fetchFolders } from './folders';
export {
  fetchQuestionBanks,
  scanSavedBanks,
  buildBankInventoryRows,
  type BankFetchResult,
} from './banks';
export {
  cdnDownload,
  makeCdnDownloader,
  cdnBasesForPlane,
  downloadAllAssets,
  type AssetsSummary,
} from './assets';
export { fetchAccountExtras, type AccountExtrasSummary } from './account';
export {
  scanSavedCoursesForStoryline,
  exportStorylinePackages,
  uploadStorylineToReview360,
  type StorylineCourseScan,
  type StorylineExportSummary,
  type StorylineUploadSummary,
} from './storyline';
export {
  runImport,
  readSourceIdentity,
  readArchiveInfo,
  importAccountSettings,
  listLocalBanks,
  importBanks,
  type ImportOptions,
  type ImportRunResult,
  type CourseImportOutcome,
  type ArchiveInfo,
  type AccountSettingsSummary,
  type AccountSettingsOptions,
  type LocalBank,
  type BankImportOutcome,
  type BankImportOptions,
} from './import';
