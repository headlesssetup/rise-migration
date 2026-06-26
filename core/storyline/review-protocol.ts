// Stage (C) — Review-360 upload over the `360-review-sockets` Socket.IO channel
// (namespace `/user/{userId}`). This module is the PURE payload layer: it builds
// the emit arguments and parses the bits we read back. The live engine.io/
// Socket.IO plumbing (handshake, namespace connect with `{token}`, emit-with-ack)
// lives in `review-socket-client.ts`.
//
// Capture-confirmed sequence (`59fc7396-mitmuploadwithsockets.txt`):
//   emit items:create {title, projectId, product:"storyline", platform, userId,
//        folderId:"private", versions:[{state:"uploading", package:{}, …}]}  → item {id}
//   emit yurl:get  "acl=public-read&keyPrefix=review/uploads&fileName=X.zip&md5=<b64>"  → presigned PUT url
//   (S3 PUT the zip bytes — see ws/import relay; Content-MD5 = same base64 md5)
//   emit items:update {versions:[{state:"uploading", package:{key, md5_checksum:<hex>}}], id}
//   emit items:upload {id, type:"storyline"}      → server unzips + publishes review/items/{leaf}
//   (readiness via items:get, or the REST /review/items list — parseContentPrefix below)

/** Socket.IO event names used by the upload handshake. */
export const REVIEW_EVENTS = {
  create: 'items:create',
  yurlGet: 'yurl:get',
  update: 'items:update',
  upload: 'items:upload',
  get: 'items:get',
} as const;

/** Default publish platform — mirrors the captured Storyline web publish. */
export const DEFAULT_PLATFORM = { os: 'windows', type: 'web' } as const;

export interface ItemsCreateArgs {
  /** Display title + projectId. The capture used the zip filename for both. */
  title: string;
  projectId?: string;
  userId: string;
  /** ISO timestamp for the version record; reuse the SAME value in items:update. */
  createdAt: string;
  folderId?: string;
  platform?: { os: string; type: string };
}

/** `items:create` payload — creates the review item in "uploading" state; the
 *  ack carries the new item `id` (a UUID). */
export function buildItemsCreate(args: ItemsCreateArgs): Record<string, unknown> {
  return {
    title: args.title,
    projectId: args.projectId ?? args.title,
    product: 'storyline',
    platform: args.platform ?? { ...DEFAULT_PLATFORM },
    userId: args.userId,
    folderId: args.folderId ?? 'private',
    versions: [
      {
        createdAt: args.createdAt,
        package: {},
        thumbnail: {},
        progress: 0,
        state: 'uploading',
        userId: args.userId,
      },
    ],
  };
}

/**
 * `yurl:get` argument — a URL-encoded query STRING (not an object), exactly as
 * captured: `acl=public-read&keyPrefix=review/uploads&fileName=<name>&md5=<base64>`.
 * `URLSearchParams` encodes `/` → `%2F`, `=`/`+` in the md5, etc., matching the
 * captured `keyPrefix=review%2Fuploads` and `md5=…%3D%3D`.
 */
export function buildYurlGetArg(args: { fileName: string; md5Base64: string }): string {
  const qs = new URLSearchParams();
  qs.set('acl', 'public-read');
  qs.set('keyPrefix', 'review/uploads');
  qs.set('fileName', args.fileName);
  qs.set('md5', args.md5Base64);
  return qs.toString();
}

/**
 * Derive the S3 object key from a presigned PUT url, e.g.
 * `https://360-prod-…amazonaws.com/review/uploads/{prefix}/x.zip?X-Amz-…`
 * → `review/uploads/{prefix}/x.zip`. The key is the decoded pathname sans the
 * leading slash; query string is dropped.
 */
