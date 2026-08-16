import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AssetManifest, Downloader } from '@/core/assets';
import type { Storage } from '@/core/storage/storage';
import { cdnBasesForPlane, downloadAllAssets, makeCdnDownloader } from './assets';
import type { ProgressEvent } from './shared';

describe('cdnBasesForPlane', () => {
  it('maps a known plane to exactly one host (no waste)', () => {
    expect(cdnBasesForPlane('us')).toEqual(['https://articulateusercontent.com/']);
    expect(cdnBasesForPlane('eu')).toEqual(['https://articulateusercontent.eu/']);
  });

  it('tries US then EU when the plane is unknown', () => {
    expect(cdnBasesForPlane(null)).toEqual([
      'https://articulateusercontent.com/',
      'https://articulateusercontent.eu/',
    ]);
    expect(cdnBasesForPlane(undefined)).toEqual([
      'https://articulateusercontent.com/',
      'https://articulateusercontent.eu/',
    ]);
  });
});

describe('makeCdnDownloader', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(impl: (url: string) => { ok: boolean; status: number }) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const r = impl(url);
      return {
        ok: r.ok,
        status: r.status,
        async arrayBuffer() {
          return new Uint8Array([1, 2, 3]).buffer;
        },
        headers: { get: () => 'image/jpeg' },
      } as unknown as Response;
    }));
  }

  it('downloads from the EU host for an EU-plane archive', async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return { ok: url.includes('articulateusercontent.eu'), status: url.includes('.eu') ? 200 : 404 };
    });
    const dl = makeCdnDownloader(cdnBasesForPlane('eu'));
    const out = await dl('rise/courses/ABC/a.jpg');
    expect(out.ok).toBe(true);
    expect(seen.every((u) => u.startsWith('https://articulateusercontent.eu/'))).toBe(true);
  });

  it('falls through US → EU when the plane is unknown', async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      // only the EU host has the object
      return { ok: url.includes('.eu'), status: url.includes('.eu') ? 200 : 404 };
    });
    const dl = makeCdnDownloader(cdnBasesForPlane(null));
    const out = await dl('rise/courses/ABC/a.jpg');
    expect(out.ok).toBe(true);
    expect(seen[0]).toContain('articulateusercontent.com'); // US tried first
    expect(seen.some((u) => u.includes('articulateusercontent.eu'))).toBe(true);
  });

  it('passes an abort signal so a hung connection cannot stall a lane forever', async () => {
    let sawSignal: unknown;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      sawSignal = init?.signal;
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return new Uint8Array([1]).buffer;
        },
        headers: { get: () => 'image/jpeg' },
      } as unknown as Response;
    }));
    const dl = makeCdnDownloader(['https://articulateusercontent.com/']);
    await dl('rise/courses/ABC/a.jpg');
    expect(sawSignal).toBeInstanceOf(AbortSignal);
  });

  it('times out a hanging fetch and resolves as a retryable failure', async () => {
    // fetch that never settles unless its signal aborts.
    vi.stubGlobal('fetch', vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('TimeoutError: signal timed out')),
          );
        }),
    ));
    const dl = makeCdnDownloader(['https://articulateusercontent.com/'], 10);
    const out = await dl('rise/courses/ABC/a.jpg'); // resolves — no hang
    expect(out.ok).toBe(false);
    expect(String(out.error)).toMatch(/timeout|abort/i);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// downloadAllAssets — resume/skip semantics, orphan reporting, owner isolation.
// ---------------------------------------------------------------------------

interface FakeStore {
  storage: Storage;
  blobs: Map<string, Uint8Array>;
  manifests: Map<string, string>;
  summaryJson: () => string | null;
}

