// Moved to core/local-archive/merge.ts (v0.9.0) so core code — the Creator
// package writer's manifest merge — can use it without reaching into the
// panel. This path stays the panel-side door; the surface is unchanged.
export {
  mergeById,
  parseIdRows,
  parseManifestCourses,
  type ManifestCourseEntry,
} from '@/core/local-archive/merge';
