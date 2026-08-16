// Phase 2 — asset extraction orchestration (panel-side).
//
// Downloads uploaded-media bytes from the public CDN so the archive is
// self-sufficient for import. Unlike the Rise authoring API (strictly
// sequential + human-paced), the public CDN is fetched through a bounded
// parallel pool — that pacing invariant does not apply here (STATUS.md).
//
// The side panel is an extension page; with `articulateusercontent.com` AND
// `articulateusercontent.eu` in host_permissions it can fetch either plane's CDN
// cross-origin, and FileSystemStorage lives panel-side too — so download + write
// happen here, no background relay.

import {
  collectAssetKeys,
  buildAssetManifest,
  downloadAssetsFor,
  formatLocation,
  isOrphanStatus,
  keyPathCandidates,
  locateKey,
  assetManifestToJson,
  type AssetFailure,
  type AssetManifest,
  type DownloadOutcome,
  type Downloader,
  type OptionalAssetReason,
} from '@/core/assets';
import type { Storage } from '@/core/storage/storage';
import { unwrap, type ProgressEvent } from './shared';

const CDN_US = 'https://articulateusercontent.com/';
const CDN_EU = 'https://articulateusercontent.eu/';
const MAX_RETRIES = 2; // for transient 429 / 5xx
// Abort a CDN GET that produces no response in time — a single hung connection
// would otherwise stall one pool lane forever. Treated as a retryable failure.
const FETCH_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Usercontent base hosts to try, in order, for a given plane. A known plane
 *  hits exactly one host (no waste); an unknown plane tries US then EU so an
 *  archive whose plane wasn't recorded still resolves. */
export function cdnBasesForPlane(plane: 'us' | 'eu' | null | undefined): string[] {
  if (plane === 'eu') return [CDN_EU];
  if (plane === 'us') return [CDN_US];
  return [CDN_US, CDN_EU]; // unknown → try both
}

/** Build a downloader over the given usercontent base hosts. GETs the public-read
 *  CDN object for a key, trying encoding variants (verbatim → normalized → NFC)
 *  so keys with `(n)`, double-encoding, or NFD unicode resolve, and falling
 *  through to the next host base on a miss; retries transient 429/5xx. */
export function makeCdnDownloader(bases: string[], timeoutMs = FETCH_TIMEOUT_MS): Downloader {
  return async (key: string): Promise<DownloadOutcome> => {
    let lastStatus: number | undefined;
    let lastError: string | undefined;
    let lastUrl: string | undefined;

    for (const base of bases) {
      for (const path of keyPathCandidates(key)) {
        lastUrl = base + path;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            const res = await fetch(base + path, { signal: AbortSignal.timeout(timeoutMs) });
            if (res.ok) {
              const buf = await res.arrayBuffer();
              return {
                ok: true,
                status: res.status,
                bytes: new Uint8Array(buf),
                contentType: res.headers.get('content-type') ?? undefined,
                urlTried: base + path,
              };
            }
            lastStatus = res.status;
            lastError = undefined;
            if (res.status === 429 || res.status >= 500) {
              if (attempt < MAX_RETRIES) await sleep(500 * (attempt + 1));
              continue;
            }
            break; // 4xx (e.g. 404) → try the next encoding variant / host
          } catch (e) {
            lastError = String(e);
            lastStatus = undefined;
            if (attempt < MAX_RETRIES) await sleep(500 * (attempt + 1));
          }
        }
      }
    }
    return { ok: false, status: lastStatus, error: lastError, urlTried: lastUrl };
  };
}

/** Default downloader (US plane); plane-aware callers use makeCdnDownloader. */
export const cdnDownload: Downloader = makeCdnDownloader([CDN_US]);

interface FailedKey {
  key: string;
  /** Human location in the source doc, e.g. `Chapter 2 › image/hero`. */
  location?: string;
  reason?: OptionalAssetReason;
}

interface UndownloadedOwner {
  ownerType: 'course' | 'bank';
  ownerId: string;
  /** Course/bank title, to locate it in Rise. */
  title?: string;
  keys: FailedKey[];
}

export interface AssetsSummary {
  generatedAt: string;
  owners: number;
  skipped: number;
  fetched: number;
  written: number;
  deduped: number;
  reused: number;
  failed: number;
  /** HTTP status → count, across all failed keys (diagnostics). */
  statusHistogram: Record<string, number>;
  /** Owners with keys that returned 403/404 after every encoding variant —
   *  missing/inaccessible at source (likely deleted). Terminal: flagged every
   *  run (even when the owner is otherwise skipped), never re-fetched. */
  orphaned: UndownloadedOwner[];
  /** Unavailable authoring/source variants which are not used for rendering. */
  optionalUnavailable: UndownloadedOwner[];
  /** Owners with keys that failed for other (transient/network) reasons. */
  undownloaded: UndownloadedOwner[];
  /** Owners whose processing threw entirely — no manifest written this run. */
  failedOwners: { ownerType: 'course' | 'bank'; ownerId: string; title?: string; error: string }[];
  complete: boolean;
}

interface Owner {
  scope: 'courses' | 'question-banks';
  ownerType: 'course' | 'bank';
  id: string;
  doc: unknown;
}

