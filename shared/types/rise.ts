// Permissive Rise schema types. Phase 0 deliberately keeps these loose — the
// census produces real fixtures from which we tighten these later (build plan §3).
// We never model blocks per-type here: the migrator is copy-faithful and only
// the generic recursive census cares about structure.

/** One row from GET /manage/api/content/search. */
export interface SearchResultItem {
  id: string;
  title?: string;
  type?: string;
  folderId?: string;
  shareId?: string;
  lessonCount?: number;
  updatedAt?: string;
  [k: string]: unknown;
}

/** Response envelope for the search endpoint (shape not fully captured → permissive). */
export interface SearchResponse {
  items?: SearchResultItem[];
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  [k: string]: unknown;
}

/** A content block: copy-faithful, identified by family/variant. */
export interface Block {
  id?: string;
  type?: string;
  family?: string;
  variant?: string;
  items?: unknown[];
  settings?: unknown;
  globalBlockId?: string;
  [k: string]: unknown;
}

/** A lesson: type is "blocks" | "section" | "quiz". */
export interface Lesson {
  id?: string;
  type?: string;
  position?: number;
  title?: string;
  items?: Block[];
  [k: string]: unknown;
}

export interface Course {
  id?: string;
  title?: string;
  version?: string | number;
  theme?: Record<string, unknown>;
  [k: string]: unknown;
}

/** The `payload` of a GET_COURSE ducks response. */
export interface GetCourseDocument {
  course?: Course;
  lessons?: Lesson[];
  [k: string]: unknown;
}
