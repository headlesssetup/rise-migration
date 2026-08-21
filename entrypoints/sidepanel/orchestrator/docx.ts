// Rise → Docx live sources (v0.9.0). Everything here is TRANSIENT: one course
// is fetched into memory, rendered to .docx, and discarded — nothing is written
// to the archive ("save a document" must never mutate operator-managed input).
//
// Pacing: each generate is ONE paced authoring read (GET_COURSE), and each
// search click is ONE list page — human-paced by the click itself. Image bytes
// come from the public CDN (articulateusercontent), which is explicitly OUTSIDE
// the pacing invariant. Do NOT add batch docx generation here without a
// strictly sequential paced loop with [i/N] logging.
import { extFromContentType, extFromKey } from '@/core/assets';
import type { ResolvedImage, SbCourse } from '@/core/storyboard';
import type { TabPin } from '@/shared/messaging';
import type { GetCourseDocument, SearchResultItem } from '@/shared/types/rise';
import { rpc } from '../rpc';
import { cdnBasesForPlane, makeCdnDownloader } from './assets';
import { extractItems, unwrap, type ProgressEvent } from './shared';

/** Raster formats the prose writer can embed (SVG is skipped, like the
 *  archive-backed image path). */
const RASTER_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

/**
 * Cap for EMBEDDED image pixels. The doc shows images at most 15 cm wide, so
 * ~1800 px is still >300 dpi print quality — while a real course served
 * 6240×4160 originals (8 MB each) and one export came out 24 MB. Anything
 * wider is re-encoded; smaller images are embedded untouched.
 */
export const MAX_EMBED_PX = 1800;
const JPEG_QUALITY = 0.82;

/**
 * Downscale one oversized raster to {@link MAX_EMBED_PX} using the panel's
 * OffscreenCanvas. Returns the original bytes unchanged when the image is
 * already small enough, when the format is animated (GIF — re-encoding would
 * flatten it), or on ANY decode/encode failure: a thumbnail is a convenience,
 * never a reason to fail a docx export.
 */
