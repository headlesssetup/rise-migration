import { describe, expect, it } from 'vitest';
import {
  buildTypefaceInventory,
  collectFontKeys,
  extractTypefaces,
  mergeForeignTypefaces,
  unknownTypefaceIdsOf,
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

describe('shared-in (foreign-tenant) typefaces', () => {
  const account = {
    type: 'rise/typefaces/FETCH_TYPEFACES',
    payload: { typefaces: [{ id: 'own', name: 'Lato', default: true, fonts: [] }], author: 'a' },
  };

  it('finds the typeface ids a course uses that the account list lacks', () => {
    const course = {
      payload: {
        course: { id: 'C', bodyTypefaceId: '607E', headingTypefaceId: '607E', uiTypefaceId: 'own', theme: { bodyTypefaceId: '607E' } },
        lessons: [],
      },
    };
    expect(unknownTypefaceIdsOf(course, new Set(['own']))).toEqual(['607E']);
    expect(unknownTypefaceIdsOf({ course: { id: 'C' } }, new Set())).toEqual([]);
  });

  it('merges per-course results as foreign, keeping the archive doc shape', () => {
    const perCourse = [
      {
        courseId: 'C1',
        doc: { payload: { typefaces: [
          { id: 'own', name: 'Lato', default: true, fonts: [] },
          { id: '607E', name: 'Arkivverkets Fontsamling', fonts: [{ key: 'rise/fonts/x-regular.woff', style: 'regular' }] },
          { id: 'gone', name: 'Old', deleted: true, fonts: [] },
        ] } },
      },
      { courseId: 'C2', doc: { payload: { typefaces: [{ id: '607E', name: 'Arkivverkets Fontsamling', fonts: [] }] } } },
    ];
    const { merged, added } = mergeForeignTypefaces(account, perCourse);
    expect(added).toEqual([{ id: '607E', name: 'Arkivverkets Fontsamling', sharedVia: 'C1' }]);
    const list = extractTypefaces(merged);
    expect(list.map((t) => t.id)).toEqual(['own', '607E']);
    expect(list[1]).toMatchObject({ foreign: true, sharedVia: 'C1' });
    expect((merged as { payload: { author: string } }).payload.author).toBe('a');
    expect(collectFontKeys(merged)).toEqual(['rise/fonts/x-regular.woff']);
  });
});
