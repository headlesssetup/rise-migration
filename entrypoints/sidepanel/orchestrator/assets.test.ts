import { describe, it, expect, vi, afterEach } from 'vitest';
import { cdnBasesForPlane, makeCdnDownloader } from './assets';

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
});