/** In-memory Storage stub covering exactly what downloadAllAssets touches. */
function fakeStorage(
  courses: Record<string, unknown>,
  priorManifests: Record<string, AssetManifest> = {},
  preseededBlobs: string[] = [],
): FakeStore {
  const blobs = new Map<string, Uint8Array>();
  for (const name of preseededBlobs) blobs.set(name, new Uint8Array([0]));
  const manifests = new Map<string, string>(
    Object.entries(priorManifests).map(([id, m]) => [`courses/${id}`, JSON.stringify(m)]),
  );
  let summary: string | null = null;
  const storage = {
    listSaved: async () => Object.keys(courses),
    readCourse: async (id: string) => JSON.stringify(courses[id]),
    listSavedBanks: async () => [],
    readQuestionBank: async () => null,
    readAssetManifest: async (scope: string, id: string) =>
      manifests.get(`${scope}/${id}`) ?? null,
    writeAssetManifest: async (scope: string, id: string, json: string) => {
      manifests.set(`${scope}/${id}`, json);
    },
    writeAssetsSummary: async (json: string) => {
      summary = json;
    },
    hasAsset: async (name: string) => blobs.has(name),
    writeAsset: async (name: string, bytes: Uint8Array) => {
      blobs.set(name, bytes);
    },
  } as unknown as Storage;
  return { storage, blobs, manifests, summaryJson: () => summary };
}

function servingDownloader(record: string[]): Downloader {
  return async (key) => {
    record.push(key);
    return { ok: true, status: 200, bytes: new TextEncoder().encode(key) };
  };
}

function completeManifest(
  id: string,
  keys: string[],
  orphans: string[] = [],
): AssetManifest {
  return {
    ownerType: 'course',
    ownerId: id,
    generatedAt: '2026-01-01T00:00:00.000Z',
    keyCount: keys.length + orphans.length,
    assets: keys.map((key, i) => ({
      key,
      kind: 'media-image' as const,
      hash: `hash${i}`,
      ext: 'jpg',
      file: `assets/hash${i}.jpg`,
      size: 1,
    })),
    failed: orphans.map((key) => ({ key, error: 'HTTP 403', status: 403 })),
    orphanCount: orphans.length,
    complete: true,
  };
}

const docWith = (id: string, keys: string[]) => ({
  course: { id, title: `Course ${id}` },
  lessons: keys.map((key) => ({ media: { image: { key } } })),
});

