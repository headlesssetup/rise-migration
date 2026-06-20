// Phase 2 — asset extraction orchestration (panel-side).
//
// Downloads uploaded-media bytes from the public CDN so the archive is
// self-sufficient for import. Unlike the Rise authoring API (strictly
// sequential + human-paced), the public CDN is fetched through a bounded
// parallel pool — that pacing invariant does not apply here (STATUS.md).
//
// The side panel is an extension page; with `articulateusercontent.com` in
// host_permissions it can fetch the CDN cross-origin, and FileSystemStorage
// lives panel-side too — so download + write happen here, no background relay.

import {
  collectAssetKeys,
  downloadAssetsFor,
  findUndownloadedKeys,
  keyPathCandidates,
  assetManifestToJson,
  type AssetManifest,
  type DownloadOutcome,
  type Downloader,
} from '@/core/assets';
import type { Storage } from '@/core/storage/storage';
import { unwrap, type ProgressEvent } from './shared';

const CDN_BASE = 'https://articulateusercontent.com/';
const MAX_RETRIES = 2; // for transient 429 / 5xx

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real downloader: GET the public-read CDN object for a key. Tries encoding
 *  variants (verbatim → normalized → NFC) so keys with `(n)`, double-encoding,
 *  or NFD unicode resolve; retries transient 429/5xx with backoff. */
export const cdnDownload: Downloader = async (
  key: string,
): Promise<DownloadOutcome> => {
  let lastStatus: number | undefined;
  let lastError: string | undefined;
  let lastUrl: string | undefined;

  for (const path of keyPathCandidates(key)) {
    lastUrl = path;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(CDN_BASE + path);
        if (res.ok) {
          const buf = await res.arrayBuffer();
          return {
            ok: true,
            status: res.status,
            bytes: new Uint8Array(buf),
            contentType: res.headers.get('content-type') ?? undefined,
            urlTried: path,
          };
        }
        lastStatus = res.status;
        lastError = undefined;
        // Retry only transient statuses; otherwise move to the next variant.
        if (res.status === 429 || res.status >= 500) {
          if (attempt < MAX_RETRIES) await sleep(500 * (attempt + 1));
          continue;
        }
        break; // 4xx (e.g. 404) → try the next encoding variant
      } catch (e) {
        lastError = String(e);
        lastStatus = undefined;
        if (attempt < MAX_RETRIES) await sleep(500 * (attempt + 1));
      }
    }
  }
  return { ok: false, status: lastStatus, error: lastError, urlTried: lastUrl };
};

interface UndownloadedOwner {
  ownerType: 'course' | 'bank';
  ownerId: string;
  keys: string[];
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
  /** Owners with keys that 404'd after every encoding variant — likely deleted. */
  orphaned: UndownloadedOwner[];
  /** Owners with keys that failed for other (transient/network) reasons. */
  undownloaded: UndownloadedOwner[];
  complete: boolean;
}

interface Owner {
  scope: 'courses' | 'question-banks';
  ownerType: 'course' | 'bank';
  id: string;
  doc: unknown;
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

/**
 * Download assets for every saved course + question bank, writing bytes
 * content-addressed under `assets/` (deduped) and a per-owner `<id>.assets.json`
 * manifest. Returns a run-wide summary splitting failures into `orphaned`
 * (404 after all encoding variants — likely deleted) vs `undownloaded`
 * (transient/other).
 *
 * Resume: an owner whose prior manifest is already complete is skipped; an
 * incomplete one is re-run, reusing its successful entries and re-attempting
 * only the missing/failed keys. So clicking "Download assets" again is cheap and
 * retries past failures.
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
    undownloaded: [],
    complete: true,
  };

  for (const [i, owner] of owners.entries()) {
    onEvent({ kind: 'course', index: i, total: owners.length, courseId: owner.id });

    // Resume: a complete prior manifest → skip; an incomplete one → reuse its
    // successes and retry the rest.
    const prior = await readPriorManifest(storage, owner);
    if (prior?.complete) {
      summary.skipped += 1;
      onEvent({ kind: 'log', message: `Assets already done: ${owner.id}` });
      continue;
    }

    const collected = collectAssetKeys(owner.doc, owner.id);
    const { manifest, stats } = await downloadAssetsFor(
      owner.ownerType,
      owner.id,
      owner.doc,
      storage,
      downloader,
      { priorAssets: prior?.assets },
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

    // Split this owner's failures into orphaned (404 after all variants) vs other.
    const orphanKeys: string[] = [];
    const otherKeys: string[] = [];
    for (const f of manifest.failed) {
      const code = f.status ?? 0;
      const bucket = String(code || 'network');
      summary.statusHistogram[bucket] = (summary.statusHistogram[bucket] ?? 0) + 1;
      (code === 404 ? orphanKeys : otherKeys).push(f.key);
    }
    if (orphanKeys.length) {
      summary.orphaned.push({
        ownerType: owner.ownerType,
        ownerId: owner.id,
        keys: orphanKeys,
      });
    }
    if (otherKeys.length) {
      summary.complete = false;
      summary.undownloaded.push({
        ownerType: owner.ownerType,
        ownerId: owner.id,
        keys: otherKeys,
      });
    }

    const missing = findUndownloadedKeys(collected, manifest);
    if (missing.length) {
      onEvent({
        kind: 'log',
        message: `⚠ ${owner.id}: ${orphanKeys.length} orphaned, ${otherKeys.length} failed`,
      });
    } else {
      onEvent({
        kind: 'log',
        message: `Assets ${owner.id}: ${stats.written} new, ${stats.deduped} deduped, ${stats.reused} reused${
          stats.fetched || stats.reused ? '' : ' (no media)'
        }`,
      });
    }
  }

  await storage.writeAssetsSummary(JSON.stringify(summary, null, 2));
  return summary;
}
