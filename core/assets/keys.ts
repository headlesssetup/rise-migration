// Phase 2 — uploaded-media key collection.
//
// Reuses the generic census scanner (`scanRefs`) to enumerate media occurrences,
// then extracts the *clean, downloadable* S3 keys from each occurrence value.
// A single string node can be a bare key, a usercontent URL, or rich-text HTML
// that embeds one or more usercontent URLs — so extraction is a global regex
// pass, not "treat the whole value as the key".
//
// Only uploaded media is collected (image/video/audio/other). Storyline bundles,
// cdn.articulate.com, YouTube/Vimeo embeds, and cross-refs are NOT downloaded
// (CLAUDE.md / STATUS.md): they're kept as references.

import { scanRefs, type RefKind } from '@/core/census/scan';

/** The uploaded-media kinds we download (Storyline is excluded — kept as ref). */
export type DownloadableKind =
  | 'media-image'
  | 'media-video'
  | 'media-audio'
  | 'media-other';

const DOWNLOADABLE = new Set<RefKind>([
  'media-image',
  'media-video',
  'media-audio',
  'media-other',
]);

export interface AssetKey {
  /** Canonical S3 key — append to `articulateusercontent.com/` to download. */
  key: string;
  kind: DownloadableKind;
  /** JSON paths where this key was found (deduped, capped). */
  paths: string[];
  /**
   * The bytes improve authoring provenance but are not used to render the
   * current course. A key is optional only when EVERY occurrence is optional;
   * one active occurrence promotes it back to required.
   */
  optionalReason?: OptionalAssetReason;
}

export type OptionalAssetReason =
  | 'input-source'
  | 'temporary-media'
  | 'original-image'
  | 'inactive-image-variant';

// Extractors. Two modes:
//  - Whole-value fast path: a string node that IS a single bare key or
//    usercontent URL is taken verbatim — including `(`, `)`, `%2520`, unicode —
//    so filenames like `Group 2 (7).png` are never truncated.
//  - Bounded fallback: for keys embedded inside a larger HTML/text blob, capture
//    each match up to a real delimiter (quote / whitespace / markup / paren /
//    `=` `,` `;` separators). The boundary classes mirror the census scanner's
//    RE_RISE_KEY (core/census/scan.ts) so every string the scanner classifies
//    as media yields its keys here: the bare-key match requires the same
//    leading delimiter (so `enterprise/courses/…` can't shed a bogus
//    `rise/courses/…` key), and both bounded matches stop at the same trailing
//    separators (so `key1,key2` srcset-style lists don't fuse into one key).
const RE_WHOLE_VALUE =
  /^(?:https?:\/\/(?:www\.)?articulateusercontent\.(?:com|eu)\/)?(rise\/(?:courses|questionBanks)\/\S+)$/i;
