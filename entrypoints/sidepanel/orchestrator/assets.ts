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
  assetManifestToJson,
  type DownloadOutcome,
  type Downloader,
} from '@/core/assets';
import type { Storage } from '@/core/storage/storage';
import { unwrap, type ProgressEvent } from './shared';

const CDN_BASE = 'https://articulateusercontent.com/';

/** Real downloader: GET the public-read CDN object for a key. Keys are already
 *  URL-safe (cuid-based), so they're appended verbatim. */
export const cdnDownload: Downloader = async (
  key: string,
): Promise<DownloadOutcome> => {
  try {
    const res = await fetch(CDN_BASE + key);
    if (!res.ok) return { ok: false, status: res.status };
    const buf = await res.arrayBuffer();
    return {
      ok: true,
      status: res.status,
      bytes: new Uint8Array(buf),
      contentType: res.headers.get('content-type') ?? undefined,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
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
  failed: number;
  /** Owners with media keys that did NOT download — the loud-fail signal. */
  undownloaded: UndownloadedOwner[];
  complete: boolean;
}

interface Owner {
  scope: 'courses' | 'question-banks';
  ownerType: 'course' | 'bank';
  id: string;
  doc: unknown;
}

/**
 * Download assets for every saved course + question bank, writing bytes
 * content-addressed under `assets/` (deduped) and a per-owner `<id>.assets.json`
 * manifest. Returns a run-wide summary including the un-downloaded-key
 * assertion. Owners with an existing manifest are skipped (resume); delete a
 * `*.assets.json` to force re-download.
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
    failed: 0,
    undownloaded: [],
    complete: true,
  };

  for (const [i, owner] of owners.entries()) {
    onEvent({ kind: 'course', index: i, total: owners.length, courseId: owner.id });

    if (await storage.hasAssetManifest(owner.scope, owner.id)) {
      summary.skipped += 1;
      onEvent({ kind: 'log', message: `Assets already done: ${owner.id}` });
      continue;
    }

    const collected = collectAssetKeys(owner.doc, owner.id);
    if (collected.length === 0) {
      // Still write an (empty) manifest so the owner is marked done / resumable.
      const { manifest } = await downloadAssetsFor(
        owner.ownerType,
        owner.id,
        owner.doc,
        storage,
        downloader,
      );
      await storage.writeAssetManifest(
        owner.scope,
        owner.id,
        assetManifestToJson(manifest),
      );
      continue;
    }

    const { manifest, stats } = await downloadAssetsFor(
      owner.ownerType,
      owner.id,
      owner.doc,
      storage,
      downloader,
    );
    await storage.writeAssetManifest(
      owner.scope,
      owner.id,
      assetManifestToJson(manifest),
    );

    summary.fetched += stats.fetched;
    summary.written += stats.written;
    summary.deduped += stats.deduped;
    summary.failed += stats.failed;

    const missing = findUndownloadedKeys(collected, manifest);
    if (missing.length) {
      summary.complete = false;
      summary.undownloaded.push({
        ownerType: owner.ownerType,
        ownerId: owner.id,
        keys: missing,
      });
      onEvent({
        kind: 'log',
        message: `⚠ ${owner.id}: ${missing.length} key(s) failed to download`,
      });
    } else {
      onEvent({
        kind: 'log',
        message: `Assets ${owner.id}: ${stats.written} new, ${stats.deduped} deduped${
          stats.fetched ? '' : ' (no media)'
        }`,
      });
    }
  }

  await storage.writeAssetsSummary(JSON.stringify(summary, null, 2));
  return summary;
}
