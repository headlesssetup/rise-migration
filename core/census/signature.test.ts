import { describe, expect, it } from 'vitest';
import { blockShape, hashPaths, keyPaths } from './signature';

describe('keyPaths', () => {
  it('collapses array indices to [] and dedups, ignoring values', () => {
    const paths = keyPaths({
      items: [
        { id: 'a', t: 1 },
        { id: 'b', t: 2 },
      ],
    });
    expect(paths).toContain('items[].id');
    expect(paths).toContain('items[].t');
    expect(paths.filter((p) => p === 'items[].id')).toHaveLength(1);
  });

  it('collapses id-shaped object keys (uuid/cuid/long-hex) to *', () => {
    const paths = keyPaths({
      'cjld2cjxh0000qzrmn831i7rn': { a: 1 }, // cuid
      '550e8400-e29b-41d4-a716-446655440000': { b: 2 }, // uuid
      normalField: 3,
    });
    expect(paths).toContain('*');
    expect(paths).toContain('*.a');
    expect(paths).toContain('*.b');
    expect(paths).toContain('normalField');
  });
});

describe('hashPaths', () => {
  it('is stable and distinguishes different path sets', () => {
    expect(hashPaths(['a', 'b'])).toBe(hashPaths(['a', 'b']));
    expect(hashPaths(['a', 'b'])).not.toBe(hashPaths(['a', 'c']));
    expect(hashPaths(['a'])).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('blockShape', () => {
  it('returns key + signature for a family/variant block', () => {
    const s = blockShape({
      family: 'text',
      variant: 'paragraph',
      items: [{ id: 'cjld2cjxh0000qzrmn831i7rn', paragraph: '<p>hi</p>' }],
    });
    expect(s?.key).toBe('text/paragraph');
    expect(s?.signature).toMatch(/^[0-9a-f]{8}$/);
    expect(s?.paths).toContain('family');
    expect(s?.paths).toContain('variant');
  });

  it('returns null when the node is not a family/variant block', () => {
    expect(blockShape({ foo: 1 })).toBeNull();
  });
});
