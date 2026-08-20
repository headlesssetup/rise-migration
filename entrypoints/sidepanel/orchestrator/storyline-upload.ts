// Stage C of the Storyline pipeline: upload staged packages to the TARGET
// Review 360 — split out of storyline.ts (v0.9.0 restructure; storyline.ts
// re-exports this surface, so './storyline' and the orchestrator barrel are
// unchanged).

import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import { findStorylineBlocks } from '@/core/storyline/detect';
import { isKnownLegacyStorylineMeta } from '@/core/storyline/compatibility';
import { md5Base64, md5Hex } from '@/core/storyline/md5';
import type { TabPin } from '@/shared/messaging';
import { pinnedRpc, pinTargetTab } from './import-shared';
import { etaStatus, unwrap, type ProgressEvent } from './shared';
import { defaultRefresh, isAuthError } from './storyline-shared';
// Type-only import back into storyline.ts: erased at compile time, so the
// storyline → storyline-upload re-export edge stays cycle-free at runtime.
import type { StorylineManifestEntry } from './storyline';
import { scanSavedCoursesForStoryline } from './storyline-scan';

/** Base64-encode bytes in chunks (spread would overflow the stack on MB zips). */
function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
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
  /** Known legacy package leaves deliberately excluded from Review upload. */
  legacySkipped: number;
  notAttempted: number;
  aborted?: string;
  errors: Array<{ courseId: string; leaf: string; error: string }>;
}

export interface StorylineUploadDeps {
  /** Upload one zip → {itemId, contentPrefix} (default: background STORYLINE_UPLOAD).
   *  `pin` is the run's tab pin — the background derives the Review-360 socket
   *  host, the bearer and the account user id from that exact tab. */
  uploadOne?: (args: {
    zipB64: string;
    fileName: string;
    md5Base64: string;
    md5Hex: string;
    pin?: TabPin;
  }) => Promise<{ ok: true; itemId: string; contentPrefix: string } | { ok: false; error: string }>;
  refresh?: (pin?: TabPin) => Promise<{ advanced: boolean; valid: boolean; via?: string } | void>;
  /** Resolve the ONE Rise tab this run may use (default: background PIN_RISE_TAB
   *  via pinTargetTab). Injectable for tests. */
  pinTab?: () => Promise<{ pin?: TabPin; blocked?: string }>;
  pacing?: PacingConfig;
  /** Re-upload even if a reviewPrefix is already recorded. */
  force?: boolean;
  /** Restrict the upload to these course ids (the operator's selection), like
   *  the export pass. Omit for the previous behavior: every staged manifest. */
  onlyCourseIds?: Set<string>;
}

/**
 * H5 interim guard: the current upload path rides the whole zip through a
 * base64 `chrome.runtime` message into the service worker (and once more into
 * the Rise tab via `executeScript` args for the S3 PUT) — both ceilings sit
 * around 64MB of MESSAGE, i.e. ~48MB of raw zip. Fail a larger package HERE
 * with a clear error instead of a cryptic messaging failure mid-handshake.
 * TODO(H5): PUT the bytes direct from the panel (like import-shared's
 * panelS3Put) once the background exposes a prepare/commit message pair, then
 * lift this to the memory-bound MAX_UPLOAD_BASE64 ceiling.
 */
export const MAX_UPLOAD_ZIP_BYTES = 48 * 1024 * 1024;

const defaultUploadOne: NonNullable<StorylineUploadDeps['uploadOne']> = async ({ pin, ...args }) => {
  const resp = await pinnedRpc(pin)({ type: 'STORYLINE_UPLOAD', ...args });
  if (resp.type !== 'STORYLINE_UPLOAD_RESULT') return { ok: false, error: 'unexpected response' };
  if (!resp.result.ok) return { ok: false, error: resp.result.error };
  return { ok: true, itemId: resp.result.data.itemId, contentPrefix: resp.result.data.contentPrefix };
};

interface StoredManifest {
  courseId: string;
  title?: string;
  blocks: Array<{
    leaf?: string;
    blockId: string;
    meta?: unknown;
    compatibility?: StorylineManifestEntry['compatibility'];
  }>;
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
 * Runs on the TARGET tab (the account that will own the courses) — the uploaded
 * review items must be reachable by copy_review_item from that account. That tab
 * is PINNED for the whole run (C4), so nothing can retarget it mid-upload.
 */
export async function uploadStorylineToReview360(
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
  deps: StorylineUploadDeps = {},
): Promise<StorylineUploadSummary> {
  const uploadOne = deps.uploadOne ?? defaultUploadOne;
  const refresh = deps.refresh ?? defaultRefresh;
  const pinTab = deps.pinTab ?? (() => pinTargetTab(undefined, onEvent));
  const pacing = deps.pacing ?? DEFAULT_PACING;

  const saved = await storage.listSaved();
  // Scope to the operator's selection when given (mirrors the export pass);
  // default remains every staged manifest on disk.
  const ids = deps.onlyCourseIds ? saved.filter((id) => deps.onlyCourseIds!.has(id)) : saved;
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
    legacySkipped: 0,
    notAttempted: 0,
    errors: [],
  };
  onEvent({
    kind: 'log',
    message: deps.onlyCourseIds
      ? `Uploading staged packages from ${manifests.length} selected course manifest(s) to Review 360…`
      : `Uploading staged packages from ${manifests.length} course manifest(s) to Review 360…`,
  });
  if (!manifests.length) return summary;