describe('downloadAllAssets', () => {
  const events: ProgressEvent[] = [];
  const onEvent = (e: ProgressEvent) => events.push(e);
  const logs = () =>
    events.filter((e) => e.kind === 'log').map((e) => (e as { message: string }).message);
  afterEach(() => {
    events.length = 0;
  });

  it('skips an owner whose complete manifest still covers all keys and blobs', async () => {
    const key = 'rise/courses/c1/one.jpg';
    const store = fakeStorage(
      { c1: docWith('c1', [key]) },
      { c1: completeManifest('c1', [key]) },
      ['hash0.jpg'],
    );
    const fetched: string[] = [];
    const summary = await downloadAllAssets(store.storage, onEvent, servingDownloader(fetched));
    expect(summary.skipped).toBe(1);
    expect(fetched).toEqual([]); // nothing re-fetched
    expect(store.manifests.get('courses/c1')).toContain('2026-01-01'); // not rewritten
    expect(logs().some((m) => m.includes('already done'))).toBe(true);
  });

  it('re-runs a "complete" owner when the key scan finds keys the manifest misses (H9)', async () => {
    const oldKey = 'rise/courses/c1/one.jpg';
    const newKey = 'rise/courses/c1/two.jpg';
    const store = fakeStorage(
      { c1: docWith('c1', [oldKey, newKey]) }, // scanner now sees a second key
      { c1: completeManifest('c1', [oldKey]) }, // prior run only knew the first
      ['hash0.jpg'],
    );
    const fetched: string[] = [];
    const summary = await downloadAllAssets(store.storage, onEvent, servingDownloader(fetched));
    expect(summary.skipped).toBe(0);
    expect(fetched).toEqual([newKey]); // old key reused, only the new one fetched
    expect(summary.reused).toBe(1);
    expect(summary.written).toBe(1);
    const rewritten = JSON.parse(store.manifests.get('courses/c1')!) as AssetManifest;
    expect(rewritten.assets.map((a) => a.key).sort()).toEqual([oldKey, newKey]);
    expect(logs().some((m) => m.includes('not covered by the prior manifest'))).toBe(true);
  });

  it('re-runs a "complete" owner whose stored blob has vanished (M7)', async () => {
    const key = 'rise/courses/c1/one.jpg';
    const store = fakeStorage(
      { c1: docWith('c1', [key]) },
      { c1: completeManifest('c1', [key]) },
      [], // blob hash0.jpg is NOT in the store
    );
    const fetched: string[] = [];
    const summary = await downloadAllAssets(store.storage, onEvent, servingDownloader(fetched));
    expect(summary.skipped).toBe(0);
    expect(fetched).toEqual([key]); // re-downloaded for real
    expect(summary.written).toBe(1);
    expect(logs().some((m) => m.includes('blob missing'))).toBe(true);
  });

  it('surfaces terminal orphans on every run without re-fetching them', async () => {
    const goodKey = 'rise/courses/c1/one.jpg';
    const goneKey = 'rise/courses/c1/gone.jpg';
    const store = fakeStorage(
      { c1: docWith('c1', [goodKey, goneKey]) },
      { c1: completeManifest('c1', [goodKey], [goneKey]) },
      ['hash0.jpg'],
    );
    const fetched: string[] = [];
    const summary = await downloadAllAssets(store.storage, onEvent, servingDownloader(fetched));
    expect(summary.skipped).toBe(1); // orphan is covered → still a skip
    expect(fetched).toEqual([]); // and never re-fetched
    expect(summary.complete).toBe(true); // orphans don't break run completeness
    expect(summary.orphaned).toEqual([
      {
        ownerType: 'course',
        ownerId: 'c1',
        title: 'Course c1',
        keys: [{ key: goneKey, location: undefined }],
      },
    ]);
  });

  it('reclassifies a legacy inputKey orphan without re-downloading good media', async () => {
    const source = 'rise/courses/c1/original.mp3';
    const active = 'rise/courses/c1/transcoded.mp3';
    const store = fakeStorage(
      {
        c1: {
          course: { id: 'c1', title: 'Audio course' },
          lessons: [{ media: { audio: { inputKey: source, key: active } } }],
        },
      },
      { c1: completeManifest('c1', [active], [source]) },
      ['hash0.jpg'],
    );
    const fetched: string[] = [];
    const summary = await downloadAllAssets(store.storage, onEvent, servingDownloader(fetched));
    expect(summary.skipped).toBe(1);
    expect(fetched).toEqual([]);
    expect(summary.orphaned).toEqual([]);
    expect(summary.optionalUnavailable).toHaveLength(1);
    expect(summary.optionalUnavailable[0]?.keys[0]).toMatchObject({
      key: source,
      reason: 'input-source',
    });
    const rewritten = JSON.parse(store.manifests.get('courses/c1')!) as AssetManifest;
    expect(rewritten.assetPolicyVersion).toBe(2);
    expect(rewritten.orphanCount).toBe(0);
    expect(rewritten.optionalUnavailableCount).toBe(1);
    expect(rewritten.failed[0]?.optionalReason).toBe('input-source');
  });

  it('isolates one owner\'s crash: records it in failedOwners, continues (M8)', async () => {
    const store = fakeStorage({
      c1: docWith('c1', ['rise/courses/c1/one.jpg']),
      c2: docWith('c2', ['rise/courses/c2/two.jpg']),
    });
    const original = store.storage.writeAssetManifest.bind(store.storage);
    store.storage.writeAssetManifest = async (scope, id, json) => {
      if (id === 'c1') throw new Error('quota exceeded');
      return original(scope, id, json);
    };
    const fetched: string[] = [];
    const summary = await downloadAllAssets(store.storage, onEvent, servingDownloader(fetched));
    expect(summary.failedOwners).toEqual([
      { ownerType: 'course', ownerId: 'c1', title: 'Course c1', error: 'Error: quota exceeded' },
    ]);
    expect(summary.complete).toBe(false);
    expect(store.manifests.has('courses/c2')).toBe(true); // c2 still processed
    expect(logs().some((m) => m.includes('owner FAILED c1'))).toBe(true);
    expect(logs().some((m) => m.includes('1 owner(s) failed entirely'))).toBe(true);
  });

  it('emits per-asset [i/N] progress lines from inside the pool', async () => {
    const store = fakeStorage({
      c1: docWith('c1', ['rise/courses/c1/one.jpg', 'rise/courses/c1/two.jpg']),
    });
    await downloadAllAssets(store.storage, onEvent, servingDownloader([]));
    expect(logs().some((m) => /^\[1\/2 assets\] /.test(m))).toBe(true);
    expect(logs().some((m) => /^\[2\/2 assets\] /.test(m))).toBe(true);
  });
});
