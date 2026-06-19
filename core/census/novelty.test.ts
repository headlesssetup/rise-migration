import { describe, expect, it } from 'vitest';
import type { ShapeEntry } from './aggregate';
import { buildNovelty, isKnownVariant } from './novelty';

function shape(
  key: string,
  signature: string,
  paths: string[],
  count = 1,
  courseIds = ['c1'],
): ShapeEntry {
  return {
    key,
    signature,
    count,
    courseCount: courseIds.length,
    courseIds,
    examplePaths: ['$.lessons[0].items[0]'],
    paths,
  };
}

describe('isKnownVariant', () => {
  it('recognizes catalog variants and the text/* wildcard family', () => {
    expect(isKnownVariant('image/hero')).toBe(true);
    expect(isKnownVariant('text/anything')).toBe(true);
    expect(isKnownVariant('multimedia/embed')).toBe(false);
    expect(isKnownVariant('brand-new/widget')).toBe(false);
  });
});

describe('buildNovelty', () => {
  it('flags variants absent from the catalog', () => {
    const r = buildNovelty([
      shape('multimedia/embed', 'aaaa', ['embed.url']),
      shape('image/hero', 'bbbb', ['media.image.key']),
    ]);
    expect(r.newVariants).toContain('multimedia/embed');
    expect(r.newVariants).not.toContain('image/hero');
    const embed = r.entries.find((e) => e.key === 'multimedia/embed');
    expect(embed?.status).toBe('new-variant');
  });

  it('detects shape variation and diffs extra paths vs the most-common shape', () => {
    const r = buildNovelty([
      shape('image/hero', 'b1', ['media.image.key'], 5),
      shape('image/hero', 'b2', ['media.image.key', 'media.image.alt'], 1),
    ]);
    expect(r.variantsWithVariation).toContain('image/hero');
    expect(r.entries.find((e) => e.signature === 'b2')?.newPaths).toEqual([
      'media.image.alt',
    ]);
    expect(r.entries.find((e) => e.signature === 'b1')?.newPaths).toEqual([]);
  });

  it('reports totals and orders new variants first', () => {
    const r = buildNovelty([
      shape('image/hero', 'b1', ['media.image.key'], 10),
      shape('odd/thing', 'z1', ['x'], 1),
    ]);
    expect(r.totalShapes).toBe(2);
    expect(r.entries[0]?.key).toBe('odd/thing'); // new-variant sorts ahead
  });
});
