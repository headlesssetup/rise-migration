// Built-in ("library") Rise assets: classification, target-plane probe urls and
// the probe itself. Real shapes from the EU archive + captures:
//   cover cell : "assets/rise/assets/getting-started-with-rise-360-sample-course/cover.jpg"
//   theme cover: "https://cdn.eu.articulate.com/assets/rise/assets/themes/organic/cover-image/cover-image-0.jpg"
//   block dflt : "https://cdn.eu.articulate.com/assets/rise/assets/block-defaults/bike.jpg"
import { describe, it, expect } from 'vitest';
import {
  builtinProbeUrl,
  collectBuiltinRefs,
  courseImageKind,
  hasBuiltinRef,
  hasUploadedKey,
  isBuiltinUrl,
  isLibraryKey,
  planeOfBuiltinUrl,
  probeBuiltinRefs,
} from './builtin-assets';

const LIB = 'assets/rise/assets/getting-started-with-rise-360-sample-course/cover.jpg';
const EU_URL = 'https://cdn.eu.articulate.com/assets/rise/assets/block-defaults/bike.jpg';
const US_URL = 'https://cdn.articulate.com/assets/rise/assets/block-defaults/bike.jpg';
const UPLOADED = 'rise/courses/C1/abc123.jpg';

describe('classification', () => {
  it('separates library keys, built-in urls and account uploads', () => {
    expect(isLibraryKey(LIB)).toBe(true);
    expect(isLibraryKey(UPLOADED)).toBe(false);
    expect(isBuiltinUrl(EU_URL)).toBe(true);
    expect(isBuiltinUrl(US_URL)).toBe(true);
    // account media lives on usercontent, never under /assets/
    expect(isBuiltinUrl(`https://articulateusercontent.eu/${UPLOADED}`)).toBe(false);
    expect(hasUploadedKey({ image: { key: UPLOADED } })).toBe(true);
    expect(hasUploadedKey({ image: { key: LIB } })).toBe(false);
  });

  it('reads the plane out of an absolute built-in url', () => {
    expect(planeOfBuiltinUrl(EU_URL)).toBe('eu');
    expect(planeOfBuiltinUrl(US_URL)).toBe('us');
    expect(planeOfBuiltinUrl(LIB)).toBeNull();
  });

  it('courseImageKind: uploaded wins, then builtin, then none', () => {
    expect(courseImageKind({ media: { image: { key: UPLOADED } } })).toBe('uploaded');
    expect(courseImageKind({ media: { image: { key: LIB } } })).toBe('builtin');
    expect(courseImageKind({ media: { image: { src: EU_URL } } })).toBe('builtin');
    // both present → the upload path handles it (and copies the rest)
    expect(courseImageKind({ media: { image: { key: UPLOADED, thumb: EU_URL } } })).toBe('uploaded');
    expect(courseImageKind({})).toBe('none');
    expect(courseImageKind(null)).toBe('none');
  });
});

describe('collectBuiltinRefs', () => {
  it('finds every distinct reference with its kind, plane and path', () => {
    const doc = {
      course: {
        coverImage: { media: { image: { key: LIB } } },
        theme: { coverImage: EU_URL },
      },
      lessons: [{ items: [{ media: { image: { src: EU_URL, thumbnail: US_URL } } }] }],
    };
    const refs = collectBuiltinRefs(doc);
    expect(refs.map((r) => r.value).sort()).toEqual([LIB, US_URL, EU_URL].sort());
    const byValue = new Map(refs.map((r) => [r.value, r]));
    expect(byValue.get(LIB)).toMatchObject({ kind: 'library-key', path: expect.stringContaining('coverImage') });
    expect(byValue.get(EU_URL)).toMatchObject({ kind: 'absolute-url', plane: 'eu' });
    expect(byValue.get(US_URL)).toMatchObject({ kind: 'absolute-url', plane: 'us' });
  });

  it('ignores account uploads and unrelated strings', () => {
    expect(
      collectBuiltinRefs({ a: UPLOADED, b: 'https://youtu.be/x', c: 'plain text' }),
    ).toEqual([]);
  });
});

describe('builtinProbeUrl', () => {
  it('resolves a library key against the TARGET plane', () => {
    expect(builtinProbeUrl(LIB, 'eu')).toBe(`https://cdn.eu.articulate.com/${LIB}`);
    expect(builtinProbeUrl(LIB, 'us')).toBe(`https://cdn.articulate.com/${LIB}`);
  });

  it('swaps the plane of an absolute url, keeping sub-host and path', () => {
    expect(builtinProbeUrl(US_URL, 'eu')).toBe(EU_URL);
    expect(builtinProbeUrl(EU_URL, 'us')).toBe(US_URL);
    expect(builtinProbeUrl('https://images.articulate.com/assets/x.jpg', 'eu')).toBe(
      'https://images.eu.articulate.com/assets/x.jpg',
    );
  });

  it('returns null for anything that is not a built-in reference', () => {
    expect(builtinProbeUrl(UPLOADED, 'eu')).toBeNull();
  });
});

describe('probeBuiltinRefs', () => {
  const OTHER = 'https://cdn.articulate.com/assets/rise/assets/themes/x/cover.png';

  it('2xx = available, 403/404 = absent, anything else = inconclusive', async () => {
    const calls: string[] = [];
    const results = await probeBuiltinRefs([LIB, EU_URL, OTHER], 'eu', async (url) => {
      calls.push(url);
      if (url.includes('cover.jpg')) return { ok: true, status: 200 };
      if (url.includes('bike.jpg')) return { ok: false, status: 404 };
      return { ok: false, status: 500 };
    });
    // every probe goes to the TARGET plane, whatever the source value said
    expect(calls.every((u) => u.includes('.eu.articulate.com'))).toBe(true);
    const byValue = new Map(results.map((r) => [r.value, r]));
    expect(byValue.get(LIB)!.available).toBe(true);
    expect(byValue.get(EU_URL)!.available).toBe(false);
    expect(byValue.get(OTHER)!.available).toBe(null); // 500 → unverified, not absent
  });

  it('two values resolving to the same target url cost ONE request', async () => {
    let n = 0;
    // the US and EU spellings of the same library path → one eu probe
    const results = await probeBuiltinRefs([US_URL, EU_URL], 'eu', async () => {
      n++;
      return { ok: true, status: 200 };
    });
    expect(n).toBe(1);
    expect(results.map((r) => r.value)).toEqual([US_URL, EU_URL]);
    expect(results.every((r) => r.available === true)).toBe(true);
  });

  it('never throws: a rejected fetch is inconclusive', async () => {
    const [r] = await probeBuiltinRefs([LIB], 'us', async () => {
      throw new Error('offline');
    });
    expect(r!.available).toBeNull();
  });

  it('dedupes within a call and across calls via the cache', async () => {
    let n = 0;
    const cache = new Map();
    const head = async () => {
      n++;
      return { ok: true, status: 200 };
    };
    await probeBuiltinRefs([LIB, LIB], 'eu', head, cache);
    expect(n).toBe(1);
    await probeBuiltinRefs([LIB], 'eu', head, cache); // second course, same asset
    expect(n).toBe(1);
  });
});

describe('hasBuiltinRef', () => {
  it('walks nested structures', () => {
    expect(hasBuiltinRef({ a: [{ b: { c: EU_URL } }] })).toBe(true);
    expect(hasBuiltinRef({ a: [{ b: { c: UPLOADED } }] })).toBe(false);
  });
});
