import { describe, expect, it } from 'vitest';
import {
  downloadAssetsFor,
  findUndownloadedKeys,
  keyPathCandidates,
  runPool,
  sha256Hex,
  type AssetSink,
  type Downloader,
} from './index';

/** In-memory content-addressed sink. */
function memSink(): AssetSink & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async hasAsset(name) {
      return files.has(name);
    },
    async writeAsset(name, bytes) {
      files.set(name, bytes);
    },
  };
}

const enc = (s: string) => new TextEncoder().encode(s);

/** Downloader serving fixed bytes per key. */
function fakeDownloader(map: Record<string, Uint8Array>): Downloader {
  return async (key) => {
    const bytes = map[key];
    if (!bytes) return { ok: false, status: 404 };
    return { ok: true, status: 200, bytes };
  };
}

describe('keyPathCandidates', () => {
  it('offers verbatim first, then a single-encoded normalization', () => {
    const c = keyPathCandidates('rise/courses/c1/Group%25202%2520(7).png');
    expect(c[0]).toBe('rise/courses/c1/Group%25202%2520(7).png'); // verbatim
    expect(c).toContain('rise/courses/c1/Group%202%20(7).png'); // %2520 → %20
  });

  it('offers an NFC-normalized variant for NFD unicode', () => {
    const c = keyPathCandidates('rise/courses/c1/Ka%CC%88tting.mp4'); // a + combining ¨
    expect(c).toContain('rise/courses/c1/K%C3%A4tting.mp4'); // precomposed ä
  });

  it('returns a single candidate for an already-clean key', () => {
    expect(keyPathCandidates('rise/courses/c1/clean.jpg')).toEqual([
      'rise/courses/c1/clean.jpg',
    ]);
  });
});

describe('runPool', () => {
  it('preserves input order', async () => {
    const out = await runPool([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency cap', async () => {
    let active = 0;
    let max = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await runPool(items, 4, async (n) => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 1));
      active -= 1;
      return n;
    });
    expect(max).toBeLessThanOrEqual(4);
    expect(max).toBeGreaterThan(1); // actually ran in parallel
  });
});

describe('downloadAssetsFor', () => {
  const doc = {
    a: { media: { image: { key: 'rise/courses/c1/one.jpg' } } },
    b: { media: { image: { src: 'rise/courses/c1/two.jpg' } } },
    c: { media: { video: { key: 'rise/courses/c1/clip.mp4' } } },
  };

  it('stores bytes content-addressed and dedups identical content', async () => {
    const shared = enc('IMG-BYTES'); // one.jpg & two.jpg share content
    const video = enc('VIDEO-BYTES');
    const sink = memSink();
    const { manifest, stats } = await downloadAssetsFor(
      'course',
      'c1',
      doc,
      sink,
      fakeDownloader({
        'rise/courses/c1/one.jpg': shared,
        'rise/courses/c1/two.jpg': shared,
        'rise/courses/c1/clip.mp4': video,
      }),
    );

    // 3 keys fetched, but identical .jpg content written once → 2 files on disk.
    expect(stats.fetched).toBe(3);
    expect(stats.written).toBe(2);
    expect(stats.deduped).toBe(1);
    expect(sink.files.size).toBe(2);
    expect(manifest.complete).toBe(true);
    expect(manifest.assets).toHaveLength(3);

    // Content-addressed filename = <sha256>.<ext>, shared hash for the two jpgs.
    const hashShared = await sha256Hex(shared);
    const one = manifest.assets.find((a) => a.key.endsWith('one.jpg'))!;
    const two = manifest.assets.find((a) => a.key.endsWith('two.jpg'))!;
    expect(one.file).toBe(`assets/${hashShared}.jpg`);
    expect(two.file).toBe(one.file); // same content → same file
    expect(one.hash).toBe(hashShared);
    expect(one.size).toBe(shared.byteLength);

    const clip = manifest.assets.find((a) => a.key.endsWith('clip.mp4'))!;
    expect(clip.file).toBe(`assets/${await sha256Hex(video)}.mp4`);
    expect(clip.kind).toBe('media-video');
  });

  it('records failures and the assertion flags the un-downloaded key', async () => {
    const sink = memSink();
    const { manifest } = await downloadAssetsFor(
      'course',
      'c1',
      doc,
      sink,
      fakeDownloader({
        'rise/courses/c1/one.jpg': enc('A'),
        'rise/courses/c1/two.jpg': enc('B'),
        // clip.mp4 omitted → 404
      }),
    );

    expect(manifest.complete).toBe(false);
    expect(manifest.failed.map((f) => f.key)).toEqual(['rise/courses/c1/clip.mp4']);

    const collected = [
      { key: 'rise/courses/c1/one.jpg', kind: 'media-image' as const, paths: [] },
      { key: 'rise/courses/c1/two.jpg', kind: 'media-image' as const, paths: [] },
      { key: 'rise/courses/c1/clip.mp4', kind: 'media-video' as const, paths: [] },
    ];
    expect(findUndownloadedKeys(collected, manifest)).toEqual([
      'rise/courses/c1/clip.mp4',
    ]);
  });

  it('dedups against bytes already in the sink (cross-owner reuse)', async () => {
    const sink = memSink();
    const bytes = enc('SHARED-ACROSS-OWNERS');
    const dl = fakeDownloader({ 'rise/courses/c1/one.jpg': bytes });
    const doc1 = { x: { media: { image: { key: 'rise/courses/c1/one.jpg' } } } };

    const first = await downloadAssetsFor('course', 'c1', doc1, sink, dl);
    expect(first.stats.written).toBe(1);

    // Same content, different owner/key but same bytes → already on disk.
    const dl2 = fakeDownloader({ 'rise/courses/c2/dup.jpg': bytes });
    const doc2 = { x: { media: { image: { key: 'rise/courses/c2/dup.jpg' } } } };
    const second = await downloadAssetsFor('course', 'c2', doc2, sink, dl2);
    expect(second.stats.written).toBe(0);
    expect(second.stats.deduped).toBe(1);
    expect(sink.files.size).toBe(1);
  });

  it('reuses prior manifest entries without re-fetching (resume)', async () => {
    const sink = memSink();
    // Downloader serves only clip.mp4; one.jpg would 404 if it were fetched.
    const dl = fakeDownloader({ 'rise/courses/c1/clip.mp4': enc('VID') });
    const prior = [
      {
        key: 'rise/courses/c1/one.jpg',
        kind: 'media-image' as const,
        hash: 'deadbeef',
        ext: 'jpg',
        file: 'assets/deadbeef.jpg',
        size: 3,
      },
    ];
    const { manifest, stats } = await downloadAssetsFor(
      'course',
      'c1',
      {
        a: { media: { image: { key: 'rise/courses/c1/one.jpg' } } },
        c: { media: { video: { key: 'rise/courses/c1/clip.mp4' } } },
      },
      sink,
      dl,
      { priorAssets: prior },
    );
    expect(stats.reused).toBe(1); // one.jpg carried over, not fetched
    expect(stats.written).toBe(1); // clip.mp4 fetched fresh
    expect(manifest.complete).toBe(true);
    expect(
      manifest.assets.find((a) => a.key.endsWith('one.jpg'))?.hash,
    ).toBe('deadbeef');
  });
});