export async function shrinkForEmbed(
  bytes: Uint8Array,
  ext: string,
): Promise<{ bytes: Uint8Array; ext: string; width: number; height: number } | null> {
  if (ext === 'gif') return null;
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
  let bitmap: ImageBitmap | undefined;
  try {
    // Copy into a fresh buffer: Blob wants an ArrayBuffer, and `bytes` may be a
    // view into a larger one.
    bitmap = await createImageBitmap(new Blob([bytes.slice().buffer]));
    if (bitmap.width <= MAX_EMBED_PX && bitmap.height <= MAX_EMBED_PX) return null;
    const scale = MAX_EMBED_PX / Math.max(bitmap.width, bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    // PNG stays PNG (transparency); everything else re-encodes as JPEG.
    const type = ext === 'png' ? 'image/png' : 'image/jpeg';
    const blob = await canvas.convertToBlob({ type, quality: JPEG_QUALITY });
    const out = new Uint8Array(await blob.arrayBuffer());
    if (out.length === 0 || out.length >= bytes.length) return null; // no win
    return { bytes: out, ext: type === 'image/png' ? 'png' : 'jpg', width, height };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

/** Mirrors the Rise UI page size — we page like a person. */
export const DOCX_SEARCH_PAGE_SIZE = 16;

/**
 * Resolve the Rise tab a live docx generate is pinned to. Pinning at
 * generate-click freezes the run's target: an unpinned GET_COURSE follows the
 * ACTIVE Rise tab, so switching accounts between search and generate could
 * silently fetch from the wrong account (W5).
 */
export async function pinRiseTabForDocx(): Promise<TabPin & { url: string }> {
  const resp = await rpc({ type: 'PIN_RISE_TAB' });
  if (resp.type !== 'RISE_TAB_PIN') {
    throw new Error(
      resp.type === 'ERROR'
        ? resp.error
        : `unexpected background response: ${resp.type}`,
    );
  }
  if (!resp.result.ok) throw new Error(resp.result.error);
  return resp.result.data;
}

/** One search page (0-indexed) against the live account. One rpc per click —
 *  the operator's click IS the pacing between pages. */
export async function searchCoursesPage(
  page: number,
  term: string | undefined,
  onEvent: (e: ProgressEvent) => void,
): Promise<{ items: SearchResultItem[]; totalCount: number | null }> {
  onEvent({ kind: 'log', message: `Searching the account — page ${page}…` });
  const resp = await rpc({
    type: 'SEARCH_COURSES',
    page,
    pageSize: DOCX_SEARCH_PAGE_SIZE,
    term: term || undefined,
  });
  if (resp.type !== 'SEARCH_RESULT') {
    throw new Error(
      resp.type === 'ERROR'
        ? resp.error
        : `unexpected background response: ${resp.type}`,
    );
  }
  if (!resp.result.ok) throw new Error(resp.result.error);
  const data = resp.result.data;
  const tc = (data as Record<string, unknown>)?.totalCount;
  return {
    items: extractItems(data),
    totalCount: typeof tc === 'number' ? tc : null,
  };
}

/** Fetch ONE course document from the live account (a single paced authoring
 *  read), unwrapped in memory. Never persisted. */
export async function fetchCourseForDocx(
  courseId: string,
  onEvent: (e: ProgressEvent) => void,
  pin?: TabPin,
): Promise<GetCourseDocument> {
  onEvent({
    kind: 'log',
    message: `Fetching course ${courseId} from the account (one paced read)…`,
  });
  const resp = await rpc({ type: 'GET_COURSE', courseId, ...(pin ? { pin } : {}) });
  if (resp.type !== 'COURSE_RESULT') {
    throw new Error(
      resp.type === 'ERROR'
        ? resp.error
        : `unexpected background response: ${resp.type}`,
    );
  }
  if (!resp.result.ok) throw new Error(resp.result.error);
  return unwrap(resp.result.data.raw);
}

/**
 * Resolve prose images for a LIVE-fetched course from the public CDN, entirely
 * in memory (never written to the archive). Uploaded-media keys are served
 * public-read by key — no auth; CDN byte transfers are outside the pacing
 * invariant. ONLY articulateusercontent hosts are fetched here — never rise.*.
 */
export async function resolveImagesFromCdn(
  model: SbCourse,
  plane: 'us' | 'eu' | null,
  onEvent: (e: ProgressEvent) => void,
): Promise<Map<string, ResolvedImage>> {
  const images = new Map<string, ResolvedImage>();
  const needed = new Map<string, { width?: number; height?: number }>();
  for (const lesson of model.lessons) {
    for (const row of lesson.rows) {
      if (row.image?.key && !needed.has(row.image.key)) {
        needed.set(row.image.key, row.image);
      }
    }
  }
  if (needed.size === 0) return images;

  const bases = cdnBasesForPlane(plane);
  onEvent({
    kind: 'log',
    message: `Downloading ${needed.size} image(s) from ${bases.join(' / ')} (in-memory, nothing written to the archive)…`,
  });
  const download = makeCdnDownloader(bases);
  let resolved = 0;
  let skipped = 0;
  let shrunk = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  for (const [key, dims] of needed) {
    const out = await download(key);
    const rawExt = extFromKey(key) || extFromContentType(out.contentType);
    if (!out.ok || !out.bytes || !RASTER_EXTS.has(rawExt)) {
      skipped++;
      continue;
    }
    const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
    // Re-encode oversized originals — the doc only ever shows a thumbnail.
    const small = await shrinkForEmbed(out.bytes, ext);
    bytesIn += out.bytes.length;
    bytesOut += small ? small.bytes.length : out.bytes.length;
    if (small) shrunk++;
    images.set(key, {
      key,
      bytes: small ? small.bytes : out.bytes,
      ext: small ? small.ext : ext,
      width: small ? small.width : dims.width ?? 800,
      height: small ? small.height : dims.height ?? 600,
    });
    resolved++;
  }
  const mb = (n: number): string => (n / 1e6).toFixed(1);
  onEvent({
    kind: 'log',
    message:
      `Images: ${resolved} embedded, ${skipped} skipped (SVG/missing)` +
      (shrunk > 0
        ? ` — ${shrunk} downscaled to ≤${MAX_EMBED_PX}px (${mb(bytesIn)} MB → ${mb(bytesOut)} MB)`
        : ''),
  });
  return images;
}
