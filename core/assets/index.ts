// Phase 2 — asset extraction (export side). Collect uploaded-media keys, download
// the bytes from the public CDN, and store them content-addressed with a
// per-owner manifest. See keys.ts / manifest.ts / download.ts.

export {
  collectAssetKeys,
  extractUploadedKeys,
  extFromKey,
  extFromContentType,
  type AssetKey,
  type DownloadableKind,
} from './keys';
export {
  buildAssetManifest,
  assetManifestToJson,
  findUndownloadedKeys,
  type AssetManifest,
  type AssetManifestEntry,
  type AssetFailure,
  type OwnerType,
} from './manifest';
export {
  downloadAssetsFor,
  runPool,
  sha256Hex,
  DEFAULT_CONCURRENCY,
  type AssetSink,
  type Downloader,
  type DownloadOutcome,
  type DownloadResult,
  type DownloadStats,
} from './download';
