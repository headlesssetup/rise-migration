import { describe, expect, it } from 'vitest';
import {
  buildTypefaceInventory,
  collectFontKeys,
  extractTypefaces,
} from './typefaces';

const doc = {
  type: 'rise/typefaces/FETCH_TYPEFACES',
  payload: {
    typefaces: [
      {
        id: 'tf1',
        name: 'IBM Plex Sans1',
        author: 'auth0|abc',
        createdAt: '2026-06-03T18:49:27.530Z',
        default: false,
        deleted: false,
        fonts: [
          { id: 'f1', key: 'rise/fonts/auth0|abc/x-Light.woff', style: 'regular', original: 'L.woff' },
          { id: 'f2', key: 'rise/fonts/auth0|abc/x-Bold.woff', style: 'bold', original: 'B.woff' },
        ],
      },
      { id: 'tf2', name: 'Acme', default: true, fonts: [{ id: 'f3', key: 'rise/fonts/auth0|abc/x-Light.woff', style: 'regular' }] },
    ],
  },
};

describe('typefaces', () => {
  it('extracts typefaces from payload.typefaces', () => {
    expect(extractTypefaces(doc)).toHaveLength(2);
  });

  it('builds rows with fontCount + styles, sorted by name', () => {
    const rows = buildTypefaceInventory(extractTypefaces(doc));
    expect(rows.map((r) => r.name)).toEqual(['Acme', 'IBM Plex Sans1']);
    const ibm = rows.find((r) => r.id === 'tf1')!;
    expect(ibm.fontCount).toBe(2);
    expect(ibm.styles).toBe('bold regular');
    expect(rows.find((r) => r.id === 'tf2')!.isDefault).toBe(true);
  });

  it('collects deduped font keys across typefaces', () => {
    expect(collectFontKeys(doc).sort()).toEqual([
      'rise/fonts/auth0|abc/x-Bold.woff',
      'rise/fonts/auth0|abc/x-Light.woff',
    ]);
  });
});
