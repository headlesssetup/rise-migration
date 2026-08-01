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
  /** Multi-language stack: one entry per language (empty array on monolingual). */
  locales?: { id?: string; locale?: string; [k: string]: unknown }[];
  /** Locale-row id of the stack's default language (null on monolingual). */
  defaultLocaleId?: string | null;
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

/** A lesson: type is "blocks" | "section" | "quiz".
 *  On a multi-language stack, `title` is an {l10nId} ref, not a string. */
export interface Lesson {
  id?: string;
  type?: string;
  position?: number;
  title?: string | L10nRef;
  items?: Block[];
  [k: string]: unknown;
}

export interface Course {
  id?: string;
  /** Plain string on a monolingual course; {l10nId} ref on a stack. */
  title?: string | L10nRef;
  version?: string | number;
  theme?: Record<string, unknown>;
  /** Stack marker: locale-row id of the default language (null/absent otherwise). */
  defaultLocaleId?: string | null;
  /** Stack marker: `{isLocalized: true, localizedAt}` once converted ({} otherwise). */
  localizationMetadata?: { isLocalized?: boolean; localizedAt?: string } | null;
  [k: string]: unknown;
}

/** A localized-value reference — sits IN PLACE of a string/media value anywhere
 *  in a stack's course/lesson/block JSON; resolved through
 *  `l10n.translations[locale][l10nId]` (docs/rise-multilang.md §2). */
export interface L10nRef {
  l10nId: string;
}

/** One language of a stack (a row of `payload.l10n.locales`; its `id` is also
 *  the stack-item id in /manage/api/content/{id}/translations). */
export interface L10nLocale {
  id?: string;
  courseId?: string;
  locale?: string;
  labelSetId?: string | null;
  rightToLeft?: boolean;
  formality?: string | null;
  glossaryId?: string | null;
  glossaryGroupId?: string | null;
  deletedAt?: string | null;
  [k: string]: unknown;
}

/** A cell value: plain string, HTML string, or a media object (mediaRecord). */
export type L10nValue = string | Record<string, unknown>;

/** The l10n overlay of a stack's GET_COURSE payload. A monolingual course has
 *  only `languageCodeMetadata` here. */
export interface L10nOverlay {
  defaultLocale?: string;
  showLocaleSelector?: boolean;
  locales?: L10nLocale[];
  /** locale code → (l10nId → value). Cells may exist in ANY subset of locales. */
  translations?: Record<string, Record<string, L10nValue>>;
  languageCodeMetadata?: Record<string, unknown>;
  [k: string]: unknown;
}

/** The `payload` of a GET_COURSE ducks response. */
export interface GetCourseDocument {
  course?: Course;
  lessons?: Lesson[];
  l10n?: L10nOverlay;
  [k: string]: unknown;
}
