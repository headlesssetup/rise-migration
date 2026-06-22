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
}

// Extractors. Two modes:
//  - Whole-value fast path: a string node that IS a single bare key or
//    usercontent URL is taken verbatim — including `(`, `)`, `%2520`, unicode —
//    so filenames like `Group 2 (7).png` are never truncated.
//  - Bounded fallback: for keys embedded inside a larger HTML/text blob, capture
//    each match up to a real delimiter (quote / whitespace / markup / paren).
const RE_WHOLE_VALUE =
  /^(?:https?:\/\/(?:www\.)?articulateusercontent\.com\/)?(rise\/(?:courses|questionBanks)\/\S+)$/i;
const RE_USERCONTENT_URL =
  /https?:\/\/(?:www\.)?articulateusercontent\.com\/([^\s"'<>\\)]+)/gi;
const RE_BARE_RISE_KEY =
  /rise\/(?:courses|questionBanks)\/[^\s"'<>\\)]+/gi;

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
  // Fast path: the entire value is one key/URL — take it whole (parens etc.).
  const whole = value.trim().match(RE_WHOLE_VALUE);
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
  for (const m of value.matchAll(RE_BARE_RISE_KEY)) if (m[0]) add(m[0]);
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
 * Collect the distinct uploaded-media keys in a document (course or bank).
 * Reuses `scanRefs` (with untruncated values) to find media occurrences, drops
 * the non-downloadable kinds, extracts clean keys, and dedups by canonical key.
 */
export function collectAssetKeys(doc: unknown, ownerId?: string): AssetKey[] {
  const byKey = new Map<string, AssetKey>();
  for (const ref of scanRefs(doc, ownerId, { maxSnippet: Infinity })) {
    if (!DOWNLOADABLE.has(ref.kind)) continue;
    const kind = ref.kind as DownloadableKind;
    for (const key of extractUploadedKeys(ref.value)) {
      let entry = byKey.get(key);
      if (!entry) {
        entry = { key, kind, paths: [] };
        byKey.set(key, entry);
      }
      capPush(entry.paths, ref.path);
    }
  }
  return [...byKey.values()];
}
