// Export-D: Storyline package pipeline (panel side).
//
// Two passes:
//  - scanSavedCoursesForStoryline(): OFFLINE — walk the saved GET_COURSE archive
//    and report which courses contain Storyline/Mighty blocks (the ones that need
//    the zip pipeline). No network, no Rise tab.
//  - exportStorylinePackages(): LIVE — for each such course, trigger the Rise
//    web/raw export (background owns the bearer + ws.eu socket), download the zip
//    from the CDN, repackage modern leaves into Review-360 upload zips under
//    storyline/<courseId>/<leaf>.zip, preserve legacy leaves without transform
//    under storyline-legacy/<courseId>/<leaf>.zip, and write one manifest that
//    keeps the two stores unambiguous.
//
// Pacing: the build trigger is an authoring write, so courses are processed
// strictly sequentially with a ~2s gap (the background does the build+await; we
// pace BETWEEN courses). The zip download is a public-CDN byte transfer — outside
// the pacing invariant.

import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import { findStorylineBlocks, type StorylineBlockRef } from '@/core/storyline/detect';
import {
  isKnownLegacyStorylineMeta,
  LEGACY_STORYLINE_IMPORTABILITY,
} from '@/core/storyline/compatibility';
import {
  inventoryToCsv,
  inventoryToJson,
  withImportability,
  type InventoryRow,
} from '@/core/census/inventory';
import { md5Base64, md5Hex } from '@/core/storyline/md5';
import {
  buildPreservedPackageZip,
  buildReview360Zip,
  extractPackage,
  getRuntimeDataJs,
  listPackageLeaves,
  unzipToMap,
} from '@/core/storyline/package-zip';
import { parseWebExportRuntimeData } from '@/core/storyline/web-export';
import type { TabPin } from '@/shared/messaging';
import { pinnedRpc, pinTargetTab } from './import-shared';
import { nowStamp } from '../log-lines';
import { courseRef, etaStatus, unwrap, type ProgressEvent } from './shared';



/** One entry in a course's storyline manifest — the import attach join key. */
export interface StorylineManifestEntry {
  blockId: string;
  lessonId: string;
  itemId?: string;
  leaf?: string;
  meta?: unknown;
  /** The block's Review 360 item name (`media.storyline.title`) — what Stage C
   *  names the uploaded item, so the target library does not show the
   *  package's internal project title ("Untitled1" ×13, live DFO 2026-10-20). */
  title?: string;
  /** Stored Review-360 upload zip, relative to the archive root. */
  zip?: string;
  /** Preserved legacy runtime package, outside the uploadable store. */
  archiveZip?: string;
  /** Explicit policy result; legacy entries are reports, never upload work. */
  compatibility?: 'automatic' | 'legacy-unsupported' | 'source-placeholder';
  /** STACK only (docs/rise-multilang.md §4.3b): the language this package
   *  belongs to, and the l10n cell that holds it. One block can have one entry
   *  per language, each with its own leaf. Absent on monolingual courses. */
  locale?: string;
  l10nId?: string;
}

export interface StorylineExportSummary {
  courses: number;
  packaged: number;
  skipped: number;
  failed: number;
  /** Individual legacy package refs deliberately not repackaged/uploaded. */
  legacySkipped: number;
  /** Distinct legacy package leaves preserved to `storyline-legacy/`. */
  legacySaved: number;
  /** Courses not attempted because the run aborted early (e.g. auth). */
  notAttempted: number;
  /** Courses whose saved permissions forbid the web export — never built;
   *  a manual-review manifest is written instead (counted in `skipped` too). */
  notExportable: number;
  /** Set when the run aborted early; the reason (shown to the operator). */
  aborted?: string;
  /** Per-course failures (courseId → message) for the report. */
  errors: Array<{ courseId: string; title?: string; error: string }>;
}