/** Best-effort course/bank title from its doc (for locating it in Rise). */
function ownerTitle(owner: Owner): string | undefined {
  const d = owner.doc;
  if (!d || typeof d !== 'object') return undefined;
  const rec = d as Record<string, unknown>;
  if (owner.ownerType === 'course') {
    const course = rec.course;
    const t = course && typeof course === 'object'
      ? (course as Record<string, unknown>).title
      : undefined;
    return typeof t === 'string' ? t : undefined;
  }
  const t = rec.name ?? rec.title;
  return typeof t === 'string' ? t : undefined;
}

/** Read a prior per-owner manifest, or null if absent/unreadable. */
async function readPriorManifest(
  storage: Storage,
  owner: Owner,
): Promise<AssetManifest | null> {
  const raw = await storage.readAssetManifest(owner.scope, owner.id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AssetManifest;
  } catch {
    return null;
  }
}

/** Split an owner's failure list into required orphaned, optional unavailable,
 *  and retryable, tagging each key with its source-doc location.
 *  Only retryable failures clear `summary.complete` — matching the per-owner
 *  manifest, where orphans don't block `complete` either. */
function recordOwnerFailures(
  summary: AssetsSummary,
  owner: Owner,
  failures: AssetFailure[],
): void {
  if (!failures.length) return;
  const title = ownerTitle(owner);
  const orphanKeys: FailedKey[] = [];
  const optionalKeys: FailedKey[] = [];
  const otherKeys: FailedKey[] = [];
  for (const f of failures) {
    const bucket = String(f.status || 'network');
    summary.statusHistogram[bucket] = (summary.statusHistogram[bucket] ?? 0) + 1;
    const path = f.paths?.[0];
    const location = path ? formatLocation(locateKey(owner.doc, path)) : undefined;
    const item = { key: f.key, location, reason: f.optionalReason };
    if (!isOrphanStatus(f.status)) otherKeys.push(item);
    else if (f.optionalReason) optionalKeys.push(item);
    else orphanKeys.push(item);
  }
  if (orphanKeys.length) {
    summary.orphaned.push({
      ownerType: owner.ownerType,
      ownerId: owner.id,
      title,
      keys: orphanKeys,
    });
  }
  if (optionalKeys.length) {
    summary.optionalUnavailable.push({
      ownerType: owner.ownerType,
      ownerId: owner.id,
      title,
      keys: optionalKeys,
    });
  }
  if (otherKeys.length) {
    summary.complete = false;
    summary.undownloaded.push({
      ownerType: owner.ownerType,
      ownerId: owner.id,
      title,
      keys: otherKeys,
    });
  }
}

/**
 * Download assets for every saved course + question bank, writing bytes
 * content-addressed under `assets/` (deduped) and a per-owner `<id>.assets.json`
 * manifest. Returns a run-wide summary splitting failures into `orphaned`
 * (404 after all encoding variants — likely deleted) vs `undownloaded`
 * (transient/other).
 *
 * Resume: an owner whose prior manifest is already complete is skipped — but
 * only after verifying that (a) the doc's collected keys are all covered by that
 * manifest (key detection may have improved since it was written) and (b) every
 * stored blob still exists; otherwise the owner is re-run, reusing its good
 * entries and fetching only what's missing. Orphaned keys (403/404 at source)
 * are terminal: carried forward, surfaced every run, never re-fetched. One
 * owner's failure never aborts the run — it's recorded in `failedOwners`.
 */
