// Tier-2 novelty review (PRD §8): compare each distinct block shape against the
// documented block catalog and surface what's new, so nothing migrates unseen.
//
// Copy-faithful migration means an unknown block still round-trips fine — but it
// must be *surfaced and documented*. This produces a per-shape report classifying
// each distinct `family/variant` + structural signature as:
//   - new-variant   : family/variant absent from the documented catalog
//   - known-variant : documented family/variant
// and flags `variation` when a known/seen variant has >1 distinct shape (a likely
// version difference / new field shape), listing the extra key-paths.

import { toCsv } from '@/core/util/csv';
import type { ShapeEntry } from './aggregate';

// Seed: documented family/variant from docs/rise-block-catalog.md §Confirmed.
const KNOWN_VARIANTS = new Set<string>([
  'list/numbered',
  'image/hero',
  'multimedia/video',
  'flashcard/flashcard',
  'interactive-fullscreen/labeledgraphic',
  'interactive-fullscreen/process',
  'interactive-fullscreen/sorting',
  'continue/continue',
  'divider/numbered divider',
  'html/inline',
  'html/cdn',
  '360/storyline',
  'knowledgeCheck/draw from question bank',
]);
// Families documented as a wildcard (e.g. `text/*`) — any variant is known.
const KNOWN_FAMILIES = new Set<string>(['text']);

export function isKnownVariant(key: string): boolean {
  if (KNOWN_VARIANTS.has(key)) return true;
  const family = key.slice(0, key.indexOf('/'));
  return KNOWN_FAMILIES.has(family);
}

export type NoveltyStatus = 'new-variant' | 'known-variant';

export interface NoveltyEntry {
  key: string; // family/variant
  signature: string;
  status: NoveltyStatus;
  /** This family/variant has more than one distinct shape across the library. */
  variation: boolean;
  count: number;
  courseCount: number;
  examplePaths: string[];
  courseIds: string[];
  /** Key-paths present in this shape but not in the variant's most-common shape. */
  newPaths: string[];
}

export interface NoveltyReport {
  generatedAt: string;
  totalShapes: number;
  newVariants: string[];
  variantsWithVariation: string[];
  entries: NoveltyEntry[];
}

/** Build the novelty report from the census's distinct block shapes. */
export function buildNovelty(shapes: ShapeEntry[], now: Date = new Date()): NoveltyReport {
  const byKey = new Map<string, ShapeEntry[]>();
  for (const s of shapes) {
    (byKey.get(s.key) ?? byKey.set(s.key, []).get(s.key)!).push(s);
  }

  const entries: NoveltyEntry[] = [];
  const newVariants = new Set<string>();
  const variantsWithVariation = new Set<string>();

  for (const [key, group] of byKey) {
    const known = isKnownVariant(key);
    if (!known) newVariants.add(key);
    const variation = group.length > 1;
    if (variation) variantsWithVariation.add(key);

    // Base = the most common shape for this variant; others diff against it.
    const sorted = [...group].sort((a, b) => b.count - a.count);
    const base = sorted[0];
    if (!base) continue;
    const baseSet = new Set(base.paths);

    for (const s of sorted) {
      entries.push({
        key,
        signature: s.signature,
        status: known ? 'known-variant' : 'new-variant',
        variation,
        count: s.count,
        courseCount: s.courseCount,
        examplePaths: s.examplePaths,
        courseIds: s.courseIds.slice(0, 5),
        newPaths: s === base ? [] : s.paths.filter((p) => !baseSet.has(p)),
      });
    }
  }

  // New variants first, then most-frequent.
  entries.sort(
    (a, b) =>
      Number(a.status === 'known-variant') - Number(b.status === 'known-variant') ||
      b.count - a.count ||
      a.key.localeCompare(b.key),
  );

  return {
    generatedAt: now.toISOString(),
    totalShapes: shapes.length,
    newVariants: [...newVariants].sort(),
    variantsWithVariation: [...variantsWithVariation].sort(),
    entries,
  };
}

export function noveltyToJson(r: NoveltyReport): string {
  return JSON.stringify(r, null, 2);
}

export function noveltyToCsv(r: NoveltyReport): string {
  const headers = [
    'key',
    'signature',
    'status',
    'variation',
    'count',
    'courseCount',
    'newPaths',
    'examplePaths',
    'courseIds',
  ];
  const rows = r.entries.map((e) => [
    e.key,
    e.signature,
    e.status,
    e.variation ? 'yes' : 'no',
    e.count,
    e.courseCount,
    e.newPaths.join(' | '),
    e.examplePaths.join(' | '),
    e.courseIds.join(' | '),
  ]);
  return toCsv(headers, rows);
}
