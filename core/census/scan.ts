// Generic recursive census scan of one GET_COURSE document.
//
// CLAUDE.md: asset/cross-ref discovery is a GENERIC recursive scan of the full
// document, never a per-block-type walk. Phase 0 only *discovers and records*
// shapes (it does not abort — loud-fail is Phase 1+). The output seeds the
// block catalog and the scanner's known media/cross-ref shapes.

import type { GetCourseDocument } from '@/shared/types/rise';
import { blockShape } from './signature';

export type RefKind =
  // Uploaded media (must be re-uploaded + remapped on import), split by type:
  | 'media-image'
  | 'media-video'
  | 'media-audio'
  | 'media-storyline' // Storyline bundle bytes (under media.storyline)
  | 'media-other' // uploaded key we couldn't type
  | 'cdn' // cdn.articulate.com — kept as-is, not re-uploaded
  | 'embed' // YouTube/Vimeo — plain URL, not re-uploaded
  | 'storyline-crossref' // Storyline block → Review 360 item
  | 'draw-from-bank-crossref'; // draw-from-bank block → question-bank id

export interface RefOccurrence {
  kind: RefKind;
  /** JSON path within the document, e.g. `$.lessons[0].items[2].items[0].media`. */
  path: string;
  /** Raw value snippet (truncated). */
  value: string;
  courseId?: string;
}

export interface BlockOccurrence {
  family: string;
  variant: string;
  /** `${family}/${variant}` — the catalog key. */
  key: string;
  path: string;
  courseId?: string;
}

/** Per-variant field tally within one course — input to the field-profile
 *  aggregation used by Tier-2 novelty review. */
export interface VariantFieldScan {
  key: string; // family/variant
  instances: number; // blocks of this variant in the course
  examplePath: string;
  signatures: string[]; // distinct block shape signatures (a variation metric)
  fieldCounts: Record<string, number>; // field-path -> #instances containing it
}

export interface CourseScan {
  courseId?: string;
  /** Best-effort version signal (course.version or first `version` field). */
  versionSignal?: string | number;
  blocks: BlockOccurrence[];
  refs: RefOccurrence[];
  /** Per-variant field tallies (for Tier-2 novelty / catalog profiles). */
  variantFields: VariantFieldScan[];
  lessonTypes: string[];
  questionTypes: string[];
}

interface VariantFieldAcc {
  key: string;
  instances: number;
  examplePath: string;
  signatures: Set<string>;
  fieldCounts: Record<string, number>;
}

const MAX_SNIPPET = 200;

