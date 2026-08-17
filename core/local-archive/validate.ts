import { collectAssetKeys } from '@/core/assets';
import type { AssetManifest } from '@/core/assets/manifest';
import type { GetCourseDocument } from '@/shared/types/rise';
import {
  LOCAL_ARCHIVE_FORMAT,
  LOCAL_ARCHIVE_VERSION,
  type ArchiveCourseSummary,
  type ArchiveIssue,
  type LocalArchiveCourseEntryV1,
  type LocalArchiveInspection,
  type LocalArchiveManifestV1,
  type LocalArchiveReader,
} from './types';

const SHA256 = /^[a-f0-9]{64}$/;

function issue(
  issues: ArchiveIssue[],
  severity: ArchiveIssue['severity'],
  code: ArchiveIssue['code'],
  path: string,
  message: string,
): void {
  issues.push({ severity, code, path, message });
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

function courseDocument(parsed: unknown): GetCourseDocument | null {
  const root = object(parsed);
  if (!root) return null;
  const value = object(root.payload) ?? root;
  return object(value.course) && Array.isArray(value.lessons)
    ? (value as GetCourseDocument)
    : null;
}

function courseSummary(doc: GetCourseDocument, fallbackId: string): ArchiveCourseSummary {
  const title = typeof doc.course?.title === 'string' ? doc.course.title : undefined;
  const type =
    typeof doc.course?.type === 'string' || doc.course?.type === null
      ? doc.course.type
      : undefined;
  return { id: fallbackId, ...(title ? { title } : {}), ...(type !== undefined ? { type } : {}) };
}

function validCourseEntry(value: unknown): value is LocalArchiveCourseEntryV1 {
  const row = object(value);
  return !!row &&
    typeof row.id === 'string' && row.id.length > 0 &&
    typeof row.file === 'string' && row.file.length > 0 &&
    typeof row.sha256 === 'string' && SHA256.test(row.sha256) &&
    (row.title === undefined || typeof row.title === 'string') &&
    (row.type === undefined || row.type === null || typeof row.type === 'string') &&
    (row.assetManifest === undefined || typeof row.assetManifest === 'string') &&
    (row.assetManifestSha256 === undefined ||
      (typeof row.assetManifestSha256 === 'string' && SHA256.test(row.assetManifestSha256)));
}

function parseV1Manifest(value: unknown, issues: ArchiveIssue[]): LocalArchiveManifestV1 | null {
  const m = object(value);
  if (!m) {
    issue(issues, 'error', 'manifest-shape', 'manifest.json', 'Manifest must be a JSON object.');
    return null;
  }
  if (m.format !== LOCAL_ARCHIVE_FORMAT || m.formatVersion !== LOCAL_ARCHIVE_VERSION) {
    issue(
      issues,
      'error',
      'manifest-version',
      'manifest.json',
      `Expected ${LOCAL_ARCHIVE_FORMAT} formatVersion ${LOCAL_ARCHIVE_VERSION}.`,
    );
    return null;
  }
  if (m.state !== 'ready' && m.state !== 'building') {
    issue(issues, 'error', 'manifest-shape', 'manifest.json.state', 'Archive state must be building or ready.');
  } else if (m.state !== 'ready') {
    issue(issues, 'error', 'manifest-state', 'manifest.json.state', 'Archive build is incomplete.');
  }
  if (m.origin !== 'rise-export' && m.origin !== 'creator') {
    issue(issues, 'error', 'manifest-shape', 'manifest.json.origin', 'Origin must be rise-export or creator.');
  }
  if (typeof m.createdAt !== 'string' || typeof m.toolVersion !== 'string') {
    issue(
      issues,
      'error',
      'manifest-shape',
      'manifest.json',
      'createdAt and toolVersion must be strings.',
    );
  }
  if (!Array.isArray(m.courses)) {
    issue(issues, 'error', 'manifest-shape', 'manifest.json.courses', 'courses must be an array.');
    return null;
  }
  for (const [i, row] of m.courses.entries()) {
    if (!validCourseEntry(row)) {
      issue(
        issues,
        'error',
        'course-entry',
        `manifest.json.courses[${i}]`,
        'Course entry is missing a valid id, file, or SHA-256 hash.',
      );
    }
  }
  if (issues.some((i) => i.severity === 'error' && i.code !== 'manifest-state')) return null;
  return m as unknown as LocalArchiveManifestV1;
}

async function inspectCourse(
  reader: LocalArchiveReader,
  entry: LocalArchiveCourseEntryV1,
  issues: ArchiveIssue[],
  parseCourse: boolean,
  assetPresence: Map<string, Promise<boolean>>,
): Promise<ArchiveCourseSummary | null> {
  const expectedFile = `courses/${entry.id}.json`;
  if (entry.file !== expectedFile) {
    issue(
      issues,
      'error',
      'course-entry',
      `manifest.json.courses[${entry.id}].file`,
      `Course file must be ${expectedFile}; found ${entry.file}.`,
    );
  }
  if (!(await reader.hasCourse(entry.id))) {
    issue(issues, 'error', 'course-missing', expectedFile, 'Referenced course file is missing.');
    return null;
  }
  if (!parseCourse) {
    await inspectAssets(reader, entry, undefined, issues, assetPresence);
    return {
      id: entry.id,
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      ...(entry.type !== undefined ? { type: entry.type } : {}),
    };
  }
  const raw = await reader.readCourse(entry.id);
  if (!raw) {
    issue(issues, 'error', 'course-missing', expectedFile, 'Referenced course file became unavailable.');
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch (e) {
    issue(issues, 'error', 'course-json', expectedFile, `Invalid JSON: ${String(e)}`);
    return null;
  }
  const doc = courseDocument(parsed);
  if (!doc) {
    issue(
      issues,
      'error',
      'course-shape',
      expectedFile,
      'Course JSON must contain {course, lessons} (bare or under payload).',
    );
    return null;
  }
  const documentId = typeof doc.course?.id === 'string' ? doc.course.id : undefined;
  if (documentId && documentId !== entry.id) {
    issue(
      issues,
      'error',
      'course-id',
      `${expectedFile}#course.id`,
      `Manifest id ${entry.id} does not match course.id ${documentId}.`,
    );
  }
  await inspectAssets(reader, entry, doc, issues, assetPresence);
  return {
    ...courseSummary(doc, entry.id),
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    ...(entry.type !== undefined ? { type: entry.type } : {}),
  };
}

async function inspectAssets(
  reader: LocalArchiveReader,
  entry: LocalArchiveCourseEntryV1,
  doc: GetCourseDocument | undefined,
  issues: ArchiveIssue[],
  assetPresence: Map<string, Promise<boolean>>,
): Promise<void> {
  const referenced = doc ? collectAssetKeys(doc, entry.id) : [];
  const path = `courses/${entry.id}.assets.json`;
  const exists = await reader.hasAssetManifest('courses', entry.id);
  if (!exists) {
    if (referenced.length > 0 || entry.assetManifest) {
      issue(issues, 'error', 'asset-manifest-missing', path, 'Course references media but its asset manifest is missing.');
    }
    return;
  }
  if (entry.assetManifest !== path) {
    issue(
      issues,
      'error',
      'course-entry',
      `manifest.json.courses[${entry.id}].assetManifest`,
      `Asset manifest path must be ${path}.`,
    );
  }
  // The picker stops here: it proves the manifest's immediate files exist but
  // does not open course JSON, walk asset rows, or touch binary blobs. Selected
  // import preflight supplies `doc` and performs the deeper coverage checks.
  if (!doc) return;
  const raw = await reader.readAssetManifest('courses', entry.id);
  if (!raw) {
    issue(issues, 'error', 'asset-manifest-missing', path, 'Asset manifest became unavailable.');
    return;
  }
  let manifest: AssetManifest;
  try {
    manifest = parseJson(raw) as AssetManifest;
  } catch (e) {
    issue(issues, 'error', 'asset-manifest-json', path, `Invalid JSON: ${String(e)}`);
    return;
  }
  if (
    !manifest || manifest.ownerId !== entry.id || !Array.isArray(manifest.assets) ||
    !Array.isArray(manifest.failed)
  ) {
    issue(issues, 'error', 'asset-manifest-shape', path, 'Asset manifest has an invalid owner or rows.');
    return;
  }
  const declared = new Map<string, AssetManifest['assets'][number]>();
  for (const [i, asset] of manifest.assets.entries()) {
    if (!asset || typeof asset.key !== 'string' || typeof asset.file !== 'string' || !asset.file) {
      issue(issues, 'error', 'asset-manifest-shape', `${path}#assets[${i}]`, 'Asset row is invalid.');
      continue;
    }
    declared.set(asset.key, asset);
  }
  const terminal = new Set((manifest.failed ?? []).map((f) => f.key));
  for (const ref of referenced) {
    const asset = declared.get(ref.key);
    if (!asset && !terminal.has(ref.key)) {
      issue(
        issues,
        'error',
        'asset-missing',
        ref.paths[0] ?? path,
        `Referenced media ${ref.key} has no asset bytes or recorded failure.`,
      );
      continue;
    }
    if (asset) {
      const name = String(asset.file ?? '').replace(/^assets\//, '');
      let present = assetPresence.get(name);
      if (!present) {
        present = reader.hasAsset(name);
        assetPresence.set(name, present);
      }
      if (!name || !(await present)) {
        issue(issues, 'error', 'asset-missing', `assets/${name}`, `Bytes for ${asset.key} are missing.`);
      }
    }
  }
}

async function inspectLegacy(
  reader: LocalArchiveReader,
  manifest: Record<string, unknown> | null,
  issues: ArchiveIssue[],
): Promise<LocalArchiveInspection> {
  issue(
    issues,
    'warning',
    'legacy',
    'manifest.json',
    'Legacy archive: the v1 readiness and canonical file-list contract are unavailable.',
  );
  const rows = Array.isArray(manifest?.courses)
    ? manifest.courses.filter((v): v is { id: string; title?: string } => {
        const row = object(v);
        return !!row && typeof row.id === 'string';
      })
    : [];
  const ids = rows.length > 0 ? rows.map((r) => r.id) : await reader.listSaved();
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const courses: ArchiveCourseSummary[] = [];
  for (const id of ids) {
    const raw = await reader.readCourse(id);
    if (!raw) {
      issue(issues, 'error', 'course-missing', `courses/${id}.json`, 'Referenced course file is missing.');
      continue;
    }
    try {
      const doc = courseDocument(parseJson(raw));
      if (!doc) {
        issue(issues, 'error', 'course-shape', `courses/${id}.json`, 'Course JSON must contain {course, lessons}.');
        continue;
      }
      courses.push({
        ...courseSummary(doc, id),
        ...(rowById.get(id)?.title ? { title: rowById.get(id)!.title } : {}),
      });
    } catch (e) {
      issue(issues, 'error', 'course-json', `courses/${id}.json`, `Invalid JSON: ${String(e)}`);
    }
  }
  return {
    kind: 'legacy',
    ready: !issues.some((i) => i.severity === 'error'),
    courses,
    issues,
  };
}

async function inspectArchive(
  reader: LocalArchiveReader,
  selectedCourseIds?: ReadonlySet<string>,
): Promise<LocalArchiveInspection> {
  const issues: ArchiveIssue[] = [];
  const raw = await reader.readManifest();
  if (!raw) {
    const ids = await reader.listSaved();
    if (ids.length === 0) {
      issue(issues, 'error', 'manifest-missing', 'manifest.json', 'Archive manifest is missing.');
      return { kind: 'invalid', ready: false, courses: [], issues };
    }
    return inspectLegacy(reader, null, issues);
  }
  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch (e) {
    issue(issues, 'error', 'manifest-json', 'manifest.json', `Invalid JSON: ${String(e)}`);
    return { kind: 'invalid', ready: false, courses: [], issues };
  }
  const root = object(parsed);
  if (!root) {
    issue(issues, 'error', 'manifest-shape', 'manifest.json', 'Manifest must be a JSON object.');
    return { kind: 'invalid', ready: false, courses: [], issues };
  }
  if (root.format === undefined) return inspectLegacy(reader, root, issues);
  const manifest = parseV1Manifest(root, issues);
  if (!manifest) return { kind: 'invalid', ready: false, courses: [], issues };
  const seen = new Set<string>();
  const byId = new Map<string, LocalArchiveCourseEntryV1>();
  for (const entry of manifest.courses) {
    if (seen.has(entry.id)) {
      issue(issues, 'error', 'course-duplicate', 'manifest.json.courses', `Duplicate course id ${entry.id}.`);
      continue;
    }
    seen.add(entry.id);
    byId.set(entry.id, entry);
  }
  const entries = selectedCourseIds
    ? [...selectedCourseIds].flatMap((id) => {
        const entry = byId.get(id);
        if (entry) return [entry];
        issue(issues, 'error', 'course-missing', 'manifest.json.courses', `Selected course ${id} is not listed in the manifest.`);
        return [];
      })
    : manifest.courses;
  const courses: ArchiveCourseSummary[] = [];
  const assetPresence = new Map<string, Promise<boolean>>();
  for (const entry of entries) {
    const summary = await inspectCourse(
      reader,
      entry,
      issues,
      selectedCourseIds !== undefined,
      assetPresence,
    );
    if (summary) courses.push(summary);
  }
  return {
    kind: 'v1',
    ready: !issues.some((i) => i.severity === 'error'),
    origin: manifest.origin,
    toolVersion: manifest.toolVersion,
    manifest,
    courses,
    issues,
  };
}

/** Lightweight folder readiness check used by the Import screen. It validates
 * manifest structure and file presence only. Export-time hashes are provenance,
 * not an import gate: the operator may intentionally replace local assets. */
export async function inspectLocalArchive(
  reader: LocalArchiveReader,
): Promise<LocalArchiveInspection> {
  return inspectArchive(reader);
}

/** Import-time preflight for only the courses the operator selected. In
 * addition to file presence, parse their JSON and prove every media reference
 * is covered by archived bytes or a recorded source-side failure. */
export async function inspectSelectedArchive(
  reader: LocalArchiveReader,
  courseIds: readonly string[],
): Promise<LocalArchiveInspection> {
  return inspectArchive(reader, new Set(courseIds));
}

export function archiveErrorSummary(inspection: LocalArchiveInspection): string {
  const errors = inspection.issues.filter((i) => i.severity === 'error');
  if (errors.length === 0) return '';
  const first = errors[0]!;
  return `${errors.length} archive error(s); ${first.path}: ${first.message}`;
}
