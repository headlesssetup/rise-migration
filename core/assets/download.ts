// Phase 2 — asset download orchestration (pure / injectable).
//
// Given a document, an injected `Downloader` (real one fetches the public CDN),
// and a narrow `AssetSink` (the binary side of Storage), this downloads every
// uploaded-media key, stores the bytes content-addressed (dedup by sha256), and
// returns the per-owner manifest + run stats. No human-pacing — the 2s pacing
// invariant is scoped to the Rise authoring API, not the public CDN, so CDN
// downloads run through a bounded-concurrency pool (default 4).

import { collectAssetKeys, extFromContentType, extFromKey } from './keys';
import {
  buildAssetManifest,
  type AssetFailure,
  type AssetManifest,
  type AssetManifestEntry,
  type OwnerType,
} from './manifest';

export const DEFAULT_CONCURRENCY = 4;

export interface DownloadOutcome {
  ok: boolean;
  bytes?: Uint8Array;
  status?: number;
  contentType?: string;
  error?: string;
}

export type Downloader = (key: string) => Promise<DownloadOutcome>;

/** The binary surface of Storage that the downloader needs (FileSystemStorage
 *  satisfies it). Keeping it narrow makes the core testable with a Map sink. */
export interface AssetSink {
  hasAsset(name: string): Promise<boolean>;
  writeAsset(name: string, bytes: Uint8Array): Promise<void>;
}

export interface DownloadStats {
  /** Keys successfully fetched from the CDN. */
  fetched: number;
  /** New asset files written to the store. */
  written: number;
  /** Fetched keys whose bytes were already on disk (content dedup). */
  deduped: number;
  /** Keys that failed to download. */
  failed: number;
}

export interface DownloadResult {
  manifest: AssetManifest;
  stats: DownloadStats;
}

/** Bounded-concurrency map preserving input order. */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const lanes = Math.max(1, Math.min(concurrency, items.length || 1));
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: lanes }, run));
  return results;
}

/** sha256 hex of bytes — the content address + integrity checksum. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface PerKeyResult {
  entry?: AssetManifestEntry;
  failure?: AssetFailure;
  wrote?: boolean;
}

/**
 * Download every uploaded-media key in `doc`, store bytes content-addressed
 * (`assets/<sha256>.<ext>`, written once), and return the manifest + stats.
 * Downloads run in parallel (pool) since the CDN is public-read.
 */
export async function downloadAssetsFor(
  ownerType: OwnerType,
  ownerId: string,
  doc: unknown,
  sink: AssetSink,
  downloader: Downloader,
  opts: { concurrency?: number; generatedAt?: string } = {},
): Promise<DownloadResult> {
  const collected = collectAssetKeys(doc, ownerId);

  const perKey = await runPool(
    collected,
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    async (ak): Promise<PerKeyResult> => {
      const res = await downloader(ak.key);
      if (!res.ok || !res.bytes) {
        return {
          failure: {
            key: ak.key,
            error: res.error ?? `HTTP ${res.status ?? 0}`,
          },
        };
      }
      const bytes = res.bytes;
      const hash = await sha256Hex(bytes);
      const ext = extFromKey(ak.key) || extFromContentType(res.contentType) || 'bin';
      const name = `${hash}.${ext}`;
      const existed = await sink.hasAsset(name);
      if (!existed) await sink.writeAsset(name, bytes);
      return {
        wrote: !existed,
        entry: {
          key: ak.key,
          kind: ak.kind,
          hash,
          ext,
          file: `assets/${name}`,
          size: bytes.byteLength,
        },
      };
    },
  );

  const assets: AssetManifestEntry[] = [];
  const failed: AssetFailure[] = [];
  let written = 0;
  let deduped = 0;
  for (const r of perKey) {
    if (r.entry) {
      assets.push(r.entry);
      if (r.wrote) written += 1;
      else deduped += 1;
    } else if (r.failure) {
      failed.push(r.failure);
    }
  }

  return {
    manifest: buildAssetManifest(
      ownerType,
      ownerId,
      collected,
      assets,
      failed,
      opts.generatedAt,
    ),
    stats: { fetched: assets.length, written, deduped, failed: failed.length },
  };
}
