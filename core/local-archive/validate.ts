import { collectAssetKeys, sha256Hex } from '@/core/assets';
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
  const raw = await reader.readCourse(entry.id);
  if (!raw) {
    issue(issues, 'error', 'course-missing', expectedFile, 'Referenced course file is missing.');
    return null;
  }
  const actualHash = await sha256Hex(new TextEncoder().encode(raw));
  if (actualHash !== entry.sha256) {
    issue(
      issues,
      'error',
      'course-hash',
      expectedFile,
      `Course checksum mismatch: expected ${entry.sha256}, found ${actualHash}.`,
    );
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
  await inspectAssets(reader, entry, doc, issues);
  return {
    ...courseSummary(doc, entry.id),
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    ...(entry.type !== undefined ? { type: entry.type } : {}),
  };
}

async function inspectAssets(
  reader: LocalArchiveReader,
  entry: LocalArchiveCourseEntryV1,
  doc: GetCourseDocument,
  issues: ArchiveIssue[],
): Promise<void> {
  const referenced = collectAssetKeys(doc, entry.id);
  const path = `courses/${entry.id}.assets.json`;
  const raw = await reader.readAssetManifest('courses', entry.id);
  if (!raw) {
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
  if (!entry.assetManifestSha256) {
    issue(issues, 'error', 'course-entry', path, 'Asset manifest checksum is missing from manifest.json.');
  } else {
    const hash = await sha256Hex(new TextEncoder().encode(raw));
    if (hash !== entry.assetManifestSha256) {
      issue(issues, 'error', 'asset-manifest-hash', path, 'Asset manifest checksum does not match.');
    }
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
  const declared = new Set<string>();
  for (const [i, asset] of manifest.assets.entries()) {
    if (!asset || typeof asset.key !== 'string' || typeof asset.hash !== 'string' || !SHA256.test(asset.hash)) {
      issue(issues, 'error', 'asset-manifest-shape', `${path}#assets[${i}]`, 'Asset row is invalid.');
      continue;
    }
    declared.add(asset.key);
    const name = String(asset.file ?? '').replace(/^assets\//, '');
    const bytes = name ? await reader.readAsset(name) : null;
    if (!bytes) {
      issue(issues, 'error', 'asset-missing', `assets/${name}`, `Bytes for ${asset.key} are missing.`);
      continue;
    }
    const hash = await sha256Hex(bytes);
    if (hash !== asset.hash) {
      issue(issues, 'error', 'asset-hash', `assets/${name}`, `Asset checksum mismatch for ${asset.key}.`);
    }
  }
  const terminal = new Set((manifest.failed ?? []).map((f) => f.key));
  for (const ref of referenced) {
    if (!declared.has(ref.key) && !terminal.has(ref.key)) {
      issue(
        issues,
        'error',
        'asset-missing',
        ref.paths[0] ?? path,
        `Referenced media ${ref.key} has no asset bytes or recorded failure.`,
      );
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
    'Legacy archive: file checksums and the v1 readiness marker are unavailable.',
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

export async function inspectLocalArchive(
  reader: LocalArchiveReader,
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
  const courses: ArchiveCourseSummary[] = [];
  for (const entry of manifest.courses) {
    if (seen.has(entry.id)) {
      issue(issues, 'error', 'course-duplicate', 'manifest.json.courses', `Duplicate course id ${entry.id}.`);
      continue;
    }
    seen.add(entry.id);
    const summary = await inspectCourse(reader, entry, issues);
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

export function archiveErrorSummary(inspection: LocalArchiveInspection): string {
  const errors = inspection.issues.filter((i) => i.severity === 'error');
  if (errors.length === 0) return '';
  const first = errors[0]!;
  return `${errors.length} archive error(s); ${first.path}: ${first.message}`;
}
