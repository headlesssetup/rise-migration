import type { AccountIdentity } from '@/core/import/guards';

export const LOCAL_ARCHIVE_FORMAT = 'rise-local-archive' as const;
export const LOCAL_ARCHIVE_VERSION = 1 as const;

export type LocalArchiveOrigin = 'rise-export' | 'creator';

export interface LocalArchiveCourseEntryV1 {
  id: string;
  title?: string;
  type?: string | null;
  file: string;
  sha256: string;
  assetManifest?: string;
  assetManifestSha256?: string;
}

export interface LocalArchiveManifestV1 {
  format: typeof LOCAL_ARCHIVE_FORMAT;
  formatVersion: typeof LOCAL_ARCHIVE_VERSION;
  state: 'building' | 'ready';
  origin: LocalArchiveOrigin;
  createdAt: string;
  toolVersion: string;
  courses: LocalArchiveCourseEntryV1[];
  sourceAccount?: AccountIdentity;
  compilerRegistryRevision?: string;
  exportSummary?: Record<string, unknown>;
  creatorSummary?: Record<string, unknown>;
}

export interface ArchiveCourseSummary {
  id: string;
  title?: string;
  type?: string | null;
}

export type ArchiveIssueSeverity = 'error' | 'warning';

export interface ArchiveIssue {
  severity: ArchiveIssueSeverity;
  code:
    | 'manifest-missing'
    | 'manifest-json'
    | 'manifest-shape'
    | 'manifest-version'
    | 'manifest-state'
    | 'course-entry'
    | 'course-duplicate'
    | 'course-missing'
    | 'course-json'
    | 'course-shape'
    | 'course-id'
    | 'course-hash'
    | 'asset-manifest-missing'
    | 'asset-manifest-json'
    | 'asset-manifest-shape'
    | 'asset-manifest-hash'
    | 'asset-missing'
    | 'asset-hash'
    | 'legacy';
  path: string;
  message: string;
}

export interface LocalArchiveInspection {
  kind: 'v1' | 'legacy' | 'invalid';
  ready: boolean;
  origin?: LocalArchiveOrigin;
  toolVersion?: string;
  manifest?: LocalArchiveManifestV1;
  courses: ArchiveCourseSummary[];
  issues: ArchiveIssue[];
}

/** The read-only surface required by archive inspection. `Storage` satisfies it. */
export interface LocalArchiveReader {
  readManifest(): Promise<string | null>;
  readCourse(courseId: string): Promise<string | null>;
  listSaved(): Promise<string[]>;
  readAssetManifest(
    scope: 'courses' | 'question-banks',
    id: string,
  ): Promise<string | null>;
  readAsset(name: string): Promise<Uint8Array | null>;
}