export async function downloadAllAssets(
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
  downloader: Downloader = cdnDownload,
): Promise<AssetsSummary> {
  // Gather owners (courses + banks) and their parsed docs.
  const owners: Owner[] = [];
  for (const id of await storage.listSaved()) {
    const raw = await storage.readCourse(id);
    if (!raw) continue;
    try {
      owners.push({ scope: 'courses', ownerType: 'course', id, doc: unwrap(raw) });
    } catch {
      onEvent({ kind: 'log', message: `Skipped unreadable course: ${id}` });
    }
  }
  for (const id of await storage.listSavedBanks()) {
    const raw = await storage.readQuestionBank(id);
    if (!raw) continue;
    try {
      owners.push({ scope: 'question-banks', ownerType: 'bank', id, doc: JSON.parse(raw) });
    } catch {
      onEvent({ kind: 'log', message: `Skipped unreadable bank: ${id}` });
    }
  }

  const summary: AssetsSummary = {
    generatedAt: new Date().toISOString(),
    owners: owners.length,
    skipped: 0,
    fetched: 0,
    written: 0,
    deduped: 0,
    reused: 0,
    failed: 0,
    statusHistogram: {},
    orphaned: [],
    optionalUnavailable: [],
    undownloaded: [],
    failedOwners: [],
    complete: true,
  };

  for (const [i, owner] of owners.entries()) {
    onEvent({ kind: 'course', index: i, total: owners.length, courseId: owner.id });

    try {
      const collected = collectAssetKeys(owner.doc, owner.id);
      const prior = await readPriorManifest(storage, owner);
      const currentByKey = new Map(collected.map((k) => [k.key, k]));

      // Reclassify legacy manifests from the current source document. This is
      // deliberately done before resume so a 19 GB archive can adopt the new
      // active-vs-provenance policy without downloading its good blobs again.
      const priorAssets = (prior?.assets ?? []).filter((a) => currentByKey.has(a.key));
      const priorFailures: AssetFailure[] = (prior?.failed ?? [])
        .filter((f) => currentByKey.has(f.key))
        .map((f) => {
          const optionalReason = currentByKey.get(f.key)?.optionalReason;
          if (optionalReason) return { ...f, optionalReason };
          const { optionalReason: _oldReason, ...requiredFailure } = f;
          return requiredFailure;
        });
      const normalizedPrior = prior
        ? buildAssetManifest(
            owner.ownerType,
            owner.id,
            collected,
            priorAssets,
            priorFailures,
            prior.generatedAt,
          )
        : null;
      const priorTerminal = priorFailures.filter((f) => isOrphanStatus(f.status));

      // Resume: a complete prior manifest → skip, but only after verifying it
      // still covers every collected key (the key scanner may have improved
      // since it was written) and every stored blob still exists.
      if (normalizedPrior?.complete) {
        const covered = new Set([
          ...priorAssets.map((a) => a.key),
          ...priorTerminal.map((f) => f.key),
        ]);
        const newKeys = collected.filter((k) => !covered.has(k.key)).map((k) => k.key);
        let lostBlob: string | undefined;
        if (newKeys.length === 0) {
          for (const a of priorAssets) {
            const name = a.file.split('/').pop() ?? a.file;
            if (!(await storage.hasAsset(name))) {
              lostBlob = a.file;
              break;
            }
          }
        }
        if (newKeys.length === 0 && !lostBlob) {
          // Persist the upgraded policy/counts and prune stale parser artifacts
          // even though no network work is needed.
          await storage.writeAssetManifest(
            owner.scope,
            owner.id,
            assetManifestToJson(normalizedPrior),
          );
          summary.skipped += 1;
          recordOwnerFailures(summary, owner, priorTerminal);
          const optionalCount = priorTerminal.filter((f) => f.optionalReason).length;
          const orphanCount = priorTerminal.length - optionalCount;
          onEvent({
            kind: 'log',
            message: `Assets already done: ${owner.id}${
              orphanCount ? ` (⚠ ${orphanCount} active asset(s) unavailable)` : ''
            }${
              optionalCount ? ` (${optionalCount} optional source ref(s) unavailable)` : ''
            }`,
          });
          continue;
        }
        onEvent({
          kind: 'log',
          message: lostBlob
            ? `Assets re-run ${owner.id}: stored blob missing (${lostBlob})`
            : `Assets re-run ${owner.id}: ${newKeys.length} key(s) not covered by the prior manifest (e.g. ${newKeys[0]})`,
        });
      }

      const { manifest, stats } = await downloadAssetsFor(
        owner.ownerType,
        owner.id,
        owner.doc,
        storage,
        downloader,
        {
          priorAssets,
          priorOrphans: priorTerminal,
          onProgress: (message) => onEvent({ kind: 'log', message }),
        },
      );
      await storage.writeAssetManifest(
        owner.scope,
        owner.id,
        assetManifestToJson(manifest),
      );

      summary.fetched += stats.fetched;
      summary.written += stats.written;
      summary.deduped += stats.deduped;
      summary.reused += stats.reused;
      summary.failed += stats.failed;

      recordOwnerFailures(summary, owner, manifest.failed);

      if (stats.orphaned || stats.failed) {
        onEvent({
          kind: 'log',
          message: `⚠ ${owner.id}: ${stats.orphaned} active unavailable, ${stats.failed} failed${
            stats.optionalUnavailable
              ? `, ${stats.optionalUnavailable} optional source ref(s) unavailable`
              : ''
          }`,
        });
      } else {
        onEvent({
          kind: 'log',
          message: `Assets ${owner.id}: ${stats.written} new, ${stats.deduped} deduped, ${stats.reused} reused${
            stats.fetched || stats.reused ? '' : ' (no media)'
          }${stats.optionalUnavailable ? `; ${stats.optionalUnavailable} optional source ref(s) unavailable` : ''}`,
        });
      }
    } catch (e) {
      // One owner's crash (quota, malformed doc, storage error) must not kill
      // the whole run — record it loudly and move to the next owner.
      summary.complete = false;
      summary.failedOwners.push({
        ownerType: owner.ownerType,
        ownerId: owner.id,
        title: ownerTitle(owner),
        error: String(e),
      });
      onEvent({
        kind: 'log',
        message: `⚠ [${i + 1}/${owners.length}] owner FAILED ${owner.id}: ${String(e)}`,
      });
    }
  }

  if (summary.failedOwners.length) {
    onEvent({
      kind: 'log',
      message: `⚠ ${summary.failedOwners.length} owner(s) failed entirely: ${summary.failedOwners
        .map((f) => f.ownerId)
        .join(', ')}`,
    });
  }

  await storage.writeAssetsSummary(JSON.stringify(summary, null, 2));
  return summary;
}
