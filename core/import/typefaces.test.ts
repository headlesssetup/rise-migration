import { describe, it, expect } from 'vitest';
import {
  parseTypefaces,
  targetByName,
  usedTypefaceIds,
  resolveTypefaces,
  buildCreateTypefaceFonts,
  applyTypefaceIds,
  isBuiltinFont,
} from './typefaces';

const SOURCE_DOC = {
  payload: {
    typefaces: [
      {
        id: 'src-lato',
        name: 'Lato',
        default: true,
        fonts: [{ id: 'a', key: 'assets/rise/fonts/Lato2-Regular.woff', style: 'regular', original: null }],
      },
      {
        id: 'src-brand',
        name: 'AcmeBrand',
        default: false,
        fonts: [
          { id: 'r', key: 'rise/fonts/aaaa.woff', style: 'regular', original: 'Acme-Regular.woff' },
          { id: 'b', key: 'rise/fonts/bbbb.woff', style: 'bold', original: 'Acme-Bold.woff' },
        ],
      },
      { id: 'src-del', name: 'Gone', deleted: true, fonts: [] },
    ],
  },
};

describe('parseTypefaces', () => {
  it('parses the FETCH_TYPEFACES shape, skipping deleted', () => {
    const m = parseTypefaces(SOURCE_DOC);
    expect([...m.keys()].sort()).toEqual(['src-brand', 'src-lato']);
    expect(m.get('src-lato')!.name).toBe('Lato');
    expect(m.get('src-brand')!.fonts.map((f) => f.style)).toEqual(['regular', 'bold']);
  });
});

describe('isBuiltinFont', () => {
  it('flags default/shared-asset fonts as built-in', () => {
    const m = parseTypefaces(SOURCE_DOC);
    expect(isBuiltinFont(m.get('src-lato')!)).toBe(true);
    expect(isBuiltinFont(m.get('src-brand')!)).toBe(false);
  });
});

describe('usedTypefaceIds', () => {
  it('collects top-level + theme typeface ids (deduped)', () => {
    const ids = usedTypefaceIds({
      headingTypefaceId: 'src-brand',
      bodyTypefaceId: 'src-lato',
      theme: { uiTypefaceId: 'src-lato', bodyTypefaceId: 'src-lato' },
    });
    expect(ids.sort()).toEqual(['src-brand', 'src-lato']);
  });
});

describe('resolveTypefaces', () => {
  const source = parseTypefaces(SOURCE_DOC);

  it('matches by name (built-in) and recreates a missing custom font', () => {
    // Target has Lato (different id), but NOT AcmeBrand.
    const target = parseTypefaces({
      typefaces: [{ id: 'tgt-lato', name: 'Lato', default: true, fonts: [] }],
    });
    const res = resolveTypefaces(
      ['src-lato', 'src-brand'],
      source,
      targetByName(target),
    );
    expect(res.idMap.get('src-lato')).toBe('tgt-lato'); // name match
    expect(res.toRecreate.map((t) => t.id)).toEqual(['src-brand']); // custom → recreate
    expect(res.unresolved).toEqual([]);
  });

  it('reuses an already-uploaded brand font on the target (dedup, no recreate)', () => {
    const target = parseTypefaces({
      typefaces: [
        { id: 'tgt-lato', name: 'Lato', default: true, fonts: [] },
        { id: 'tgt-acme', name: 'AcmeBrand', default: false, fonts: [] },
      ],
    });
    const res = resolveTypefaces(['src-brand'], source, targetByName(target));
    expect(res.idMap.get('src-brand')).toBe('tgt-acme');
    expect(res.toRecreate).toEqual([]);
  });

  it('flags an unknown id (not in the source catalog) as unresolved', () => {
    const res = resolveTypefaces(['mystery'], source, new Map());
    expect(res.unresolved).toEqual(['mystery']);
  });
});

describe('buildCreateTypefaceFonts', () => {
  it('builds typeface-<style> entries from upload results', () => {
    const brand = parseTypefaces(SOURCE_DOC).get('src-brand')!;
    const uploaded = new Map([
      ['rise/fonts/aaaa.woff', { key: 'rise/fonts/NEW1.woff', url: 'https://s3/1', type: 'font/woff', filename: 'NEW1.woff' }],
      ['rise/fonts/bbbb.woff', { key: 'rise/fonts/NEW2.woff', url: 'https://s3/2', type: 'font/woff', filename: 'NEW2.woff' }],
    ]);
    const fonts = buildCreateTypefaceFonts(brand, uploaded) as Record<string, any>;
    expect(Object.keys(fonts).sort()).toEqual(['typeface-bold', 'typeface-regular']);
    expect(fonts['typeface-regular'].key).toBe('rise/fonts/NEW1.woff');
    expect(fonts['typeface-regular'].original).toBe('Acme-Regular.woff');
    expect(fonts['typeface-bold'].style).toBe('bold');
  });
});

describe('applyTypefaceIds', () => {
  it('remaps theme + returns top-level ids', () => {
    const idMap = new Map([['src-brand', 'tgt-acme'], ['src-lato', 'tgt-lato']]);
    const course = { headingTypefaceId: 'src-brand', bodyTypefaceId: 'src-lato' };
    const theme = { uiTypefaceId: 'src-lato', headingTypefaceId: 'src-brand' };
    const out = applyTypefaceIds(course, theme, idMap);
    expect(out.headingTypefaceId).toBe('tgt-acme');
    expect(out.bodyTypefaceId).toBe('tgt-lato');
    expect(out.theme.headingTypefaceId).toBe('tgt-acme');
    expect(out.theme.uiTypefaceId).toBe('tgt-lato');
  });
});