  // Flatten to a work-list of unique (courseId, leaf) packages while excluding
  // known legacy packages. Old manifests predate `compatibility`, so also read
  // their saved course metadata; this prevents already-staged 3.42/3.48 ZIPs
  // from being retriggered after this policy ships.
  const work: Array<{ courseId: string; title?: string; leaf: string }> = [];
  for (const m of manifests) {
    const legacyLeaves = new Set<string>();
    for (const block of m.blocks ?? []) {
      if (
        block.leaf &&
        (block.compatibility === 'legacy-unsupported' ||
          isKnownLegacyStorylineMeta(block.meta))
      ) legacyLeaves.add(block.leaf);
    }
    if (typeof storage.readCourse === 'function') {
      const raw = await storage.readCourse(m.courseId);
      if (raw) {
        try {
          for (const block of findStorylineBlocks(unwrap(raw))) {
            if (block.leaf && isKnownLegacyStorylineMeta(block.meta)) {
              legacyLeaves.add(block.leaf);
            }
          }
        } catch {
          // Manifest metadata remains the safe fallback; unfamiliar/corrupt
          // course data is not guessed to be legacy.
        }
      }
    }
    summary.legacySkipped += legacyLeaves.size;
    if (legacyLeaves.size) {
      onEvent({
        kind: 'log',
        message: `${m.title ?? m.courseId}: ${legacyLeaves.size} legacy Storyline package(s) excluded from Review upload.`,
      });
    }
    const seen = new Set<string>();
    for (const block of m.blocks ?? []) {
      const leaf = block.leaf;
      if (!leaf || legacyLeaves.has(leaf) || seen.has(leaf)) continue;
      seen.add(leaf);
      work.push({ courseId: m.courseId, title: m.title, leaf });
    }
  }

  if (!work.length) {
    onEvent({
      kind: 'log',
      message: `Storyline upload: no automatic packages to upload; ${summary.legacySkipped} legacy package(s) flagged for manual replacement.`,
    });
    onEvent({ kind: 'import-status', label: 'Storyline upload complete', etaSeconds: null, done: true });
    return summary;
  }

  // Pin the run to ONE tab BEFORE any upload. These are real writes into the
  // TARGET account's Review 360 (items:create → S3 → items:upload); unpinned, the
  // background re-resolves the active Rise tab per message, so a focused SOURCE
  // tab would create review items in the SOURCE account — which CLAUDE.md forbids
  // outright. No pin ⇒ no uploads, said loudly.
  const { pin, blocked: pinBlocked } = await pinTab();
  if (pinBlocked) {
    summary.aborted = pinBlocked;
    // notAttempted counts PACKAGES (the unit of work), not courses.
    summary.notAttempted = work.length;
    onEvent({
      kind: 'log',
      message: `⛔ ${pinBlocked} Nothing was uploaded: these writes go into the TARGET account's Review 360 and must never be able to land in the source account.`,
    });
    return summary;
  }

  try {
    const r = await refresh(pin);
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

  let aborted = false;
  const runStart = Date.now();
  for (let i = 0; i < work.length; i++) {
    if (aborted) {
      summary.notAttempted += 1;
      continue;
    }
    const { courseId, title, leaf } = work[i]!;
    const label = `[${i + 1}/${work.length}]`;
    onEvent({ kind: 'course', index: i, total: work.length, courseId, title });
    onEvent(
      etaStatus({
        label: `Uploading ${i + 1}/${work.length}`,
        doneFraction: i / work.length,
        runStartMs: runStart,
        nowMs: Date.now(),
      }),
    );

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

    // Pre-flight size guard (see MAX_UPLOAD_ZIP_BYTES): fail loudly BEFORE the
    // base64 message hop would fail cryptically (or crash the SW).
    if (bytes.length > MAX_UPLOAD_ZIP_BYTES) {
      const mb = (bytes.length / (1024 * 1024)).toFixed(1);
      const capMb = Math.round(MAX_UPLOAD_ZIP_BYTES / (1024 * 1024));
      const error = `package too large for the current upload path (${mb} MB > ${capMb} MB base64-message cap)`;
      summary.failed += 1;
      summary.errors.push({ courseId, leaf, error });
      onEvent({ kind: 'log', message: `${label} ${leaf}: FAILED — ${error}` });
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
        pin,
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
    message: `Storyline upload: ${summary.uploaded} uploaded, ${summary.skipped} skipped, ${summary.failed} failed${summary.notAttempted ? `, ${summary.notAttempted} not attempted` : ''} of ${work.length} automatic package(s); ${summary.legacySkipped} legacy package(s) flagged.`,
  });
  onEvent({ kind: 'import-status', label: 'Storyline upload complete', etaSeconds: null, done: true });
  return summary;
}
