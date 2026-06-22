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
  /** The key-path variant that was fetched (for diagnostics). */
  urlTried?: string;
}

export type Downloader = (key: string) => Promise<DownloadOutcome>;

/** Decode a key to its literal form, peeling double/triple percent-encoding
 *  (`%2520` → `%20` → space). Guarded against malformed `%` sequences. */
function decodeToLiteral(key: string): string {
  let cur = key;
  for (let i = 0; i < 3; i++) {
    let dec: string;
    try {
      dec = decodeURIComponent(cur);
    } catch {
      break;
    }
    if (dec === cur) break;
    cur = dec;
  }
  return cur;
}

/** Percent-encode each path segment (preserving `/`) for a CDN request. */
function encodePath(literal: string): string {
  return literal.split('/').map(encodeURIComponent).join('/');
}

/**
 * Candidate key-paths to try against the CDN, in order, de-duplicated:
 *   1. verbatim (correct for already single-encoded keys),
 *   2. normalized single-encoding (fixes `%2520` double-encoding + literals),
 *   3. NFC-normalized (fixes NFD combining-mark filenames).
 * Append each to the CDN base to form the request URL.
 */
export function keyPathCandidates(key: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string): void => {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  add(key);
  const literal = decodeToLiteral(key);
  add(encodePath(literal));
  try {
    add(encodePath(literal.normalize('NFC')));
  } catch {
    /* normalize unsupported — skip */
  }
  return out;
}

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
  /** Keys carried over from a prior manifest without re-fetching (resume). */
  reused: number;
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

export interface KeyDownloadResult {
  /** key → stored file path `assets/<sha256>.<ext>` (successes only). */
  files: Record<string, string>;
  failed: { key: string; error: string; status?: number }[];
  written: number;
  deduped: number;
}

/**
 * Download a flat list of CDN keys (e.g. typeface fonts under rise/fonts/…) and
 * store them content-addressed via the sink. Parallel pool; dedup by content.
 */
export async function downloadKeyList(
  keys: string[],
  sink: AssetSink,
  downloader: Downloader,
  concurrency = DEFAULT_CONCURRENCY,
  /** Path prefix recorded in each entry's `file` (where the sink stores it).
   *  Account fonts use `account/assets/`; course media uses `assets/`. */
  filePrefix = 'assets/',
): Promise<KeyDownloadResult> {
  const results = await runPool(keys, concurrency, async (key): Promise<PerKeyResult> => {
    const res = await downloader(key);
    if (!res.ok || !res.bytes) {
      return { failure: { key, error: res.error ?? `HTTP ${res.status ?? 0}`, status: res.status } };
    }
    const hash = await sha256Hex(res.bytes);
    const ext = extFromKey(key) || extFromContentType(res.contentType) || 'bin';
    const name = `${hash}.${ext}`;
    const existed = await sink.hasAsset(name);
    if (!existed) await sink.writeAsset(name, res.bytes);
    return {
      wrote: !existed,
      entry: { key, kind: 'media-other', hash, ext, file: `${filePrefix}${name}`, size: res.bytes.byteLength },
    };
  });

  const out: KeyDownloadResult = { files: {}, failed: [], written: 0, deduped: 0 };
  for (const r of results) {
    if (r.entry) {
      out.files[r.entry.key] = r.entry.file;
      if (r.wrote) out.written += 1;
      else out.deduped += 1;
    } else if (r.failure) {
      out.failed.push(r.failure);
    }
  }
  return out;
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
  reused?: boolean;
}

/**
 * Download every uploaded-media key in `doc`, store bytes content-addressed
 * (`assets/<sha256>.<ext>`, written once), and return the manifest + stats.
 * Downloads run in parallel (pool) since the CDN is public-read.
 *
 * `opts.priorAssets` (from a previous manifest) are reused without re-fetching —
 * this drives cheap resume: a re-run only fetches keys that are new or failed.
 */
export async function downloadAssetsFor(
  ownerType: OwnerType,
  ownerId: string,
  doc: unknown,
  sink: AssetSink,
  downloader: Downloader,
  opts: {
    concurrency?: number;
    generatedAt?: string;
    priorAssets?: AssetManifestEntry[];
  } = {},
): Promise<DownloadResult> {
  const collected = collectAssetKeys(doc, ownerId);
  const reuse = new Map((opts.priorAssets ?? []).map((e) => [e.key, e]));

  const perKey = await runPool(
    collected,
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    async (ak): Promise<PerKeyResult> => {
      const prior = reuse.get(ak.key);
      if (prior) return { entry: prior, reused: true };

      const res = await downloader(ak.key);
      if (!res.ok || !res.bytes) {
        return {
          failure: {
            key: ak.key,
            error: res.error ?? `HTTP ${res.status ?? 0}`,
            status: res.status,
            urlTried: res.urlTried,
            paths: ak.paths,
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
  let reused = 0;
  for (const r of perKey) {
    if (r.entry) {
      assets.push(r.entry);
      if (r.reused) reused += 1;
      else if (r.wrote) written += 1;
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
    stats: {
      fetched: written + deduped,
      written,
      deduped,
      reused,
      failed: failed.length,
    },
  };
}
