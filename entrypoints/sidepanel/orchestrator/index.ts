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
  type BankFetchResult,
} from './banks';
export { cdnDownload, downloadAllAssets, type AssetsSummary } from './assets';
