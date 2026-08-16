// Phase 2 — per-owner asset manifest.
//
// Each course / question bank gets an `<id>.assets.json` mapping its uploaded
// media keys → the content-addressed file in the shared `assets/` store, with
// size + checksum (sha256 = the content address = the checksum). Storyline /
// cdn / embed refs are recorded under `skipped` (kept as references, not bytes).

import type { AssetKey, DownloadableKind, OptionalAssetReason } from './keys';

/** Increment when the required/optional media classification changes. */
export const ASSET_POLICY_VERSION = 2;

export type OwnerType = 'course' | 'bank';

export interface AssetManifestEntry {
  /** Source S3 key (host-stripped). */
  key: string;
  kind: DownloadableKind;
  /** sha256 hex of the bytes — content address and integrity checksum. */
  hash: string;
  ext: string;
  /** Path within the archive: `assets/<hash>.<ext>`. */
  file: string;
  size: number;
}

export interface AssetFailure {
  key: string;
  error: string;
  /** HTTP status of the last attempt (0/undefined for network errors). */
  status?: number;
  /** The key-path variant last tried against the CDN (diagnostics). */
  urlTried?: string;
  /** JSON path(s) in the source doc where this key was referenced (locating). */
  paths?: string[];
  /** Present when this is unavailable authoring provenance, not live media. */
  optionalReason?: OptionalAssetReason;
}

/**
 * A GET that returns 404 or 403 on the public bucket means the object is
 * missing/inaccessible. `articulateusercontent.com` denies public `ListBucket`,
 * so S3 returns **403 AccessDenied** (not 404) for absent keys — confirmed by
 * probing failing keys (AccessDenied logged-in AND incognito). Such keys are
 * orphaned: unrecoverable via the public CDN, flagged rather than retried.
 */
export function isOrphanStatus(status: number | undefined): boolean {
  return status === 404 || status === 403;
}

export interface AssetManifest {
  ownerType: OwnerType;
  ownerId: string;
  generatedAt: string;
  /** Required/optional reference policy used to build this manifest. */
  assetPolicyVersion?: number;
  /** Distinct keys discovered (= assets.length + failed.length when complete). */
  keyCount: number;
  assets: AssetManifestEntry[];
  /** Every key without bytes: retryable failures, terminal active orphans, and
   *  terminal optional provenance. Terminal rows stay visible across runs and
   *  are never re-fetched (see `priorOrphans`). */
  failed: AssetFailure[];
  /** How many of `failed` are terminal REQUIRED orphans (missing at source).
   *  Absent in manifests written before orphan accounting — treat as unknown. */
  orphanCount: number;
  /** Unavailable non-rendering source/provenance references. */
  optionalUnavailableCount?: number;
  /** True when every fetch reached a terminal state. Required orphans and
   *  optional unavailable refs do not block completion; retryable failures do. */
  complete: boolean;
}

export function buildAssetManifest(
  ownerType: OwnerType,
  ownerId: string,
  collected: AssetKey[],
  assets: AssetManifestEntry[],
  failed: AssetFailure[],
  generatedAt: string = new Date().toISOString(),
): AssetManifest {
  const optionalUnavailableCount = failed.filter(
    (f) => f.optionalReason && isOrphanStatus(f.status),
  ).length;
  const orphanCount = failed.filter(
    (f) => !f.optionalReason && isOrphanStatus(f.status),
  ).length;
  const unresolved = failed.filter((f) => !isOrphanStatus(f.status)).length;
  return {
    ownerType,
    ownerId,
    generatedAt,
    assetPolicyVersion: ASSET_POLICY_VERSION,
    keyCount: collected.length,
    assets,
    failed,
    orphanCount,
    optionalUnavailableCount,
    complete: unresolved === 0,
  };
}

export function assetManifestToJson(m: AssetManifest): string {
  return JSON.stringify(m, null, 2);
}

/**
 * Loud-fail check (CLAUDE.md: "no source media keys may survive"): every
 * required collected key must resolve to a downloaded asset entry. Returns the
 * required keys that did NOT; optional provenance never defines render fidelity.
 */
export function findUndownloadedKeys(
  collected: AssetKey[],
  manifest: AssetManifest,
): string[] {
  const have = new Set(manifest.assets.map((a) => a.key));
  return collected
    .filter((c) => !c.optionalReason)
    .map((c) => c.key)
    .filter((k) => !have.has(k));
}
