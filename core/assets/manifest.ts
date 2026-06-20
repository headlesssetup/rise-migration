// Phase 2 — per-owner asset manifest.
//
// Each course / question bank gets an `<id>.assets.json` mapping its uploaded
// media keys → the content-addressed file in the shared `assets/` store, with
// size + checksum (sha256 = the content address = the checksum). Storyline /
// cdn / embed refs are recorded under `skipped` (kept as references, not bytes).

import type { AssetKey, DownloadableKind } from './keys';

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
}

export interface AssetManifest {
  ownerType: OwnerType;
  ownerId: string;
  generatedAt: string;
  /** Distinct keys discovered (= assets.length + failed.length when complete). */
  keyCount: number;
  assets: AssetManifestEntry[];
  failed: AssetFailure[];
  /** True when every discovered key was downloaded (no failures). */
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
  return {
    ownerType,
    ownerId,
    generatedAt,
    keyCount: collected.length,
    assets,
    failed,
    complete: failed.length === 0,
  };
}

export function assetManifestToJson(m: AssetManifest): string {
  return JSON.stringify(m, null, 2);
}

/**
 * Loud-fail check (CLAUDE.md: "no source media keys may survive"): every
 * collected key must resolve to a downloaded asset entry. Returns the keys that
 * did NOT — empty array means the owner's media is fully self-sufficient.
 */
export function findUndownloadedKeys(
  collected: AssetKey[],
  manifest: AssetManifest,
): string[] {
  const have = new Set(manifest.assets.map((a) => a.key));
  return collected.map((c) => c.key).filter((k) => !have.has(k));
}
