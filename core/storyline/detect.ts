// Detect Storyline (and Mighty, which surfaces as storyline-variant) blocks in a
// saved GET_COURSE document — the basis for both the export pass (which courses
// need the zip pipeline) and the import attach (block→lesson mapping).
//
// A storyline block is `{type:"interactive", family:"360", variant:"storyline",
// id, items:[{id, media?:{storyline?:{contentPrefix, meta}}}]}` (docs §8). We
// walk lessons explicitly so each found block carries its enclosing lesson id
// (needed for copy_review_item + UPDATE_BLOCK_DEBOUNCE), and stay generic
// otherwise per the "never a per-block-type walk" convention.

import type { StorylineMeta } from './web-export';

export interface StorylineBlockRef {
  /** The block id — `copy_review_item.jobId` and `UPDATE_BLOCK_DEBOUNCE.id`. */
  blockId: string;
  /** The enclosing lesson id — `UPDATE_BLOCK_DEBOUNCE.lessonId`. */
  lessonId: string;
  /** The block's first item id (where `media.storyline` lives), if present. */
  itemId?: string;
  family: string;
  variant: string;
  /** Existing package leaf from `media.storyline.contentPrefix` (source side),
   *  i.e. the trailing path segment. Absent on a never-attached placeholder. */
  leaf?: string;
  /** Existing `media.storyline.meta` (== the package's threeSixty.json). */
  meta?: StorylineMeta;
  /** JSON path of the block (diagnostics). */
  path: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStorylineBlock(o: Record<string, unknown>): boolean {
  return o.family === '360' && o.variant === 'storyline';
}

/** Pull `{leaf, meta, itemId}` from a block's `items[0].media.storyline`. */
function readBlockMedia(block: Record<string, unknown>): {
  itemId?: string;
  leaf?: string;
  meta?: StorylineMeta;
} {
  const items = Array.isArray(block.items) ? block.items : [];
  const first = items.find(isObject);
  if (!first) return {};
  const itemId = typeof first.id === 'string' ? first.id : undefined;
  const media = isObject(first.media) ? first.media : undefined;
  const storyline = media && isObject(media.storyline) ? media.storyline : undefined;
  if (!storyline) return { itemId };
  const contentPrefix = typeof storyline.contentPrefix === 'string' ? storyline.contentPrefix : '';
  const leaf = contentPrefix ? contentPrefix.split('/').filter(Boolean).pop() : undefined;
  const meta = isObject(storyline.meta) ? (storyline.meta as StorylineMeta) : undefined;
  return { itemId, leaf, meta };
}

/**
 * Find every storyline block in a saved course document (`{course, lessons}` or
 * the bare/ducks-wrapped equivalent). Walks each lesson's blocks so the lesson
 * id travels with the block. Generic recursion handles nested structures.
 */
export function findStorylineBlocks(doc: unknown): StorylineBlockRef[] {
  const out: StorylineBlockRef[] = [];

  const walkBlocks = (lessonId: string, node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((c, i) => walkBlocks(lessonId, c, `${path}[${i}]`));
      return;
    }
    if (!isObject(node)) return;
    if (typeof node.family === 'string' && typeof node.variant === 'string' && isStorylineBlock(node)) {
      const blockId = typeof node.id === 'string' ? node.id : '';
      const { itemId, leaf, meta } = readBlockMedia(node);
      out.push({ blockId, lessonId, itemId, family: node.family, variant: node.variant, leaf, meta, path });
    }
    for (const [k, v] of Object.entries(node)) walkBlocks(lessonId, v, `${path}.${k}`);
  };

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((c, i) => walk(c, `${path}[${i}]`));
      return;
    }
    if (!isObject(node)) return;
    const lessons = node.lessons;
    if (Array.isArray(lessons)) {
      lessons.forEach((lesson, i) => {
        if (!isObject(lesson)) return;
        const lessonId = typeof lesson.id === 'string' ? lesson.id : '';
        walkBlocks(lessonId, lesson, `${path}.lessons[${i}]`);
      });
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'lessons') continue; // handled above
      walk(v, `${path}.${k}`);
    }
  };

  walk(doc, '$');
  // De-dupe (a block reachable by two paths is still one block).
  const seen = new Set<string>();
  return out.filter((b) => {
    const key = `${b.lessonId}/${b.blockId}/${b.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** True if the course contains at least one storyline block (→ needs the export
 *  zip pipeline). */
export function hasStorylineBlocks(doc: unknown): boolean {
  return findStorylineBlocks(doc).length > 0;
}