export function deriveKeyFromUrl(url: string): string {
  // Accept a bare path too (tests / odd acks).
  const noQuery = url.split('?')[0]!;
  const path = noQuery.replace(/^https?:\/\/[^/]+\//, '').replace(/^\//, '');
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Normalize a `yurl:get` ack into `{url, key}`. The ack shape wasn't in the
 * capture (it ended early), so accept the plausible forms: a bare URL string, or
 * an object under `url`/`uploadUrl`/`signedUrl`/`yurl`. The key is taken from an
 * explicit `key`/`keyPrefix` field when present, else derived from the URL path.
 * @throws if no URL can be found (caller loud-fails).
 */
export function parseYurlAck(ack: unknown): { url: string; key: string } {
  let url: string | undefined;
  let key: string | undefined;
  if (typeof ack === 'string') {
    url = ack;
  } else if (typeof ack === 'object' && ack !== null) {
    const r = ack as Record<string, unknown>;
    for (const k of ['url', 'uploadUrl', 'signedUrl', 'yurl', 'presignedUrl'] as const) {
      if (typeof r[k] === 'string') {
        url = r[k] as string;
        break;
      }
    }
    if (typeof r.key === 'string') key = r.key;
  }
  if (!url) throw new Error(`yurl:get ack had no upload url: ${JSON.stringify(ack).slice(0, 200)}`);
  return { url, key: key ?? deriveKeyFromUrl(url) };
}

export interface ItemsUpdateArgs {
  id: string;
  /** S3 object key the bytes were PUT to (from the yurl ack). */
  key: string;
  /** Hex MD5 of the uploaded zip (matches the base64 md5 sent to yurl:get). */
  md5Hex: string;
  userId: string;
  /** SAME createdAt used in items:create (identifies the version record). */
  createdAt: string;
  progress?: number;
  state?: string;
}

/** `items:update` payload — records the uploaded package key + checksum on the
 *  item's version, after the S3 PUT completes. */
export function buildItemsUpdate(args: ItemsUpdateArgs): Record<string, unknown> {
  return {
    versions: [
      {
        state: args.state ?? 'uploading',
        userId: args.userId,
        package: { key: args.key, md5_checksum: args.md5Hex },
        progress: args.progress ?? 0,
        createdAt: args.createdAt,
        thumbnail: {},
      },
    ],
    id: args.id,
    sendBroadcastMessages: false,
  };
}

/** `items:upload` payload — triggers server-side unzip/transcode/publish. */
export function buildItemsUpload(args: { id: string; type?: string }): Record<string, unknown> {
  return { id: args.id, type: args.type ?? 'storyline' };
}

/** `items:get` argument tuple body — `(id, {pass, protectedLinksFlagEnabled})`. */
export function buildItemsGetArg(id: string): { id: string; opts: Record<string, unknown> } {
  return { id, opts: { pass: null, protectedLinksFlagEnabled: true } };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Pull the published `contentPrefix` (`review/items/{leaf}`) out of a review item
 * — whether from an `items:get` ack or a `/review/items` list entry. Looks at the
 * item's `contentPrefix`, else its latest ready version's `package.key` prefix.
 * Returns null if not yet published (caller keeps polling).
 */
export function parseContentPrefix(item: unknown): string | null {
  if (!isObject(item)) return null;
  // Unwrap a single-item ack envelope. `items:get` returns
  // `{success:true, value:{…}}` (capture-confirmed); also tolerate {item}/{data}.
  const node = isObject(item.value)
    ? item.value
    : isObject(item.item)
      ? item.item
      : isObject(item.data)
        ? item.data
        : item;
  if (!isObject(node)) return null;

  if (typeof node.contentPrefix === 'string' && node.contentPrefix) {
    return node.contentPrefix;
  }
  // Fallback: derive from a ready version's package key
  // (review/items/{leaf}/story_content/… → review/items/{leaf}).
  const versions = Array.isArray(node.versions) ? node.versions : [];
  for (const v of versions) {
    if (!isObject(v)) continue;
    const pkg = isObject(v.package) ? v.package : undefined;
    const key = pkg && typeof pkg.key === 'string' ? pkg.key : undefined;
    const m = key?.match(/^(review\/items\/[^/]+)/);
    if (m) return m[1]!;
  }
  return null;
}

/** True when an item's newest version reports a terminal "ready"/"published"
 *  state (vs "uploading"/"processing"). */
export function isItemReady(item: unknown): boolean {
  if (!isObject(item)) return false;
  const node = isObject(item.value) ? item.value : isObject(item.item) ? item.item : item;
  // A published item exposes a contentPrefix; treat that as the readiness signal
  // (the `items:get` value carries it once processing finishes).
  if (isObject(node) && typeof node.contentPrefix === 'string' && node.contentPrefix) return true;
  const versions = isObject(node) && Array.isArray(node.versions) ? node.versions : [];
  const last = versions[versions.length - 1];
  const state = isObject(last) && typeof last.state === 'string' ? last.state : '';
  return state === 'ready' || state === 'published' || state === 'complete';
}
