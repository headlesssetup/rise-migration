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
  /** The Review 360 item name the item carries after our post-publish rename
   *  (v0.9.14e). Absent on older records → the repair pass renames them. */
  title?: string;
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
    /** The Review 360 item name to create the item with (the source block's
     *  `media.storyline.title`); absent → the zip file name, which the server
     *  then replaces with the package's internal project title. */
    title?: string;
    md5Base64: string;
    md5Hex: string;
    pin?: TabPin;
  }) => Promise<
    | { ok: true; itemId: string; contentPrefix: string; title?: string; renameError?: string }
    | { ok: false; error: string }
  >;
  /** Rename one existing Review item (default: background STORYLINE_RENAME). */
  renameOne?: (args: { itemId: string; title: string; pin?: TabPin }) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
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
  const { itemId, contentPrefix, title, renameError } = resp.result.data;
  return { ok: true, itemId, contentPrefix, title, renameError };
};

const defaultRenameOne: NonNullable<StorylineUploadDeps['renameOne']> = async ({ pin, ...args }) => {
  const resp = await pinnedRpc(pin)({ type: 'STORYLINE_RENAME', ...args });
  if (resp.type !== 'STORYLINE_RENAME_RESULT') return { ok: false, error: 'unexpected response' };
  if (!resp.result.ok) return { ok: false, error: resp.result.error };
  return { ok: true };
};

