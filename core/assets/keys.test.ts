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

  it('excludes built-in shared assets served from usercontent (assets/rise/…)', () => {
    // Regression: the default theme header is a usercontent URL but a SHARED
    // built-in (assets/rise/...), not a course upload — must NOT be collected
    // (it was a false "unsupported-media" flag on import).
    expect(
      extractUploadedKeys(
        'https://articulateusercontent.com/assets/rise/assets/themes/example-header-image.jpg',
      ),
    ).toEqual([]);
    expect(
      extractUploadedKeys(
        'https://articulateusercontent.eu/assets/rise/assets/themes/example-header-image.jpg',
      ),
    ).toEqual([]);
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

  it('keeps parentheses in a whole transformed images URL', () => {
    expect(
      extractUploadedKeys(
        'https://images.articulate.com/f:png,w:1920,s:cover/rise/courses/c1/My%20Video%20(1).mp4',
      ),
    ).toEqual(['rise/courses/c1/My%20Video%20(1).mp4']);
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

  // The boundary classes mirror scan.ts's widened RE_RISE_KEY (`(`,`=`,`,`,`>`,`;`
  // delimiters) so keys the census scanner now classifies also extract cleanly.
  it('splits comma-separated keys (srcset-style) instead of fusing them', () => {
    expect(
      extractUploadedKeys('x rise/courses/c1/a.jpg,rise/courses/c1/b.jpg y'),
    ).toEqual(['rise/courses/c1/a.jpg', 'rise/courses/c1/b.jpg']);
    expect(
      extractUploadedKeys(
        'srcset https://articulateusercontent.com/rise/courses/c1/a.jpg,https://articulateusercontent.com/rise/courses/c1/b.jpg end',
      ),
    ).toEqual(['rise/courses/c1/a.jpg', 'rise/courses/c1/b.jpg']);
  });

  it('recognizes = ; and ( as embedded delimiters around a key', () => {
    expect(extractUploadedKeys('blob src=rise/courses/c1/a.png;x=1')).toEqual([
      'rise/courses/c1/a.png',
    ]);
    expect(extractUploadedKeys('style url(rise/courses/c1/bg.jpg) more')).toEqual([
      'rise/courses/c1/bg.jpg',
    ]);
  });

  it('does not shed a bogus key out of a non-rise path like enterprise/courses/…', () => {
    expect(
      extractUploadedKeys('see enterprise/courses/c1/a.png for details'),
    ).toEqual([]);
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

// A real video block (shape from the 2026-06 capture): the video key + its
// derived poster/thumbnail (images.articulate.com transform URLs wrapping a
// separate crushed image key) + caption .vtt keys. ALL must be collected so the
// import re-uploads + remaps them — otherwise the video has no thumbnail/captions.
describe('collectAssetKeys — video poster + captions', () => {
  const videoBlock = {
    family: 'multimedia',
    variant: 'video',
    items: [
      {
        id: 'cm-item',
        media: {
          video: {
            key: 'rise/courses/SRC/txF-video.mp4',
            type: 'video',
            filename: 'txF-video.mp4',
            poster:
              'https://images.eu.articulate.com/f:png,w:1920,s:cover,q:65/rise/courses/SRC/chHQR-poster.jpg',
            thumbnail:
              'https://images.eu.articulate.com/f:jpg,b:fff,w:100,h:100,s:cover/rise/courses/SRC/chHQR-poster.jpg',
            captions: [
              { code: 'pl', name: 'Polish', key: 'rise/courses/SRC/9aR8-cap.vtt' },
              { code: 'pl', name: 'Polish', key: 'rise/courses/SRC/TuJw-cap.vtt' },
            ],
          },
        },
      },
    ],
  };

  it('collects the video, poster (from the transform URL), and caption keys', () => {
    const keys = collectAssetKeys(videoBlock, 'SRC');
    const set = new Set(keys.map((k) => k.key));
    expect(set).toContain('rise/courses/SRC/txF-video.mp4');
    expect(set).toContain('rise/courses/SRC/chHQR-poster.jpg'); // poster + thumbnail (deduped)
    expect(set).toContain('rise/courses/SRC/9aR8-cap.vtt');
    expect(set).toContain('rise/courses/SRC/TuJw-cap.vtt');
  });
});

describe('collectAssetKeys — active vs optional authoring media', () => {
  it('classifies capture-confirmed non-rendering references', () => {
    const doc = {
      audio: {
        inputKey: 'rise/courses/c1/original.mp3',
        key: 'rise/courses/c1/transcoded.mp3',
      },
      image: {
        key: 'rise/courses/c1/original.jpg',
        crushedKey: 'rise/courses/c1/current.jpg',
        useCrushedKey: true,
        originalImage: { key: 'rise/courses/c1/pre-crop.jpg' },
      },
      staging: {
        media: { tmp: { image: { key: 'rise/courses/c1/abandoned.svg' } } },
      },
    };
    const byKey = new Map(collectAssetKeys(doc, 'c1').map((k) => [k.key, k]));
    expect(byKey.get('rise/courses/c1/original.mp3')?.optionalReason).toBe('input-source');
    expect(byKey.get('rise/courses/c1/transcoded.mp3')?.optionalReason).toBeUndefined();
    expect(byKey.get('rise/courses/c1/original.jpg')?.optionalReason).toBe(
      'inactive-image-variant',
    );
    expect(byKey.get('rise/courses/c1/current.jpg')?.optionalReason).toBeUndefined();
    expect(byKey.get('rise/courses/c1/pre-crop.jpg')?.optionalReason).toBe('original-image');
    expect(byKey.get('rise/courses/c1/abandoned.svg')?.optionalReason).toBe(
      'temporary-media',
    );
  });

  it('promotes a key to required when any occurrence is active', () => {
    const key = 'rise/courses/c1/shared.jpg';
    const keys = collectAssetKeys({
      old: { originalImage: { key } },
      live: { media: { image: { key } } },
    });
    expect(keys.find((k) => k.key === key)?.optionalReason).toBeUndefined();
  });
});
