// Stage (A)→(B) zip plumbing: read a Rise web-export zip and emit a Review-360
// manual-upload zip for one storyline package.
//
//   web-export.zip
//     content/runtime-data.js            ← the block→leaf→meta map (web-export.ts)
//     content/assets/{leaf}/story.html   ← one storyline package per leaf
//     content/assets/{leaf}/story_content/… , html5/… , mobile/… ,
//                          threeSixty.json , meta.xml
//
// For each storyline leaf we lift `content/assets/{leaf}/**` to the zip ROOT,
// apply the `story.html` web→R360 transform (repackage.ts), and zip — the form
// the Review-360 `items:upload` step expects (story.html + threeSixty.json + …
// at the archive root). We do NOT try to reproduce the original tool's zip bytes
// (compression/ordering/timestamps differ); only the file CONTENTS must match —
// the server unzips it, and our upload md5 is computed over OUR bytes.

import { unzipSync, zipSync } from 'fflate';
import { webStoryHtmlToReview360 } from './repackage';

const RUNTIME_DATA_PATH = 'content/runtime-data.js';
const ASSETS_PREFIX = 'content/assets/';

/** A package as a flat path→bytes map, keyed RELATIVE to the package root
 *  (e.g. `story.html`, `story_content/user.js`, `threeSixty.json`). */
export type PackageFiles = Map<string, Uint8Array>;

/** Fixed zip timestamp (1980-01-01 UTC, the earliest DOS zip date) so output is
 *  deterministic and carries no wall-clock. fflate rejects pre-1980 dates. */
const FIXED_MTIME = Date.UTC(1980, 0, 1);

/** Unzip raw bytes into a path→bytes map. Thin wrapper over fflate so the rest
 *  of the module (and tests) work with a plain Map. */
export function unzipToMap(bytes: Uint8Array): Map<string, Uint8Array> {
  const obj = unzipSync(bytes);
  const map = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(obj)) map.set(path, data);
  return map;
}

/** Read `content/runtime-data.js` from an unzipped web export (decoded UTF-8).
 *  @throws if absent — without it we can't map blocks to leaves. */
export function getRuntimeDataJs(files: Map<string, Uint8Array>): string {
  const data = files.get(RUNTIME_DATA_PATH);
  if (!data) throw new Error(`web export missing ${RUNTIME_DATA_PATH}`);
  return new TextDecoder().decode(data);
}

/** List the storyline package leaves physically present under
 *  `content/assets/{leaf}/` (a directory containing a `story.html`). */
export function listPackageLeaves(files: Map<string, Uint8Array>): string[] {
  const leaves = new Set<string>();
  for (const path of files.keys()) {
    if (!path.startsWith(ASSETS_PREFIX)) continue;
    const rest = path.slice(ASSETS_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) continue;
    const leaf = rest.slice(0, slash);
    if (rest.slice(slash + 1) === 'story.html') leaves.add(leaf);
  }
  return [...leaves];
}

/**
 * Extract one storyline package (`content/assets/{leaf}/**`) re-rooted to the
 * package root. Zero-length directory entries are dropped. The returned map is
 * exactly what {@link buildReview360Zip} expects.
 * @throws if the leaf has no `story.html` (not a storyline package).
 */
export function extractPackage(files: Map<string, Uint8Array>, leaf: string): PackageFiles {
  const prefix = `${ASSETS_PREFIX}${leaf}/`;
  const out: PackageFiles = new Map();
  for (const [path, data] of files) {
    if (!path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    if (rel === '' || rel.endsWith('/')) continue; // directory entry
    out.set(rel, data);
  }
  if (!out.has('story.html')) {
    throw new Error(`package ${leaf} has no story.html (not a storyline package)`);
  }
  return out;
}

/**
 * Build a Review-360 manual-upload zip from a package file map: apply the
 * `story.html` web→R360 transform (idempotent) and place every file at the zip
 * root. Returns the zip bytes (the caller md5s + uploads them).
 */
export function buildReview360Zip(pkg: PackageFiles): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [rel, data] of pkg) {
    if (rel === 'story.html') {
      // ignoreBOM: keep a leading UTF-8 BOM (the real Storyline story.html has
      // one). The default TextDecoder strips it, which left our story.html 3 bytes
      // short of the genuine package and made Review 360 reject the item version.
      const html = new TextDecoder('utf-8', { ignoreBOM: true }).decode(data);
      entries[rel] = new TextEncoder().encode(webStoryHtmlToReview360(html));
    } else {
      entries[rel] = data;
    }
  }
  // Fixed mtime → deterministic output for a given input (no wall-clock).
  return zipSync(entries, { mtime: FIXED_MTIME });
}

/** Convenience: web-export zip bytes + leaf → Review-360 zip bytes. */
export function repackageLeafFromWebExport(webExportZip: Uint8Array, leaf: string): Uint8Array {
  const files = unzipToMap(webExportZip);
  return buildReview360Zip(extractPackage(files, leaf));
}
