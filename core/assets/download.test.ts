import { describe, expect, it } from 'vitest';
import {
  collectAssetKeys,
  downloadAssetsFor,
  downloadKeyList,
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

describe('downloadKeyList', () => {
  it('stores a flat key list content-addressed, deduping identical bytes', async () => {
    const sink = memSink();
    const woff = enc('FONT-A');
    const res = await downloadKeyList(
      [
        'rise/fonts/u/a-Light.woff',
        'rise/fonts/u/a-Bold.woff', // same bytes → deduped
        'rise/fonts/u/missing.woff', // 404
      ],
      sink,
      fakeDownloader({
        'rise/fonts/u/a-Light.woff': woff,
        'rise/fonts/u/a-Bold.woff': woff,
      }),
    );
    expect(res.written).toBe(1);
    expect(res.deduped).toBe(1);
    expect(res.failed.map((f) => f.key)).toEqual(['rise/fonts/u/missing.woff']);
    const hash = await sha256Hex(woff);
    expect(res.files['rise/fonts/u/a-Light.woff']).toBe(`assets/${hash}.woff`);
    expect(res.files['rise/fonts/u/a-Bold.woff']).toBe(`assets/${hash}.woff`);
    expect(sink.files.size).toBe(1);
  });

  it('emits labeled [i/N] progress and records worker exceptions as failures', async () => {
    const sink = memSink();
    const lines: string[] = [];
    const dl: Downloader = async (key) => {
      if (key.endsWith('boom.woff')) throw new Error('quota');
      return { ok: true, status: 200, bytes: enc('F') };
    };
    const res = await downloadKeyList(
      ['rise/fonts/u/ok.woff', 'rise/fonts/u/boom.woff'],
      sink,
      dl,
      undefined,
      'account/assets/',
      { label: 'fonts', onProgress: (m) => lines.push(m) },
    );
    expect(res.written).toBe(1);
    expect(res.failed).toEqual([
      { key: 'rise/fonts/u/boom.woff', error: 'Error: quota' },
    ]);
    expect(lines[0]).toMatch(/^\[1\/2 fonts\] /);
    expect(lines[1]).toMatch(/^\[2\/2 fonts\] /);
    expect(lines.some((l) => l.includes('FAILED boom.woff'))).toBe(true);
  });
});

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
        // clip.mp4 omitted → 404 → terminal orphan (missing at source)
      }),
    );

    expect(manifest.complete).toBe(true); // complete w.r.t. DOWNLOADABLE keys
    expect(manifest.orphanCount).toBe(1);
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
    sink.files.set('deadbeef.jpg', enc('OLD')); // the prior blob is still stored
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

  it('re-downloads a prior entry whose blob vanished from the store (no blind trust)', async () => {
    const sink = memSink(); // empty: the prior blob was lost/deleted
    const bytes = enc('FRESH');
    const dl = fakeDownloader({ 'rise/courses/c1/one.jpg': bytes });
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
      { a: { media: { image: { key: 'rise/courses/c1/one.jpg' } } } },
      sink,
      dl,
      { priorAssets: prior },
    );
    expect(stats.reused).toBe(0);
    expect(stats.written).toBe(1); // fetched again, bytes really stored
    expect(sink.files.size).toBe(1);
    expect(manifest.complete).toBe(true);
    expect(manifest.assets[0]?.hash).toBe(await sha256Hex(bytes));
  });

  it('records a pool-worker exception as that key\'s failure without aborting the run', async () => {
    const sink = memSink();
    const ok = enc('OK');
    const dl: Downloader = async (key) => {
      if (key.endsWith('boom.jpg')) throw new Error('disk quota exceeded');
      return { ok: true, status: 200, bytes: ok };
    };
    const { manifest, stats } = await downloadAssetsFor(
      'course',
      'c1',
      {
        a: { media: { image: { key: 'rise/courses/c1/boom.jpg' } } },
        b: { media: { image: { key: 'rise/courses/c1/fine.jpg' } } },
      },
      sink,
      dl,
    );
    expect(stats.written).toBe(1); // the healthy key still landed
    expect(stats.failed).toBe(1);
    const failure = manifest.failed[0];
    expect(failure?.key).toBe('rise/courses/c1/boom.jpg');
    expect(failure?.error).toContain('disk quota exceeded');
    expect(manifest.complete).toBe(false); // an exception is retryable, not orphaned
  });

  it('carries prior orphans forward without re-fetching; manifest stays complete', async () => {
    const sink = memSink();
    const fetched: string[] = [];
    const dl: Downloader = async (key) => {
      fetched.push(key);
      return { ok: true, status: 200, bytes: enc('OK') };
    };
    const { manifest, stats } = await downloadAssetsFor(
      'course',
      'c1',
      {
        a: { media: { image: { key: 'rise/courses/c1/gone.jpg' } } },
        b: { media: { image: { key: 'rise/courses/c1/fine.jpg' } } },
      },
      sink,
      dl,
      {
        priorOrphans: [
          { key: 'rise/courses/c1/gone.jpg', error: 'HTTP 403', status: 403 },
        ],
      },
    );
    expect(fetched).toEqual(['rise/courses/c1/fine.jpg']); // orphan never retried
    expect(stats.orphaned).toBe(1);
    expect(stats.failed).toBe(0); // orphans are counted apart from retryable failures
    expect(manifest.orphanCount).toBe(1);
    expect(manifest.failed.map((f) => f.key)).toEqual(['rise/courses/c1/gone.jpg']);
    expect(manifest.complete).toBe(true); // complete w.r.t. downloadable keys
  });

  it('counts a fresh 403/404 as orphaned, still complete w.r.t. downloadable keys', async () => {
    const sink = memSink();
    const { manifest, stats } = await downloadAssetsFor(
      'course',
      'c1',
      { a: { media: { image: { key: 'rise/courses/c1/gone.jpg' } } } },
      sink,
      fakeDownloader({}), // every key 404s
    );
    expect(stats.orphaned).toBe(1);
    expect(stats.failed).toBe(0);
    expect(manifest.complete).toBe(true);
    expect(manifest.orphanCount).toBe(1);
  });

  it('records unavailable input source separately from active rendering media', async () => {
    const sink = memSink();
    const original = 'rise/courses/c1/original.mp3';
    const active = 'rise/courses/c1/transcoded.mp3';
    const { manifest, stats } = await downloadAssetsFor(
      'course',
      'c1',
      { media: { audio: { inputKey: original, key: active } } },
      sink,
      fakeDownloader({ [active]: enc('PLAYBACK') }),
    );
    expect(stats.orphaned).toBe(0);
    expect(stats.optionalUnavailable).toBe(1);
    expect(stats.failed).toBe(0);
    expect(manifest.orphanCount).toBe(0);
    expect(manifest.optionalUnavailableCount).toBe(1);
    expect(manifest.complete).toBe(true);
    expect(manifest.failed).toEqual([
      expect.objectContaining({
        key: original,
        status: 404,
        optionalReason: 'input-source',
      }),
    ]);
    expect(
      findUndownloadedKeys(
        collectAssetKeys({ media: { audio: { inputKey: original, key: active } } }),
        manifest,
      ),
    ).toEqual([]);
  });

  it('emits [i/N assets] progress for every key, in completion order', async () => {
    const sink = memSink();
    const lines: string[] = [];
    await downloadAssetsFor(
      'course',
      'c1',
      {
        a: { media: { image: { key: 'rise/courses/c1/one.jpg' } } },
        c: { media: { video: { key: 'rise/courses/c1/clip.mp4' } } },
      },
      sink,
      fakeDownloader({ 'rise/courses/c1/one.jpg': enc('A') }), // clip 404s
      { onProgress: (m) => lines.push(m) },
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[1\/2 assets\] /);
    expect(lines[1]).toMatch(/^\[2\/2 assets\] /);
    expect(lines.some((l) => l.includes('OK one.jpg'))).toBe(true);
    expect(lines.some((l) => l.includes('ORPHAN clip.mp4'))).toBe(true); // 404 → orphan
  });

  it('counts written/deduped truthfully when two lanes race on identical bytes', async () => {
    const bytes = enc('SAME-BYTES');
    const files = new Map<string, Uint8Array>();
    const tick = () => new Promise((r) => setTimeout(r, 2));
    // A slow sink forces both lanes past hasAsset() before either write lands.
    const slowSink: AssetSink = {
      async hasAsset(name) {
        await tick();
        return files.has(name);
      },
      async writeAsset(name, b) {
        await tick();
        files.set(name, b);
      },
    };
    const { stats } = await downloadAssetsFor(
      'course',
      'c1',
      {
        a: { media: { image: { key: 'rise/courses/c1/a.jpg' } } },
        b: { media: { image: { key: 'rise/courses/c1/b.jpg' } } },
      },
      slowSink,
      fakeDownloader({
        'rise/courses/c1/a.jpg': bytes,
        'rise/courses/c1/b.jpg': bytes,
      }),
      { concurrency: 2 },
    );
    expect(files.size).toBe(1);
    expect(stats.written).toBe(1); // exactly one lane is the writer
    expect(stats.deduped).toBe(1);
  });
});
