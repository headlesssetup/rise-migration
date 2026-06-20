import { describe, expect, it } from 'vitest';
import sample from '../../tests/fixtures/get-course.sample.json';
import {
  collectAssetKeys,
  extFromContentType,
  extFromKey,
  extractUploadedKeys,
} from './keys';

describe('extractUploadedKeys', () => {
  it('returns a bare rise key unchanged', () => {
    expect(extractUploadedKeys('rise/courses/c1/file.jpg')).toEqual([
      'rise/courses/c1/file.jpg',
    ]);
  });

  it('host-strips a usercontent URL to its key', () => {
    expect(
      extractUploadedKeys('https://articulateusercontent.com/rise/courses/c1/x.png'),
    ).toEqual(['rise/courses/c1/x.png']);
  });

  it('strips query/fragment from the canonical key', () => {
    expect(
      extractUploadedKeys(
        'https://articulateusercontent.com/rise/courses/c1/x.png?sig=abc#frag',
      ),
    ).toEqual(['rise/courses/c1/x.png']);
  });

  it('extracts multiple keys embedded in an HTML rich-text string', () => {
    const html =
      '<p>see <img src="https://articulateusercontent.com/rise/courses/c1/a.gif">' +
      ' and <img src="https://articulateusercontent.com/rise/courses/c1/b.gif"></p>';
    expect(extractUploadedKeys(html)).toEqual([
      'rise/courses/c1/a.gif',
      'rise/courses/c1/b.gif',
    ]);
  });

  it('dedups when the same key appears as both URL and bare key in one string', () => {
    const s =
      '{"src":"https://articulateusercontent.com/rise/courses/c1/x.png",' +
      '"key":"rise/courses/c1/x.png"}';
    expect(extractUploadedKeys(s)).toEqual(['rise/courses/c1/x.png']);
  });

  it('also captures question-bank keys', () => {
    expect(extractUploadedKeys('rise/questionBanks/b1/img.jpg')).toEqual([
      'rise/questionBanks/b1/img.jpg',
    ]);
  });

  it('ignores plain strings and non-rise paths', () => {
    expect(extractUploadedKeys('just some text')).toEqual([]);
    expect(extractUploadedKeys('rise/assets/themes/cover.jpg')).toEqual([]);
  });

  it('keeps parentheses in a whole-value key (no truncation at ")")', () => {
    // Regression: the bounded regex used to cut "…(7).png" at the first ")".
    expect(
      extractUploadedKeys('rise/courses/c1/abc-Group%25202%2520(7).png'),
    ).toEqual(['rise/courses/c1/abc-Group%25202%2520(7).png']);
    expect(
      extractUploadedKeys(
        'https://articulateusercontent.com/rise/courses/c1/cover%2520(5).png',
      ),
    ).toEqual(['rise/courses/c1/cover%2520(5).png']);
  });

  it('keeps double-encoding and NFD unicode in a whole-value key', () => {
    expect(extractUploadedKeys('rise/courses/c1/Ka%CC%88tting.mp4')).toEqual([
      'rise/courses/c1/Ka%CC%88tting.mp4',
    ]);
  });

  it('still bounds keys embedded in a larger HTML/text blob', () => {
    const html =
      '<p>a <img src="https://articulateusercontent.com/rise/courses/c1/a.gif"> b</p>';
    expect(extractUploadedKeys(html)).toEqual(['rise/courses/c1/a.gif']);
  });
});

describe('extFromKey / extFromContentType', () => {
  it('derives the lower-cased extension from the key', () => {
    expect(extFromKey('rise/courses/c1/photo.JPG')).toBe('jpg');
    expect(extFromKey('rise/courses/c1/clip.mp4')).toBe('mp4');
  });

  it('returns empty when there is no plausible extension', () => {
    expect(extFromKey('rise/courses/c1/noext')).toBe('');
    expect(extFromKey('rise/courses/c1/weird.superlongext')).toBe('');
  });

  it('maps content types to extensions', () => {
    expect(extFromContentType('image/png')).toBe('png');
    expect(extFromContentType('audio/mpeg; charset=binary')).toBe('mp3');
    expect(extFromContentType('application/x-unknown')).toBe('');
    expect(extFromContentType(undefined)).toBe('');
  });
});

describe('collectAssetKeys (fixture)', () => {
  const keys = collectAssetKeys(sample, 'course-abc123');

  it('collects only the uploaded image keys, deduped by key', () => {
    expect(new Set(keys.map((k) => k.key))).toEqual(
      new Set([
        'rise/courses/course-abc123/abc-original.jpg', // media.image.key (bare)
        'rise/courses/course-abc123/abc.jpg', // media.image.src (usercontent URL)
      ]),
    );
    expect(keys.every((k) => k.kind === 'media-image')).toBe(true);
  });

  it('excludes storyline, cdn, embeds, and cross-refs', () => {
    const all = keys.map((k) => k.key).join('\n');
    expect(all).not.toContain('pkg-key'); // storyline bundle
    expect(all).not.toContain('cdn.articulate.com'); // theme cover
    expect(all).not.toContain('youtube'); // embed
    expect(all).not.toContain('bank-999'); // draw-from-bank cross-ref
  });

  it('records the JSON path(s) where each key was found', () => {
    for (const k of keys) expect(k.paths.length).toBeGreaterThan(0);
  });
});
