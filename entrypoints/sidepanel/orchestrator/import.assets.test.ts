import { describe, expect, it } from 'vitest';
import { classifyAssetFailures, missingAssetKeys } from './import';

describe('classifyAssetFailures', () => {
  it('treats ONLY 403/404 as deleted-at-source orphans', () => {
    const { orphans, unresolved } = classifyAssetFailures([
      { key: 'a', status: 404 },
      { key: 'b', status: 403 },
    ]);
    expect(orphans.map((o) => o.key)).toEqual(['a', 'b']);
    expect(unresolved).toEqual([]);
  });

  it('keeps transient failures out of the orphan set (they must not drop media)', () => {
    const { orphans, unresolved } = classifyAssetFailures([
      { key: 'srv', status: 500 },
      { key: 'net', status: 0, error: 'TypeError: Failed to fetch' },
      { key: 'unknown', error: 'aborted' },
      { key: 'gone', status: 404 },
    ]);
    expect(orphans.map((o) => o.key)).toEqual(['gone']);
    expect(unresolved.map((u) => u.key)).toEqual(['srv', 'net', 'unknown']);
    expect(unresolved[1]).toMatchObject({ status: 0, error: 'TypeError: Failed to fetch' });
  });

  it('tolerates a manifest with no failures', () => {
    expect(classifyAssetFailures(undefined)).toEqual({
      orphans: [],
      optional: [],
      unresolved: [],
    });
    expect(classifyAssetFailures([])).toEqual({ orphans: [], optional: [], unresolved: [] });
  });

  it('separates terminal optional provenance from missing active media', () => {
    const split = classifyAssetFailures([
      { key: 'active', status: 403 },
      { key: 'source', status: 403, optionalReason: 'input-source' },
    ]);
    expect(split.orphans.map((f) => f.key)).toEqual(['active']);
    expect(split.optional).toEqual([
      { key: 'source', status: 403, optionalReason: 'input-source' },
    ]);
  });
});

describe('missingAssetKeys — forgotten "Download assets" pre-flight', () => {
  const doc = {
    course: { id: 'C1', coverImage: { media: { image: { key: 'rise/courses/C1/cover.jpg' } } } },
    lessons: [
      {
        id: 'L1',
        items: [
          {
            id: 'b1',
            family: 'image',
            variant: 'hero',
            items: [{ id: 'i1', media: { image: { key: 'rise/courses/C1/hero.jpg' } } }],
          },
        ],
      },
    ],
    // stack tables hold media too — they must be covered by the same check
    l10n: {
      defaultLocale: 'en-us',
      translations: {
        ru: { cell1: { image: { key: 'rise/courses/C1/ru-override.jpg' } } },
      },
    },
  };

  it('lists every referenced key the archive has no bytes for (incl. l10n cells)', () => {
    expect(missingAssetKeys(doc, 'C1', []).sort()).toEqual([
      'rise/courses/C1/cover.jpg',
      'rise/courses/C1/hero.jpg',
      'rise/courses/C1/ru-override.jpg',
    ]);
  });

  it('counts a downloaded asset as present, and a recorded ORPHAN as handled', () => {
    const entries = [
      { key: 'rise/courses/C1/cover.jpg', file: 'assets/a.jpg' },
      { key: 'rise/courses/C1/hero.jpg', orphaned: true }, // 403/404 at source
      { key: 'rise/courses/C1/ru-override.jpg', file: 'assets/b.jpg' },
    ];
    expect(missingAssetKeys(doc, 'C1', entries)).toEqual([]);
  });

  it('counts an unavailable optional provenance key as handled', () => {
    const source = 'rise/courses/C1/source.mp3';
    const shaped = {
      media: {
        audio: {
          inputKey: source,
          key: 'rise/courses/C1/transcoded.mp3',
        },
      },
    };
    expect(
      missingAssetKeys(shaped, 'C1', [
        { key: source, optionalUnavailable: true },
        { key: 'rise/courses/C1/transcoded.mp3', file: 'assets/audio.mp3' },
      ]),
    ).toEqual([]);
  });

  it('is empty for a course with no media at all (no false alarm)', () => {
    expect(missingAssetKeys({ course: { id: 'C2' }, lessons: [] }, 'C2', [])).toEqual([]);
  });

  it('flags an entry present in the manifest but with no bytes and no orphan mark', () => {
    const entries = [{ key: 'rise/courses/C1/cover.jpg' }]; // neither file nor orphaned
    expect(missingAssetKeys(doc, 'C1', entries)).toContain('rise/courses/C1/cover.jpg');
  });
});