/** Public CDN fetch of the export zip (default; injectable for tests). */
async function defaultFetchZip(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`zip download HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}


export interface StorylineExportDeps {
  /** Trigger build + await the zip URL (default: background STORYLINE_EXPORT). */
  exportOne?: (
    courseId: string,
    title: string,
    pin?: TabPin,
  ) => Promise<{ ok: true; location: string; jobId: string } | { ok: false; error: string }>;
  fetchZip?: (url: string) => Promise<Uint8Array>;
  /** Refresh the bearer/cookie once before the run. `courseId` lets the
   *  background boot a temporary editor when only the dashboard is open. */
  refresh?: (
    pin?: TabPin,
    courseId?: string,
  ) => Promise<{ advanced: boolean; valid: boolean; via?: string } | void>;
  /** Resolve the ONE Rise tab this run may use (default: background PIN_RISE_TAB
   *  via pinTargetTab). Injectable for tests. */
  pinTab?: () => Promise<{ pin?: TabPin; blocked?: string }>;
  pacing?: PacingConfig;
  /** Re-export even if a manifest already exists (default false → resume/skip). */
  force?: boolean;
  /** Restrict to these course ids (the operator's selection); omit for all. */
  onlyCourseIds?: Set<string>;
}

/** A manifest entry for a package that was NOT staged (no zip path). */
function manifestEntryWithoutZip(block: StorylineBlockRef): StorylineManifestEntry {
  return {
    blockId: block.blockId,
    lessonId: block.lessonId,
    itemId: block.itemId,
    leaf: block.leaf,
    meta: block.meta,
    ...(block.title ? { title: block.title } : {}),
    compatibility: isKnownLegacyStorylineMeta(block.meta)
      ? 'legacy-unsupported'
      : 'source-placeholder',
    ...(block.locale ? { locale: block.locale } : {}),
    ...(block.l10nId ? { l10nId: block.l10nId } : {}),
  };
}

/** Rebuild a manifest's `blocks` for a course that cannot be exported NOW:
 *  an entry the previous manifest already STAGED (a `zip` or `archiveZip` on
 *  disk, from a run when this account could export) is kept verbatim, every
 *  other block gets a no-zip entry. Keyed by block + locale (a stack carries one
 *  entry per language). Returns how many were kept. */
function mergeStagedEntries(
  previous: Record<string, unknown> | undefined,
  blocks: StorylineBlockRef[],
): { entries: StorylineManifestEntry[]; kept: number } {
  const staged = new Map<string, StorylineManifestEntry>();
  const prevBlocks = Array.isArray(previous?.blocks) ? (previous!.blocks as StorylineManifestEntry[]) : [];
  for (const e of prevBlocks) {
    if (e && typeof e === 'object' && (e.zip || e.archiveZip)) {
      staged.set(`${e.lessonId}|${e.blockId}|${e.locale ?? ''}`, e);
    }
  }
  let kept = 0;
  const entries = blocks.map((block) => {
    const prior = staged.get(`${block.lessonId}|${block.blockId}|${block.locale ?? ''}`);
    if (prior) kept += 1;
    return prior ?? manifestEntryWithoutZip(block);
  });
  return { entries, kept };
}

/** Keys (lesson|block|locale) of MODERN blocks the previous manifest recorded
 *  as an explicit `source-placeholder` — never staged, typically because the
 *  course was not exportable on that run. Once the course is exportable they
 *  must be built: the manifest's mere presence is not "already exported".
 *  (Pre-policy entries carry no `compatibility` and stay treated as staged.) */
function placeholderKeys(
  previous: Record<string, unknown> | undefined,
  blocks: StorylineBlockRef[],
): Set<string> {
  const prevBlocks = Array.isArray(previous?.blocks) ? (previous!.blocks as StorylineManifestEntry[]) : [];
  const placeholders = new Set<string>();
  for (const e of prevBlocks) {
    if (e && typeof e === 'object' && e.compatibility === 'source-placeholder' && e.leaf) {
      placeholders.add(`${e.lessonId}|${e.blockId}|${e.locale ?? ''}`);
    }
  }
  const out = new Set<string>();
  for (const block of blocks) {
    const key = `${block.lessonId}|${block.blockId}|${block.locale ?? ''}`;
    if (block.leaf && !isKnownLegacyStorylineMeta(block.meta) && placeholders.has(key)) out.add(key);
  }
  return out;
}

/** The previous manifest minus a stale `exportBlocked` (the course is exportable
 *  now — left in place, import preflight would still flag every block manual). */
function withoutExportBlocked(previous: Record<string, unknown> | undefined): Record<string, unknown> {
  const { exportBlocked: _stale, ...rest } = previous ?? {};
  return rest;
}

function notExportableNote(summary: StorylineExportSummary): string {
  return summary.notExportable ? ` (${summary.notExportable} not exportable from this account)` : '';
}

const defaultExportOne: NonNullable<StorylineExportDeps['exportOne']> = async (
  courseId,
  title,
  pin,
) => {
  const resp = await pinnedRpc(pin)({ type: 'STORYLINE_EXPORT', courseId, title });
  if (resp.type !== 'STORYLINE_EXPORT_RESULT') return { ok: false, error: 'unexpected response' };
  if (!resp.result.ok) return { ok: false, error: resp.result.error };
  return { ok: true, location: resp.result.data.location, jobId: resp.result.data.jobId };
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
  const pinTab = deps.pinTab ?? (() => pinTargetTab(undefined, onEvent, 'source'));
  const pacing = deps.pacing ?? DEFAULT_PACING;

  const targets = await scanSavedCoursesForStoryline(storage, onEvent, deps.onlyCourseIds);
  const summary: StorylineExportSummary = {
    courses: targets.length,
    packaged: 0,
    skipped: 0,
    failed: 0,
    legacySkipped: 0,
    legacySaved: 0,
    notAttempted: 0,
    notExportable: 0,
    errors: [],
  };
  if (!targets.length) return summary;

  await updateStorylineImportability(storage, targets, onEvent);

  // Resume is artifact-aware: a pre-policy manifest does NOT count as complete
  // when one of its legacy package leaves is absent from storyline-legacy/.
  // This lets an operator rerun an existing archive and backfill preservation
  // without forcing/rebuilding its already-staged modern packages.
  const pending: Array<
    StorylineCourseScan & {
      blocksToSave: StorylineBlockRef[];
      previousManifest?: Record<string, unknown>;
    }
  > = [];
  for (const target of targets) {
    summary.legacySkipped += target.legacyBlocks.length;
    const rawManifest = await storage.readStorylineManifest(target.courseId);
    let previousManifest: Record<string, unknown> | undefined;
    if (rawManifest) {
      try {
        const parsed = JSON.parse(rawManifest) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          previousManifest = parsed as Record<string, unknown>;
        }
      } catch {
        previousManifest = undefined;
      }
    }

    const missingLegacyLeaves = new Set<string>();
    for (const block of target.legacyBlocks) {
      if (!block.leaf || missingLegacyLeaves.has(block.leaf)) continue;
      const exists =
        !deps.force &&
        typeof storage.hasLegacyStorylineZip === 'function' &&
        (await storage.hasLegacyStorylineZip(target.courseId, block.leaf));
      if (!exists) missingLegacyLeaves.add(block.leaf);
    }

    // No export permission: the build would 404 on every run, so never attempt
    // it (not even with Force). Checked BEFORE the resume skip so the course is
    // ⚠ + counted `notExportable` on EVERY run — a manual-review manifest from
    // run 1 must not turn it into a green "already exported" on run 2. Entries
    // staged on an earlier run (when this account still had export rights) are
    // KEPT by leaf+locale; only the unstaged blocks become `source-placeholder`
    // (no zip: upload skips them, import flags them for manual attach).
    if (target.exportBlocked) {
      const { entries, kept } = mergeStagedEntries(previousManifest, target.blocks);
      await storage.writeStorylineManifest(
        target.courseId,
        JSON.stringify(
          {
            ...(previousManifest ?? {}),
            courseId: target.courseId,
            title: target.title,
            exportBlocked: target.exportBlocked,
            blocks: entries,
          },
          null,
          2,
        ),
      );
      summary.skipped += 1;
      summary.notExportable += 1;
      const unstaged = target.blocks.length - kept;
      onEvent({
        kind: 'log',
        message:
          `⚠ ${courseRef(target.title, target.courseId)}: not exported — ${target.exportBlocked}; ` +
          `${unstaged} Storyline package(s) need manual review` +
          (kept ? ` (${kept} kept from an earlier export)` : '') +
          `. Once this account may export the course (the owner grants export rights or sends a copy), ` +
          `move courses/${target.courseId}.json out of the archive, re-run Fetch courses (it re-saves the current permissions), then re-run this step.`,
      });
      continue;
    }

    // Placeholders from an earlier blocked run: exportable now, so build them —
    // without this the leftover manifest passed as a green "already exported".
    const unstaged = placeholderKeys(previousManifest, target.blocks);

    if (!deps.force && rawManifest && missingLegacyLeaves.size === 0 && unstaged.size === 0) {
      summary.skipped += 1;
      // ✓: a resume skip is a success — the packages are already staged.
      onEvent({
        kind: 'log',
        message: `✓ ${target.title ?? target.courseId}: already exported, skipped`,
      });
      continue;
    }

    const blocksToSave = target.blocks.filter((block) => {
      if (!block.leaf) return false;
      if (isKnownLegacyStorylineMeta(block.meta)) {
        return deps.force || missingLegacyLeaves.has(block.leaf);
      }
      // A prior manifest means the automatic package was already handled, unless
      // it recorded this block as a never-staged placeholder; otherwise this run
      // exists only to backfill missing legacy preservation.
      return (
        deps.force ||
        !rawManifest ||
        unstaged.has(`${block.lessonId}|${block.blockId}|${block.locale ?? ''}`)
      );
    });
    if (!blocksToSave.length) {
      const entries = target.blocks.map((block) => manifestEntryWithoutZip(block));
      await storage.writeStorylineManifest(
        target.courseId,
        JSON.stringify(
          {
            ...withoutExportBlocked(previousManifest),
            courseId: target.courseId,
            title: target.title,
            blocks: entries,
          },
          null,
          2,
        ),
      );
      summary.skipped += 1;
      onEvent({
        kind: 'log',
        message: `${target.title ?? target.courseId}: no automatically transferable Storyline packages; legacy/manual-review manifest written`,
      });
      continue;
    }
    pending.push({ ...target, blocksToSave, previousManifest });
  }

  if (!pending.length) {
    onEvent({ kind: 'import-status', label: 'Storyline export complete', etaSeconds: null, done: true });
    onEvent({
      kind: 'log',
      message: `${summary.notExportable ? '⚠' : '✓'} Storyline export: 0 packaged, ${summary.skipped} skipped${notExportableNote(summary)}, 0 failed; ${summary.legacySkipped} legacy package(s) flagged, ${summary.legacySaved} preserved.`,
    });
    return summary;
  }

  // Pin the run to ONE Rise tab so the per-course build trigger (an authoring
  // write on the SOURCE course) can't follow window focus onto the other plane
  // mid-run. Unlike the import steps this only WARNS when it can't pin: the build
  // names a source course id, so a wrong-account attempt fails loudly on its own
  // (404/403) rather than writing somewhere it shouldn't.
  const { pin, blocked: pinBlocked } = await pinTab();
  if (pinBlocked) {
    onEvent({
      kind: 'log',
      message: `WARN ${pinBlocked} — continuing UNPINNED: each build runs in whichever Rise tab is focused at the time. Keep the SOURCE tab focused.`,
    });
  }

  // Proper auth BEFORE any action: refresh once up front and abort if the token
  // can't be made valid — a stale session fails every export, so don't attempt.
  try {
    // The first source course is a safe, capture-confirmed editor route. Passing
    // it removes the old requirement that the operator keep an editor open just
    // to start a long Storyline export from the dashboard.
    const r = await refresh(pin, pending[0]!.courseId);
    if (r) onEvent({ kind: 'log', message: `${r.valid ? '' : '⚠ '}Token refresh: ${r.valid ? 'valid' : 'INVALID'}${r.via ? ` (via ${r.via})` : ''}.` });
    if (r && r.valid === false) {
      summary.aborted = 'stale session token';
      summary.notAttempted = pending.length;
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

  const runStart = Date.now();
  for (let i = 0; i < pending.length; i++) {
    const { courseId, title, blocks, blocksToSave, previousManifest } = pending[i]!;
    const label = `[${i + 1}/${pending.length}]`;
    onEvent({ kind: 'course', index: i, total: pending.length, courseId, title });
    onEvent(
      etaStatus({
        label: `Exporting ${i + 1}/${pending.length}`,
        doneFraction: i / pending.length,
        runStartMs: runStart,
        nowMs: Date.now(),
      }),
    );

    if (i > 0) await pacedDelay(pacing); // pace between course builds (authoring write)

    try {
      // Stamped: a web-export build takes tens of seconds to minutes per course.
      onEvent({ kind: 'log', message: `${nowStamp()} ${label} ${title ?? courseId}: triggering web export…` });
      const res = await exportOne(courseId, title ?? courseId, pin);
      if (!res.ok) throw new Error(res.error);

      onEvent({ kind: 'log', message: `${label} downloading package zip…` });
      const webZip = await fetchZip(res.location);
      const files = unzipToMap(webZip);

      // Cross-check the export against the saved course BEFORE repackaging: the
      // packages physically present live under content/assets/{leaf}/, and the
      // export's own runtime-data.js lists each storyline block's leaf. A saved
      // block whose leaf is missing is a contentPrefix mismatch between the
      // archived course and this export — name it specifically instead of the
      // opaque "package X has no story.html".
      const physicalLeaves = listPackageLeaves(files);
      let runtimeLeaves: string[] | null = null;
      try {
        runtimeLeaves = parseWebExportRuntimeData(getRuntimeDataJs(files)).map((r) => r.leaf);
      } catch {
        runtimeLeaves = null; // diagnostics only — the physical check decides
      }

      // Build the complete manifest from current source metadata. Modern
      // packages point at the uploadable store; legacy packages point only at
      // their quarantined preservation store.
      const entries: StorylineManifestEntry[] = blocks.map((block) => {
        const legacy = isKnownLegacyStorylineMeta(block.meta);
        return {
          blockId: block.blockId,
          lessonId: block.lessonId,
          itemId: block.itemId,
          leaf: block.leaf,
          meta: block.meta,
          ...(block.title ? { title: block.title } : {}),
          ...(block.leaf && legacy
            ? { archiveZip: `storyline-legacy/${courseId}/${block.leaf}.zip` }
            : block.leaf
              ? { zip: `storyline/${courseId}/${block.leaf}.zip` }
              : {}),
          compatibility: legacy
            ? 'legacy-unsupported'
            : block.leaf
              ? 'automatic'
              : 'source-placeholder',
          ...(block.locale ? { locale: block.locale } : {}),
          ...(block.l10nId ? { l10nId: block.l10nId } : {}),
        };
      });
      const automaticDone = new Set<string>();
      const legacyDone = new Set<string>();
      for (const b of blocksToSave) {
        const where = b.locale ? `block ${b.blockId} [${b.locale}]` : `block ${b.blockId}`;
        if (!b.leaf) {
          onEvent({ kind: 'log', message: `${label} ${where}: no source leaf (placeholder), skipped` });
          continue;
        }
        if (!physicalLeaves.includes(b.leaf)) {
          throw new Error(
            `contentPrefix mismatch: ${where} expects package leaf "${b.leaf}", ` +
              `but the web export carries [${physicalLeaves.join(', ') || 'none'}]` +
              (runtimeLeaves
                ? `; its runtime-data.js lists [${runtimeLeaves.join(', ') || 'none'}]`
                : '; its runtime-data.js could not be parsed'),
          );
        }
        if (isKnownLegacyStorylineMeta(b.meta)) {
          if (!legacyDone.has(b.leaf)) {
            const zip = buildPreservedPackageZip(extractPackage(files, b.leaf));
            await storage.writeLegacyStorylineZip(courseId, b.leaf, zip);
            legacyDone.add(b.leaf);
          }
        } else if (!automaticDone.has(b.leaf)) {
          const zip = buildReview360Zip(extractPackage(files, b.leaf));
          await storage.writeStorylineZip(courseId, b.leaf, zip);
          automaticDone.add(b.leaf);
        }
      }

      await storage.writeStorylineManifest(
        courseId,
        JSON.stringify(
          {
            ...withoutExportBlocked(previousManifest),
            courseId,
            title,
            jobId: res.jobId,
            blocks: entries,
          },
          null,
          2,
        ),
      );
      summary.packaged += 1;
      summary.legacySaved += legacyDone.size;
      onEvent({
        kind: 'log',
        message:
          `${label} ${title ?? courseId}: ${automaticDone.size} automatic package(s) → storyline/${courseId}/; ` +
          `${legacyDone.size} legacy package(s) preserved → storyline-legacy/${courseId}/` +
          (entries.some((e) => e.locale)
            ? ` (${entries.filter((e) => e.locale).length} language-specific)`
            : ''),
      });
    } catch (e) {
      const error = (e as Error).message;
      summary.failed += 1;
      summary.errors.push({ courseId, title, error });
      onEvent({ kind: 'log', message: `${label} ${courseRef(title, courseId)}: FAILED — ${error}` });

      // A stale session 403s every build — abort instead of looping 152×.
      if (isAuthError(error)) {
        summary.aborted = error;
        summary.notAttempted = pending.length - (i + 1);
        onEvent({
          kind: 'log',
          message: `⛔ Aborting: looks like an auth/session failure. Open a Rise COURSE EDITOR (not the dashboard) to rotate the token, then run again. ${summary.notAttempted} course(s) not attempted.`,
        });
        break;
      }
    }
  }

  onEvent({ kind: 'import-status', label: 'Storyline export complete', etaSeconds: null, done: true });
  onEvent({
    kind: 'log',
    message: `${summary.failed || summary.aborted || summary.notExportable ? '⚠' : '✓'} Storyline export: ${summary.packaged} packaged, ${summary.skipped} skipped${notExportableNote(summary)}, ${summary.failed} failed${summary.notAttempted ? `, ${summary.notAttempted} not attempted` : ''} of ${summary.courses} course(s); ${summary.legacySkipped} legacy package(s) flagged, ${summary.legacySaved} preserved.`,
  });
  return summary;
}


// --- Stage A (scan) / shared / Stage C (upload) — split (v0.9.0) ------------
// Re-exported here so the public surface of './storyline' is unchanged.
export {
  scanSavedCoursesForStoryline,
  updateStorylineImportability,
  type StorylineCourseScan,
} from './storyline-scan';
export { isAuthError } from './storyline-shared';
export {
  MAX_UPLOAD_ZIP_BYTES,
  uploadStorylineToReview360,
  renameReviewItemsToBlockTitles,
  type StorylineRenameSummary,
  type StorylineUploadDeps,
  type StorylineUploadRecord,
  type StorylineUploadSummary,
} from './storyline-upload';
import { defaultRefresh, isAuthError } from './storyline-shared';
import {
  scanSavedCoursesForStoryline,
  updateStorylineImportability,
  type StorylineCourseScan,
} from './storyline-scan';

