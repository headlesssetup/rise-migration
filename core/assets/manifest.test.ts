import { describe, expect, it } from 'vitest';
import type { AssetKey } from './keys';
import {
  buildAssetManifest,
  findUndownloadedKeys,
  type AssetManifestEntry,
} from './manifest';

const collected: AssetKey[] = [
  { key: 'rise/courses/c1/a.jpg', kind: 'media-image', paths: ['$.a'] },
  { key: 'rise/courses/c1/b.mp4', kind: 'media-video', paths: ['$.b'] },
];

const entryA: AssetManifestEntry = {
  key: 'rise/courses/c1/a.jpg',
  kind: 'media-image',
  hash: 'h1',
  ext: 'jpg',
  file: 'assets/h1.jpg',
  size: 10,
};

describe('buildAssetManifest', () => {
  it('marks complete only when there are no failures', () => {
    const ok = buildAssetManifest('course', 'c1', collected, [entryA], []);
    expect(ok.complete).toBe(true);
    expect(ok.keyCount).toBe(2);

    const bad = buildAssetManifest('course', 'c1', collected, [entryA], [
      { key: 'rise/courses/c1/b.mp4', error: 'HTTP 404' },
    ]);
    expect(bad.complete).toBe(false);
    expect(bad.failed).toHaveLength(1);
  });
});

describe('findUndownloadedKeys', () => {
  it('flags every collected key missing from the manifest', () => {
    const m = buildAssetManifest('course', 'c1', collected, [entryA], []);
    expect(findUndownloadedKeys(collected, m)).toEqual(['rise/courses/c1/b.mp4']);
  });

  it('returns empty when all keys downloaded', () => {
    const entryB: AssetManifestEntry = {
      key: 'rise/courses/c1/b.mp4',
      kind: 'media-video',
      hash: 'h2',
      ext: 'mp4',
      file: 'assets/h2.mp4',
      size: 20,
    };
    const m = buildAssetManifest('course', 'c1', collected, [entryA, entryB], []);
    expect(findUndownloadedKeys(collected, m)).toEqual([]);
  });
});
