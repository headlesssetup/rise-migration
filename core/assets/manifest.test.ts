import { describe, expect, it } from 'vitest';
import type { AssetKey } from './keys';
import {
  buildAssetManifest,
  findUndownloadedKeys,
  isOrphanStatus,
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
  it('marks complete only when there are no retryable failures', () => {
    const ok = buildAssetManifest('course', 'c1', collected, [entryA], []);
    expect(ok.complete).toBe(true);
    expect(ok.keyCount).toBe(2);
    expect(ok.orphanCount).toBe(0);

    // No status recorded (network error) → retryable, blocks completeness.
    const bad = buildAssetManifest('course', 'c1', collected, [entryA], [
      { key: 'rise/courses/c1/b.mp4', error: 'HTTP 404' },
    ]);
    expect(bad.complete).toBe(false);
    expect(bad.failed).toHaveLength(1);
  });

  it('orphans (403/404) are counted separately and do not block completeness', () => {
    const m = buildAssetManifest('course', 'c1', collected, [entryA], [
      { key: 'rise/courses/c1/b.mp4', error: 'HTTP 403', status: 403 },
    ]);
    expect(m.orphanCount).toBe(1);
    expect(m.complete).toBe(true); // complete w.r.t. downloadable keys
    expect(m.failed).toHaveLength(1); // …but the orphan stays visible in failed

    const mixed = buildAssetManifest('course', 'c1', collected, [], [
      { key: 'rise/courses/c1/a.jpg', error: 'HTTP 500', status: 500 },
      { key: 'rise/courses/c1/b.mp4', error: 'HTTP 404', status: 404 },
    ]);
    expect(mixed.orphanCount).toBe(1);
    expect(mixed.complete).toBe(false); // the 500 is retryable
  });
});

describe('isOrphanStatus', () => {
  it('treats 403 and 404 as missing-at-source (S3 denies ListBucket)', () => {
    expect(isOrphanStatus(404)).toBe(true);
    expect(isOrphanStatus(403)).toBe(true);
  });
  it('does not treat transient/network statuses as orphaned', () => {
    expect(isOrphanStatus(429)).toBe(false);
    expect(isOrphanStatus(500)).toBe(false);
    expect(isOrphanStatus(0)).toBe(false);
    expect(isOrphanStatus(undefined)).toBe(false);
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
