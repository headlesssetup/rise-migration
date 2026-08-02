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
  /**
   * Multi-language stacks only (docs/rise-multilang.md §4.3b): the block's
   * `media` is an `{l10nId}` ref and each LOCALE may hold its own package, so
   * one block yields one entry per locale that has one. `locale`/`l10nId` are
   * set on those entries (absent on a plain monolingual block).
   */
  locale?: string;
  /** The l10n cell holding this package (the import writes the cell by this id). */
  l10nId?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStorylineBlock(o: Record<string, unknown>): boolean {
  return o.family === '360' && o.variant === 'storyline';
}

/** `{leaf, meta}` of one storyline package object (`{contentPrefix, meta…}`). */
function readPackage(storyline: Record<string, unknown>): {
  leaf?: string;
  meta?: StorylineMeta;
} {
  const contentPrefix = typeof storyline.contentPrefix === 'string' ? storyline.contentPrefix : '';
  const leaf = contentPrefix ? contentPrefix.split('/').filter(Boolean).pop() : undefined;
  const meta = isObject(storyline.meta) ? (storyline.meta as StorylineMeta) : undefined;
  return { leaf, meta };
}

/** Per-locale translation tables of a stack doc (empty for a plain course). */
function tablesOf(doc: unknown): Record<string, Record<string, unknown>> {
  if (!isObject(doc)) return {};
  const l10n = isObject(doc.l10n) ? doc.l10n : undefined;
  const t = l10n && isObject(l10n.translations) ? l10n.translations : undefined;
  if (!t) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [locale, table] of Object.entries(t)) {
    if (isObject(table)) out[locale] = table as Record<string, unknown>;
  }
  return out;
}

/**
 * Pull the package reference(s) from a block's `items[0].media`. Monolingual:
 * one entry from `media.storyline`. STACK: `media` is `{l10nId}` and the
 * package objects live in the per-locale tables — one entry per locale that
 * holds one (docs/rise-multilang.md §4.3b).
 */
function readBlockMedia(
  block: Record<string, unknown>,
  tables: Record<string, Record<string, unknown>>,
): {
  itemId?: string;
  packages: { leaf?: string; meta?: StorylineMeta; locale?: string; l10nId?: string }[];
} {
  const items = Array.isArray(block.items) ? block.items : [];
  const first = items.find(isObject);
  if (!first) return { packages: [] };
  const itemId = typeof first.id === 'string' ? first.id : undefined;
  const media = isObject(first.media) ? first.media : undefined;
  if (!media) return { itemId, packages: [] };

  // Stack: media is an l10n ref → resolve each locale's cell.
  const l10nId = typeof media.l10nId === 'string' ? media.l10nId : undefined;
  if (l10nId) {
    const packages: { leaf?: string; meta?: StorylineMeta; locale?: string; l10nId: string }[] = [];
    for (const [locale, table] of Object.entries(tables)) {
      const cell = table[l10nId];
      if (!isObject(cell)) continue;
      const storyline = isObject(cell.storyline) ? cell.storyline : undefined;
      if (!storyline) continue;
      packages.push({ ...readPackage(storyline), locale, l10nId });
    }
    return { itemId, packages };
  }

  const storyline = isObject(media.storyline) ? media.storyline : undefined;
  if (!storyline) return { itemId, packages: [] };
  return { itemId, packages: [readPackage(storyline)] };
}

/**
 * Find every storyline block in a saved course document (`{course, lessons}` or
 * the bare/ducks-wrapped equivalent). Walks each lesson's blocks so the lesson
 * id travels with the block. Generic recursion handles nested structures.
 */
export function findStorylineBlocks(doc: unknown): StorylineBlockRef[] {
  const out: StorylineBlockRef[] = [];
  const tables = tablesOf(doc);

  const walkBlocks = (lessonId: string, node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((c, i) => walkBlocks(lessonId, c, `${path}[${i}]`));
      return;
    }
    if (!isObject(node)) return;
    if (typeof node.family === 'string' && typeof node.variant === 'string' && isStorylineBlock(node)) {
      const blockId = typeof node.id === 'string' ? node.id : '';
      const base = { blockId, lessonId, family: node.family, variant: node.variant, path };
      const { itemId, packages } = readBlockMedia(node, tables);
      if (packages.length === 0) {
        // Never-attached placeholder (or an unresolvable ref): one entry, no leaf.
        out.push({ ...base, itemId });
      } else {
        // One entry per package: monolingual → exactly one; STACK → one per locale.
        for (const pkg of packages) out.push({ ...base, itemId, ...pkg });
      }
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
  // De-dupe by BLOCK ID *and locale* (a block reachable by two paths is still
  // one block — keying on the path used to defeat this, yielding duplicate
  // manifest entries and duplicate attach steps — but on a stack the SAME block
  // legitimately yields one entry per locale, so the locale is part of the key).
  // A block with no id (malformed) falls back to lesson+path so distinct
  // id-less blocks are not collapsed into one.
  const seen = new Set<string>();
  return out.filter((b) => {
    const key = `${b.blockId || `${b.lessonId}/${b.path}`}|${b.locale ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Distinct package leaves in a course (the unit the export pass repackages —
 *  a leaf shared by several locales/blocks is staged once). */
export function storylineLeaves(refs: StorylineBlockRef[]): string[] {
  const seen = new Set<string>();
  for (const r of refs) if (r.leaf) seen.add(r.leaf);
  return [...seen];
}

/** True if the course contains at least one storyline block (→ needs the export
 *  zip pipeline). */
export function hasStorylineBlocks(doc: unknown): boolean {
  return findStorylineBlocks(doc).length > 0;
}
