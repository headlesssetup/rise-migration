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

/** A distinct block shape seen in a course (deduped by family/variant + signature). */
export interface ShapeOccurrence {
  key: string;
  signature: string;
  paths: string[];
  examplePath: string;
  count: number;
}

export interface CourseScan {
  courseId?: string;
  /** Best-effort version signal (course.version or first `version` field). */
  versionSignal?: string | number;
  blocks: BlockOccurrence[];
  refs: RefOccurrence[];
  /** Distinct block shapes (for Tier-2 novelty review). */
  shapes: ShapeOccurrence[];
  lessonTypes: string[];
  questionTypes: string[];
}

const MAX_SNIPPET = 200;

// String classification. Order matters: embed/cdn are distinct (a YouTube URL
// never matches the others); usercontent/rise keys are uploaded media.
const RE_USERCONTENT = /articulateusercontent\.com\//i;
const RE_CDN = /cdn\.articulate\.com\//i;
const RE_EMBED = /(?:youtube\.com|youtu\.be|vimeo\.com)/i;
const RE_RISE_KEY = /(?:^|[/"'\s])rise\/courses\/[^/\s"']+\//i;

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

function truncate(s: string): string {
  return s.length > MAX_SNIPPET ? `${s.slice(0, MAX_SNIPPET)}…` : s;
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
  const refs: RefOccurrence[] = [];
  const shapeMap = new Map<string, ShapeOccurrence>();
  const lessonTypes = new Set<string>();
  const questionTypes = new Set<string>();

  let versionSignal: string | number | undefined =
    typeof doc?.course?.version === 'string' ||
    typeof doc?.course?.version === 'number'
      ? doc.course.version
      : undefined;

  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;

    if (typeof node === 'string') {
      const kind = classifyString(node, path);
      if (kind) refs.push({ kind, path, value: truncate(node), courseId });
      return;
    }
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

      // Structural shape, deduped within the course (Tier-2 novelty review).
      const sh = blockShape(obj);
      if (sh) {
        const id = `${sh.key}#${sh.signature}`;
        const existing = shapeMap.get(id);
        if (existing) existing.count += 1;
        else
          shapeMap.set(id, {
            key: sh.key,
            signature: sh.signature,
            paths: sh.paths,
            examplePath: path,
            count: 1,
          });
      }
    }

    // Question block: has a string `type` and an `answers` array.
    if (typeof obj.type === 'string' && Array.isArray(obj.answers)) {
      questionTypes.add(obj.type);
    }

    // Cross-ref: draw-from-bank item.
    if (obj.type === 'DRAW_FROM_QUESTION_BANK') {
      refs.push({
        kind: 'draw-from-bank-crossref',
        path,
        value: truncate(JSON.stringify(obj)),
        courseId,
      });
    }

    for (const [k, v] of Object.entries(obj)) {
      const childPath = `${path}.${k}`;

      // Cross-ref: Storyline media block → Review 360 item.
      if (k === 'storyline' && v && typeof v === 'object') {
        refs.push({
          kind: 'storyline-crossref',
          path: childPath,
          value: truncate(JSON.stringify(v)),
          courseId,
        });
      }

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
    shapes: [...shapeMap.values()],
    lessonTypes: [...lessonTypes].sort(),
    questionTypes: [...questionTypes].sort(),
  };
}
