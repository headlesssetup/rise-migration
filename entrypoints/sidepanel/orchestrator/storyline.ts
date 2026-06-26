// Export-D: Storyline package pipeline (panel side).
//
// Two passes:
//  - scanSavedCoursesForStoryline(): OFFLINE — walk the saved GET_COURSE archive
//    and report which courses contain Storyline/Mighty blocks (the ones that need
//    the zip pipeline). No network, no Rise tab.
//  - exportStorylinePackages(): LIVE — for each such course, trigger the Rise
//    web/raw export (background owns the bearer + ws.eu socket), download the zip
//    from the CDN, repackage each Storyline leaf into a Review-360 upload zip, and
//    store it under storyline/<courseId>/<leaf>.zip with a per-course manifest.
//
// Pacing: the build trigger is an authoring write, so courses are processed
// strictly sequentially with a ~2s gap (the background does the build+await; we
// pace BETWEEN courses). The zip download is a public-CDN byte transfer — outside
// the pacing invariant.

import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import { findStorylineBlocks, type StorylineBlockRef } from '@/core/storyline/detect';
import { md5Base64, md5Hex } from '@/core/storyline/md5';
import {
  buildReview360Zip,
  extractPackage,
  unzipToMap,
} from '@/core/storyline/package-zip';
import { rpc } from '../rpc';
import { unwrap, type ProgressEvent } from './shared';

/** Base64-encode bytes in chunks (spread would overflow the stack on MB zips). */
function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

export interface StorylineCourseScan {
  courseId: string;
  title?: string;
  blocks: StorylineBlockRef[];
}

/** Read `course.title` from a saved doc, tolerant of nesting. */
function courseTitle(doc: unknown): string | undefined {
  const c = (doc as { course?: { title?: unknown } })?.course;
  return typeof c?.title === 'string' ? c.title : undefined;
}

/**
 * OFFLINE scan: which saved courses contain Storyline blocks. Drives the
 * Export-D inventory display + the export work-list. Per-course [i/N] progress.
 */
export async function scanSavedCoursesForStoryline(
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
  /** Restrict the scan to these course ids (the operator's selection). When
   *  omitted, scans every saved course. */
  onlyCourseIds?: Set<string>,
): Promise<StorylineCourseScan[]> {
  const saved = await storage.listSaved();
  const ids = onlyCourseIds ? saved.filter((id) => onlyCourseIds.has(id)) : saved;
  onEvent({
    kind: 'log',
    message: onlyCourseIds
      ? `Scanning ${ids.length} selected course(s) for Storyline blocks…`
      : `Scanning ${ids.length} saved course(s) for Storyline blocks…`,
  });
  const out: StorylineCourseScan[] = [];
  for (let i = 0; i < ids.length; i++) {
    const courseId = ids[i]!;
    const raw = await storage.readCourse(courseId);
    if (!raw) continue;
    let doc: unknown;
    try {
      doc = unwrap(raw);
    } catch {
      onEvent({ kind: 'log', message: `[${i + 1}/${ids.length}] ${courseId}: unreadable, skipped` });
      continue;
    }
    const blocks = findStorylineBlocks(doc);
    if (blocks.length) {
      out.push({ courseId, title: courseTitle(doc), blocks });
      onEvent({
        kind: 'log',
        message: `[${i + 1}/${ids.length}] ${courseTitle(doc) ?? courseId}: ${blocks.length} storyline block(s)`,
      });
    }
  }
  onEvent({
    kind: 'log',
    message: `Storyline scan: ${out.length}/${ids.length} course(s) contain storyline blocks.`,
  });
  return out;
}

/** One entry in a course's storyline manifest — the import attach join key. */
export interface StorylineManifestEntry {
  blockId: string;
  lessonId: string;
  itemId?: string;
  leaf: string;
  meta?: unknown;
  /** Stored Review-360 upload zip, relative to the archive root. */
  zip: string;
}

export interface StorylineExportSummary {
  courses: number;
  packaged: number;
  skipped: number;
  failed: number;
  /** Courses not attempted because the run aborted early (e.g. auth). */
  notAttempted: number;
  /** Set when the run aborted early; the reason (shown to the operator). */
  aborted?: string;
  /** Per-course failures (courseId → message) for the report. */
  errors: Array<{ courseId: string; error: string }>;
}