// String classification. Order matters: embed/cdn are distinct (a YouTube URL
// never matches the others); usercontent/rise keys are uploaded media.
const RE_USERCONTENT = /articulateusercontent\.com\//i;
const RE_CDN = /cdn\.articulate\.com\//i;
const RE_EMBED = /(?:youtube\.com|youtu\.be|vimeo\.com)/i;
// Uploaded-media keys live under rise/courses/{id}/… (course assets) and
// rise/questionBanks/{id}/… (question-bank assets) — both are re-uploaded on
// migration. (rise/assets/… are CDN theme assets, kept as-is, so not matched.)
const RE_RISE_KEY = /(?:^|[/"'\s])rise\/(?:courses|questionBanks)\/[^/\s"']+\//i;

const RE_IMG = /\.(?:jpe?g|png|gif|svg|webp|bmp|avif|tiff?)(?:[?#]|$)/i;
const RE_VID = /\.(?:mp4|webm|mov|m4v|ogv|avi|mkv)(?:[?#]|$)/i;
const RE_AUD = /\.(?:mp3|m4a|wav|ogg|oga|aac|flac)(?:[?#]|$)/i;

/** Subtype an uploaded-media key from its JSON path + file extension. */
function mediaSubtype(path: string, value: string): RefKind {
  const p = path.toLowerCase();
  if (p.includes('storyline')) return 'media-storyline';
  if (RE_IMG.test(value) || /\bimages?\b/.test(p)) return 'media-image';
  if (RE_VID.test(value) || /\bvideos?\b/.test(p)) return 'media-video';
  if (RE_AUD.test(value) || /\baudios?\b/.test(p)) return 'media-audio';
  return 'media-other';
}

/**
 * Classify a string value as a known reference shape, or null if it's plain.
 * `path` (the JSON location) lets uploaded media be split into image/video/etc.
 */
export function classifyString(value: string, path = ''): RefKind | null {
  if (RE_CDN.test(value)) return 'cdn';
  if (RE_EMBED.test(value)) return 'embed';
  if (RE_USERCONTENT.test(value) || RE_RISE_KEY.test(value)) {
    return mediaSubtype(path, value);
  }
  return null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export interface ScanRefsOptions {
  /** Max length of each occurrence `value` before truncation. Defaults to 200
   *  (census snippets). Asset extraction passes Infinity to keep full keys. */
  maxSnippet?: number;
}

/**
 * Generic recursive media/cross-ref scan of any document — courses OR question
 * banks. Returns every media-key (image/video/audio/storyline/other), CDN URL,
 * embed, and cross-ref (Storyline media, draw-from-bank). `ownerId` tags each
 * occurrence with its source doc (course id or bank id).
 */
export function scanRefs(
  doc: unknown,
  ownerId?: string,
  opts: ScanRefsOptions = {},
): RefOccurrence[] {
  const max = opts.maxSnippet ?? MAX_SNIPPET;
  const refs: RefOccurrence[] = [];
  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      const kind = classifyString(node, path);
      if (kind) refs.push({ kind, path, value: truncate(node, max), courseId: ownerId });
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.type === 'DRAW_FROM_QUESTION_BANK') {
      refs.push({
        kind: 'draw-from-bank-crossref',
        path,
        value: truncate(JSON.stringify(obj), max),
        courseId: ownerId,
      });
    }
    for (const [k, v] of Object.entries(obj)) {
      const childPath = `${path}.${k}`;
      if (k === 'storyline' && v && typeof v === 'object') {
        refs.push({
          kind: 'storyline-crossref',
          path: childPath,
          value: truncate(JSON.stringify(v), max),
          courseId: ownerId,
        });
      }
      walk(v, childPath);
    }
  };
  walk(doc, '$');
  return refs;
}

/**
 * Scan a single GET_COURSE payload. Accepts either the `payload` object
 * (`{course, lessons}`) or a full ducks envelope (`{payload: …}`) — it walks
 * whatever it's given recursively, so both work.
 */
export function scanCourse(doc: GetCourseDocument): CourseScan {
  const courseId =
    typeof doc?.course?.id === 'string' ? doc.course.id : undefined;

  const blocks: BlockOccurrence[] = [];
  const refs = scanRefs(doc, courseId);
  const variantFieldMap = new Map<string, VariantFieldAcc>();
  const lessonTypes = new Set<string>();
  const questionTypes = new Set<string>();

  let versionSignal: string | number | undefined =
    typeof doc?.course?.version === 'string' ||
    typeof doc?.course?.version === 'number'
      ? doc.course.version
      : undefined;

  // Walk for blocks / shapes / question types / version (refs done by scanRefs).
  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;
    if (typeof node !== 'object') return;

    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }

    const obj = node as Record<string, unknown>;

    // Content block: identified by family + variant (copy-faithful key).
    if (typeof obj.family === 'string' && typeof obj.variant === 'string') {
      blocks.push({
        family: obj.family,
        variant: obj.variant,
        key: `${obj.family}/${obj.variant}`,
        path,
        courseId,
      });

      // Tally fields per variant (Tier-2 field profiles + novelty review).
      const sh = blockShape(obj);
      if (sh) {
        let vf = variantFieldMap.get(sh.key);
        if (!vf) {
          vf = {
            key: sh.key,
            instances: 0,
            examplePath: path,
            signatures: new Set(),
            fieldCounts: {},
          };
          variantFieldMap.set(sh.key, vf);
        }
        vf.instances += 1;
        vf.signatures.add(sh.signature);
        for (const p of sh.paths) {
          vf.fieldCounts[p] = (vf.fieldCounts[p] ?? 0) + 1;
        }
      }
    }

    // Question block: has a string `type` and an `answers` array.
    if (typeof obj.type === 'string' && Array.isArray(obj.answers)) {
      questionTypes.add(obj.type);
    }

    for (const [k, v] of Object.entries(obj)) {
      const childPath = `${path}.${k}`;

      // Version signal fallback (shallowest wins).
      if (
        versionSignal === undefined &&
        k === 'version' &&
        (typeof v === 'string' || typeof v === 'number')
      ) {
        versionSignal = v;
      }

      walk(v, childPath);
    }
  };

  // Capture lesson types directly (their `type` field collides with question
  // `type`, so read it explicitly rather than inferring during the walk).
  if (Array.isArray(doc?.lessons)) {
    for (const l of doc.lessons) {
      if (l && typeof l.type === 'string') lessonTypes.add(l.type);
    }
  }

  walk(doc, '$');

  return {
    courseId,
    versionSignal,
    blocks,
    refs,
    variantFields: [...variantFieldMap.values()].map((v) => ({
      key: v.key,
      instances: v.instances,
      examplePath: v.examplePath,
      signatures: [...v.signatures],
      fieldCounts: v.fieldCounts,
    })),
    lessonTypes: [...lessonTypes].sort(),
    questionTypes: [...questionTypes].sort(),
  };
}