interface StoredManifest {
  courseId: string;
  title?: string;
  blocks: Array<{
    leaf?: string;
    blockId: string;
    meta?: unknown;
    title?: string;
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
  const work: Array<{ courseId: string; title?: string; leaf: string; itemTitle?: string }> = [];
  for (const m of manifests) {
    const legacyLeaves = new Set<string>();
    const itemTitleByLeaf = manifestTitlesByLeaf(m);
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
            if (block.leaf && block.title && !itemTitleByLeaf.has(block.leaf)) {
              itemTitleByLeaf.set(block.leaf, block.title);
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
      const itemTitle = itemTitleByLeaf.get(leaf) ?? metaTitleOf(block.meta);
      work.push({ courseId: m.courseId, title: m.title, leaf, itemTitle });
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
    const { courseId, title, leaf, itemTitle } = work[i]!;
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
      onEvent({
        kind: 'log',
        message: `${label} ${title ?? courseId} / ${leaf}: uploading${itemTitle ? ` as "${itemTitle}"` : ''}…`,
      });
      const res = await uploadOne({
        zipB64: toBase64(bytes),
        fileName: `${leaf}.zip`,
        ...(itemTitle ? { title: itemTitle } : {}),
        md5Base64: md5Base64(bytes),
        md5Hex: md5Hex(bytes),
        pin,
      });
      if (!res.ok) throw new Error(res.error);

      manifest.uploads = manifest.uploads ?? {};
      manifest.uploads[leaf] = {
        itemId: res.itemId,
        reviewPrefix: res.contentPrefix,
        ...(res.title ? { title: res.title } : {}),
      };
      await storage.writeStorylineManifest(courseId, JSON.stringify(manifest, null, 2));
      summary.uploaded += 1;
      onEvent({
        kind: 'log',
        message: `${label} ${leaf}: → ${res.contentPrefix}${res.title ? ` (renamed to "${res.title}")` : ''}${
          res.renameError ? ` ⚠ rename failed: ${res.renameError} — run "Rename uploaded Review items"` : ''
        }`,
      });
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

// --- Review item titles ------------------------------------------------------

/** Review item name per leaf: the manifest's recorded block title (Stage B
 *  since v0.9.14d), else the live course doc's `media.storyline.title` (older
 *  manifests, merged in by the caller), else the package's internal `meta.title`. */
function manifestTitlesByLeaf(m: StoredManifest): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of m.blocks ?? []) {
    if (block.leaf && block.title) out.set(block.leaf, block.title);
  }
  return out;
}

function metaTitleOf(meta: unknown): string | undefined {
  const t = meta && typeof meta === 'object' ? (meta as { title?: unknown }).title : undefined;
  return typeof t === 'string' && t ? t : undefined;
}

export interface StorylineRenameSummary {
  courses: number;
  renamed: number;
  skipped: number;
  failed: number;
  errors: { courseId: string; leaf: string; error: string }[];
}

/**
 * Repair pass: rename every already-uploaded Review 360 item of the selected
 * courses to its block's title. Items uploaded before v0.9.14e all show the
 * package's internal project title ("Untitled1" ×13, live DFO 2026-10-20). A
 * record whose `title` already equals the target is skipped (idempotent); the
 * rename result is written back to the manifest. Paced like every other
 * authoring-side loop; one socket per rename (the background's contract).
 */
export async function renameReviewItemsToBlockTitles(
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
  deps: Pick<StorylineUploadDeps, 'renameOne' | 'pinTab' | 'pacing' | 'onlyCourseIds'> = {},
): Promise<StorylineRenameSummary> {
  const renameOne = deps.renameOne ?? defaultRenameOne;
  const pacing = deps.pacing ?? DEFAULT_PACING;
  const summary: StorylineRenameSummary = { courses: 0, renamed: 0, skipped: 0, failed: 0, errors: [] };
  const { pin, blocked } = await (deps.pinTab ?? (() => pinTargetTab(undefined, onEvent)))();
  if (blocked) {
    onEvent({ kind: 'log', message: `BLOCKED — ${blocked}` });
    return summary;
  }
  const saved = await storage.listSaved();
  const ids = deps.onlyCourseIds ? saved.filter((id) => deps.onlyCourseIds!.has(id)) : saved;
  const work: { courseId: string; leaf: string; itemId: string; title: string; manifest: StoredManifest }[] = [];
  for (const courseId of ids) {
    const raw = await storage.readStorylineManifest(courseId);
    if (!raw) continue;
    let m: StoredManifest;
    try {
      m = JSON.parse(raw) as StoredManifest;
    } catch {
      continue;
    }
    if (!m.uploads || Object.keys(m.uploads).length === 0) continue;
    summary.courses += 1;
    const titles = manifestTitlesByLeaf(m);
    if (typeof storage.readCourse === 'function') {
      const doc = await storage.readCourse(courseId);
      if (doc) {
        try {
          for (const b of findStorylineBlocks(unwrap(doc))) {
            if (b.leaf && b.title && !titles.has(b.leaf)) titles.set(b.leaf, b.title);
          }
        } catch {
          /* manifest titles remain the fallback */
        }
      }
    }
    for (const [leaf, rec] of Object.entries(m.uploads)) {
      // No `meta.title` fallback here: that IS the name the server already gave
      // the item, so renaming to it would be a wasted call.
      const title = titles.get(leaf);
      if (!title || !rec.itemId) {
        summary.skipped += 1;
        continue;
      }
      if (rec.title === title) {
        summary.skipped += 1;
        continue;
      }
      work.push({ courseId, leaf, itemId: rec.itemId, title, manifest: m });
    }
  }
  onEvent({ kind: 'log', message: `Renaming ${work.length} Review 360 item(s) across ${summary.courses} course manifest(s)…` });
  for (const [i, w] of work.entries()) {
    const label = `[${i + 1}/${work.length}]`;
    if (i > 0) await pacedDelay(pacing);
    const res = await renameOne({ itemId: w.itemId, title: w.title, pin });
    if (!res.ok) {
      summary.failed += 1;
      summary.errors.push({ courseId: w.courseId, leaf: w.leaf, error: res.error });
      onEvent({ kind: 'log', message: `${label} ${w.leaf}: FAILED — ${res.error}` });
      continue;
    }
    w.manifest.uploads![w.leaf] = { ...w.manifest.uploads![w.leaf]!, title: w.title };
    await storage.writeStorylineManifest(w.courseId, JSON.stringify(w.manifest, null, 2));
    summary.renamed += 1;
    onEvent({ kind: 'log', message: `${label} ${w.leaf}: renamed to "${w.title}"` });
  }
  onEvent({
    kind: 'log',
    message: `Rename: ${summary.renamed} renamed, ${summary.skipped} skipped (already named / no title), ${summary.failed} failed.`,
  });
  return summary;
}