/** Public CDN fetch of the export zip (default; injectable for tests). */
async function defaultFetchZip(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`zip download HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** A build failure that's about auth/freshness affects EVERY course, so we abort
 *  the whole run rather than reload-and-retry 152 times. */
function isAuthError(msg: string): boolean {
  return /\b40[13]\b|forbidden|unauthor|expired|\btoken\b|session/i.test(msg);
}

export interface StorylineExportDeps {
  /** Trigger build + await the zip URL (default: background STORYLINE_EXPORT). */
  exportOne?: (
    courseId: string,
    title: string,
  ) => Promise<{ ok: true; location: string; jobId: string } | { ok: false; error: string }>;
  fetchZip?: (url: string) => Promise<Uint8Array>;
  /** Refresh the bearer/cookie once before the run (default: background REAUTH). */
  refresh?: () => Promise<{ advanced: boolean; valid: boolean; via?: string } | void>;
  pacing?: PacingConfig;
  /** Re-export even if a manifest already exists (default false → resume/skip). */
  force?: boolean;
  /** Restrict to these course ids (the operator's selection); omit for all. */
  onlyCourseIds?: Set<string>;
}

const defaultExportOne: NonNullable<StorylineExportDeps['exportOne']> = async (courseId, title) => {
  const resp = await rpc({ type: 'STORYLINE_EXPORT', courseId, title });
  if (resp.type !== 'STORYLINE_EXPORT_RESULT') return { ok: false, error: 'unexpected response' };
  if (!resp.result.ok) return { ok: false, error: resp.result.error };
  return { ok: true, location: resp.result.data.location, jobId: resp.result.data.jobId };
};

const defaultRefresh: NonNullable<StorylineExportDeps['refresh']> = async () => {
  const r = await rpc({ type: 'REAUTH' });
  return r.type === 'REAUTH_RESULT' ? { advanced: r.advanced, valid: r.valid, via: r.via } : undefined;
};

/**
 * LIVE: export + repackage + store Storyline packages for every saved course
 * that needs it. Sequential + paced (build is an authoring write); zip downloads
 * are direct CDN fetches. Resumable: a course with an existing manifest is
 * skipped unless `force`. Aborts the whole run on the first auth failure (a
 * stale session affects every course) so it never grinds — telling the operator
 * to open a Rise course editor (the only thing that rotates the cookie) + retry.
 */
export async function exportStorylinePackages(
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
  deps: StorylineExportDeps = {},
): Promise<StorylineExportSummary> {
  const exportOne = deps.exportOne ?? defaultExportOne;
  const fetchZip = deps.fetchZip ?? defaultFetchZip;
  const refresh = deps.refresh ?? defaultRefresh;
  const pacing = deps.pacing ?? DEFAULT_PACING;

  const targets = await scanSavedCoursesForStoryline(storage, onEvent, deps.onlyCourseIds);
  const summary: StorylineExportSummary = {
    courses: targets.length,
    packaged: 0,
    skipped: 0,
    failed: 0,
    notAttempted: 0,
    errors: [],
  };
  if (!targets.length) return summary;

  // Proper auth BEFORE any action: refresh once up front and abort if the token
  // can't be made valid — a stale session fails every export, so don't attempt.
  try {
    const r = await refresh();
    if (r) onEvent({ kind: 'log', message: `Token refresh: ${r.valid ? 'valid' : 'INVALID'}${r.via ? ` (via ${r.via})` : ''}.` });
    if (r && r.valid === false) {
      summary.aborted = 'stale session token';
      summary.notAttempted = targets.length;
      onEvent({
        kind: 'log',
        message:
          '⛔ Session token is stale and could not be refreshed. Open a Rise COURSE EDITOR (any course, not the dashboard) on the SOURCE account, keep it focused, then run again.',
      });
      return summary;
    }
  } catch {
    /* best-effort — proceed and let the first course surface any auth issue */
  }

  for (let i = 0; i < targets.length; i++) {
    const { courseId, title, blocks } = targets[i]!;
    const label = `[${i + 1}/${targets.length}]`;
    onEvent({ kind: 'course', index: i, total: targets.length, courseId, title });

    if (!deps.force && (await storage.readStorylineManifest(courseId))) {
      summary.skipped += 1;
      onEvent({ kind: 'log', message: `${label} ${title ?? courseId}: already exported, skipped` });
      continue;
    }

    if (i > 0) await pacedDelay(pacing); // pace between course builds (authoring write)

    try {
      onEvent({ kind: 'log', message: `${label} ${title ?? courseId}: triggering web export…` });
      const res = await exportOne(courseId, title ?? courseId);
      if (!res.ok) throw new Error(res.error);

      onEvent({ kind: 'log', message: `${label} downloading package zip…` });
      const webZip = await fetchZip(res.location);
      const files = unzipToMap(webZip);

      // Repackage each storyline block's leaf into a Review-360 upload zip.
      const entries: StorylineManifestEntry[] = [];
      const leavesDone = new Set<string>();
      for (const b of blocks) {
        if (!b.leaf) {
          onEvent({ kind: 'log', message: `${label} block ${b.blockId}: no source leaf (placeholder), skipped` });
          continue;
        }
        if (!leavesDone.has(b.leaf)) {
          const zip = buildReview360Zip(extractPackage(files, b.leaf));
          await storage.writeStorylineZip(courseId, b.leaf, zip);
          leavesDone.add(b.leaf);
        }
        entries.push({
          blockId: b.blockId,
          lessonId: b.lessonId,
          itemId: b.itemId,
          leaf: b.leaf,
          meta: b.meta,
          zip: `storyline/${courseId}/${b.leaf}.zip`,
        });
      }

      await storage.writeStorylineManifest(
        courseId,
        JSON.stringify({ courseId, title, jobId: res.jobId, blocks: entries }, null, 2),
      );
      summary.packaged += 1;
      onEvent({
        kind: 'log',
        message: `${label} ${title ?? courseId}: ${leavesDone.size} package(s) → storyline/${courseId}/`,
      });
    } catch (e) {
      const error = (e as Error).message;
      summary.failed += 1;
      summary.errors.push({ courseId, error });
      onEvent({ kind: 'log', message: `${label} ${title ?? courseId}: FAILED — ${error}` });

      // A stale session 403s every build — abort instead of looping 152×.
      if (isAuthError(error)) {
        summary.aborted = error;
        summary.notAttempted = targets.length - (i + 1);
        onEvent({
          kind: 'log',
          message: `⛔ Aborting: looks like an auth/session failure. Open a Rise COURSE EDITOR (not the dashboard) to rotate the token, then run again. ${summary.notAttempted} course(s) not attempted.`,
        });
        break;
      }
    }
  }

  onEvent({
    kind: 'log',
    message: `Storyline export: ${summary.packaged} packaged, ${summary.skipped} skipped, ${summary.failed} failed${summary.notAttempted ? `, ${summary.notAttempted} not attempted` : ''} of ${summary.courses} course(s).`,
  });
  return summary;
}

// --- Stage C: upload staged packages to the TARGET Review 360 -----------------

/** Per-leaf upload record folded back into the course manifest (the import
 *  attach reads `reviewPrefix` from here). */
export interface StorylineUploadRecord {
  itemId: string;
  reviewPrefix: string;
}

export interface StorylineUploadSummary {
  /** Course manifests scanned. */
  courses: number;
  /** Packages (leaves) uploaded this run. */
  uploaded: number;
  /** Packages already uploaded (resume). */
  skipped: number;
  failed: number;
  notAttempted: number;
  aborted?: string;
  errors: Array<{ courseId: string; leaf: string; error: string }>;
}

export interface StorylineUploadDeps {
  /** Upload one zip → {itemId, contentPrefix} (default: background STORYLINE_UPLOAD). */
  uploadOne?: (args: {
    zipB64: string;
    fileName: string;
    md5Base64: string;
    md5Hex: string;
  }) => Promise<{ ok: true; itemId: string; contentPrefix: string } | { ok: false; error: string }>;
  refresh?: () => Promise<{ advanced: boolean; valid: boolean; via?: string } | void>;
  pacing?: PacingConfig;
  /** Re-upload even if a reviewPrefix is already recorded. */
  force?: boolean;
}

const defaultUploadOne: NonNullable<StorylineUploadDeps['uploadOne']> = async (args) => {
  const resp = await rpc({ type: 'STORYLINE_UPLOAD', ...args });
  if (resp.type !== 'STORYLINE_UPLOAD_RESULT') return { ok: false, error: 'unexpected response' };
  if (!resp.result.ok) return { ok: false, error: resp.result.error };
  return { ok: true, itemId: resp.result.data.itemId, contentPrefix: resp.result.data.contentPrefix };
};

interface StoredManifest {
  courseId: string;
  title?: string;
  blocks: Array<{ leaf: string; blockId: string }>;
  uploads?: Record<string, StorylineUploadRecord>;
  [k: string]: unknown;
}

/**
 * Upload every staged storyline package to the TARGET account's Review 360 and
 * record each `review/items/{leaf}` prefix back into the course manifest (the
 * join key the import attach feeds to copy_review_item). Sequential + paced (the
 * socket handshake is authoring-like); resumable (a leaf with a recorded
 * reviewPrefix is skipped); aborts on an auth failure like the export pass.
 *
 * Run this on the TARGET tab (the account that will own the courses) — the
 * uploaded review items must be reachable by copy_review_item from that account.
 */
export async function uploadStorylineToReview360(
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
  deps: StorylineUploadDeps = {},
): Promise<StorylineUploadSummary> {
  const uploadOne = deps.uploadOne ?? defaultUploadOne;
  const refresh = deps.refresh ?? (async () => {
    const r = await rpc({ type: 'REAUTH' });
    return r.type === 'REAUTH_RESULT' ? { advanced: r.advanced, valid: r.valid, via: r.via } : undefined;
  });
  const pacing = deps.pacing ?? DEFAULT_PACING;

  const ids = await storage.listSaved();
  const manifests: StoredManifest[] = [];
  for (const id of ids) {
    const raw = await storage.readStorylineManifest(id);
    if (!raw) continue;
    try {
      manifests.push(JSON.parse(raw) as StoredManifest);
    } catch {
      onEvent({ kind: 'log', message: `${id}: unreadable storyline manifest, skipped` });
    }
  }

  const summary: StorylineUploadSummary = {
    courses: manifests.length,
    uploaded: 0,
    skipped: 0,
    failed: 0,
    notAttempted: 0,
    errors: [],
  };
  onEvent({ kind: 'log', message: `Uploading staged packages from ${manifests.length} course manifest(s) to Review 360…` });
  if (!manifests.length) return summary;

  try {
    const r = await refresh();
    if (r) onEvent({ kind: 'log', message: `Token refresh: ${r.valid ? 'valid' : 'INVALID'}${r.via ? ` (via ${r.via})` : ''}.` });
    if (r && r.valid === false) {
      summary.aborted = 'stale session token';
      onEvent({
        kind: 'log',
        message:
          '⛔ Session token is stale and could not be refreshed. Open a Rise COURSE EDITOR (any course, not the dashboard) on the TARGET account, keep it focused, then run again.',
      });
      return summary;
    }
  } catch {
    /* best-effort */
  }

  // Flatten to a work-list of unique (courseId, leaf) packages.
  const work: Array<{ courseId: string; title?: string; leaf: string }> = [];
  for (const m of manifests) {
    const seen = new Set<string>();
    for (const b of m.blocks ?? []) {
      if (!b.leaf || seen.has(b.leaf)) continue;
      seen.add(b.leaf);
      work.push({ courseId: m.courseId, title: m.title, leaf: b.leaf });
    }
  }

  let aborted = false;
  for (let i = 0; i < work.length; i++) {
    if (aborted) {
      summary.notAttempted += 1;
      continue;
    }
    const { courseId, title, leaf } = work[i]!;
    const label = `[${i + 1}/${work.length}]`;
    onEvent({ kind: 'course', index: i, total: work.length, courseId, title });

    const manifest = manifests.find((m) => m.courseId === courseId)!;
    if (!deps.force && manifest.uploads?.[leaf]?.reviewPrefix) {
      summary.skipped += 1;
      continue;
    }

    const bytes = await storage.readStorylineZip(courseId, leaf);
    if (!bytes) {
      summary.failed += 1;
      summary.errors.push({ courseId, leaf, error: 'package zip missing on disk' });
      onEvent({ kind: 'log', message: `${label} ${leaf}: FAILED — package zip missing` });
      continue;
    }

    if (summary.uploaded + summary.failed > 0) await pacedDelay(pacing);

    try {
      onEvent({ kind: 'log', message: `${label} ${title ?? courseId} / ${leaf}: uploading…` });
      const res = await uploadOne({
        zipB64: toBase64(bytes),
        fileName: `${leaf}.zip`,
        md5Base64: md5Base64(bytes),
        md5Hex: md5Hex(bytes),
      });
      if (!res.ok) throw new Error(res.error);

      manifest.uploads = manifest.uploads ?? {};
      manifest.uploads[leaf] = { itemId: res.itemId, reviewPrefix: res.contentPrefix };
      await storage.writeStorylineManifest(courseId, JSON.stringify(manifest, null, 2));
      summary.uploaded += 1;
      onEvent({ kind: 'log', message: `${label} ${leaf}: → ${res.contentPrefix}` });
    } catch (e) {
      const error = (e as Error).message;
      summary.failed += 1;
      summary.errors.push({ courseId, leaf, error });
      onEvent({ kind: 'log', message: `${label} ${leaf}: FAILED — ${error}` });
      if (isAuthError(error)) {
        aborted = true;
        summary.aborted = error;
        onEvent({ kind: 'log', message: `⛔ Aborting: auth/session failure. Open a Rise course editor on the TARGET account to refresh, then retry.` });
      }
    }
  }

  onEvent({
    kind: 'log',
    message: `Storyline upload: ${summary.uploaded} uploaded, ${summary.skipped} skipped, ${summary.failed} failed${summary.notAttempted ? `, ${summary.notAttempted} not attempted` : ''} of ${work.length} package(s).`,
  });
  return summary;
}