const RE_USERCONTENT_URL =
  /https?:\/\/(?:www\.)?articulateusercontent\.(?:com|eu)\/([^\s"'<>\\)=,;]+)/gi;
const RE_BARE_RISE_KEY =
  /(?:^|[/"'\s(=,>;])(rise\/(?:courses|questionBanks)\/[^\s"'<>\\)=,;]+)/gi;

/** Strip a trailing `?query`/`#fragment` and any trailing punctuation that the
 *  bounded char class may have swept up at a sentence/markup boundary. */
function canonicalizeKey(raw: string): string {
  const head = raw.split(/[?#]/, 1)[0] ?? raw;
  return head.replace(/[.,;:]+$/, ''); // trailing sentence punctuation, not extensions
}

/**
 * Pull every uploaded-media key out of a single string value. Handles a bare
 * key, a full usercontent URL, and HTML/JSON that embeds one or more URLs.
 * Returns canonical keys (host-stripped, no query/fragment), order-preserving
 * and de-duplicated.
 */
export function extractUploadedKeys(value: string): string[] {
  // A whole transformed URL (notably images.articulate.com posters) may carry
  // literal parentheses in its filename. Parse the pathname instead of using
  // the bounded embedded-text regex, whose `)` delimiter is correct for CSS
  // `url(...)` but used to truncate `(1).mp4` into a bogus key ending in `(1`.
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const pathname = new URL(trimmed).pathname.replace(/^\//, '');
      const start = pathname.search(/(?:^|\/)rise\/(?:courses|questionBanks)\//);
      if (start >= 0) {
        const key = pathname.slice(start).replace(/^\//, '');
        if (/^rise\/(?:courses|questionBanks)\//.test(key)) {
          return [canonicalizeKey(key)];
        }
      }
    } catch {
      // Fall through to the tolerant extractors for malformed/embedded text.
    }
  }

  // Fast path: the entire value is one key/URL — take it whole (parens etc.).
  const whole = trimmed.match(RE_WHOLE_VALUE);
  if (whole?.[1]) return [canonicalizeKey(whole[1])];

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const key = canonicalizeKey(raw);
    // Only course/bank UPLOADS are migratable. A usercontent URL can also point
    // at a built-in SHARED asset (`assets/rise/...themes/...`) — those are kept
    // as references, never re-uploaded/flagged, so exclude anything that isn't
    // under rise/courses/ or rise/questionBanks/.
    if (key && /^rise\/(?:courses|questionBanks)\//.test(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  };
  for (const m of value.matchAll(RE_USERCONTENT_URL)) if (m[1]) add(m[1]);
  for (const m of value.matchAll(RE_BARE_RISE_KEY)) if (m[1]) add(m[1]);
  return out;
}

const CT_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
};

/** Lower-cased file extension from a key's last path segment, or '' if none /
 *  implausible (used for the content-addressed filename `assets/<hash>.<ext>`). */
export function extFromKey(key: string): string {
  const seg = key.split('/').pop() ?? '';
  const dot = seg.lastIndexOf('.');
  if (dot <= 0 || dot === seg.length - 1) return '';
  const ext = seg.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : '';
}

/** Map a Content-Type header to a file extension, or '' if unknown. */
export function extFromContentType(contentType: string | undefined): string {
  if (!contentType) return '';
  const ct = (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
  return CT_EXT[ct] ?? '';
}

function capPush(arr: string[], value: string, cap = 5): void {
  if (arr.length < cap && !arr.includes(value)) arr.push(value);
}

/**
 * Classify JSON fields which Rise retains for editing/history but does not use
 * to render the current course. This remains a generic recursive walk: it is
 * based on media-object contracts, never block family/variant names.
 *
 * Capture-confirmed examples (2026-08-16):
 * - audio/video `inputKey` is the pre-transcode source; playback uses `key`;
 * - `media.tmp` is abandoned staging state;
 * - `originalImage` is the uncropped source; the parent image is current;
 * - `useCrushedKey` selects exactly one active image variant.
 */
function optionalAssetPaths(doc: unknown): Map<string, OptionalAssetReason> {
  const out = new Map<string, OptionalAssetReason>();
  const walk = (
    node: unknown,
    path: string,
    inherited?: OptionalAssetReason,
  ): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`, inherited));
      return;
    }

    const obj = node as Record<string, unknown>;
    const fieldReasons = new Map<string, OptionalAssetReason>();
    if (
      typeof obj.inputKey === 'string' &&
      typeof obj.key === 'string' &&
      obj.inputKey !== obj.key
    ) {
      fieldReasons.set('inputKey', 'input-source');
    }
    if (
      obj.useCrushedKey === true &&
      typeof obj.key === 'string' &&
      typeof obj.crushedKey === 'string' &&
      obj.key !== obj.crushedKey
    ) {
      fieldReasons.set('key', 'inactive-image-variant');
    } else if (
      obj.useCrushedKey === false &&
      typeof obj.key === 'string' &&
      typeof obj.crushedKey === 'string' &&
      obj.key !== obj.crushedKey
    ) {
      fieldReasons.set('crushedKey', 'inactive-image-variant');
    }

    for (const [k, value] of Object.entries(obj)) {
      const childPath = `${path}.${k}`;
      const reason =
        inherited ??
        (k === 'tmp' && /(?:^|\.)media$/.test(path)
          ? 'temporary-media'
          : k === 'originalImage'
            ? 'original-image'
            : fieldReasons.get(k));
      if (reason && typeof value === 'string') out.set(childPath, reason);
      walk(value, childPath, reason);
    }
  };
  walk(doc, '$');
  return out;
}

/**
 * Collect the distinct uploaded-media keys in a document (course or bank).
 * Reuses `scanRefs` (with untruncated values) to find media occurrences, drops
 * the non-downloadable kinds, extracts clean keys, and dedups by canonical key.
 */
export function collectAssetKeys(doc: unknown, ownerId?: string): AssetKey[] {
  const byKey = new Map<string, AssetKey>();
  const optionalPaths = optionalAssetPaths(doc);
  for (const ref of scanRefs(doc, ownerId, { maxSnippet: Infinity })) {
    if (!DOWNLOADABLE.has(ref.kind)) continue;
    const kind = ref.kind as DownloadableKind;
    const optionalReason = optionalPaths.get(ref.path);
    for (const key of extractUploadedKeys(ref.value)) {
      let entry = byKey.get(key);
      if (!entry) {
        entry = { key, kind, paths: [], optionalReason };
        byKey.set(key, entry);
      } else if (!optionalReason) {
        // One live occurrence makes the bytes required even if another path
        // happens to retain the same key as provenance/staging data.
        delete entry.optionalReason;
      }
      capPush(entry.paths, ref.path);
    }
  }
  return [...byKey.values()];
}
