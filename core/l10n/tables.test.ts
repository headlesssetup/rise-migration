import { describe, it, expect } from 'vitest';
import sample from '../../tests/fixtures/get-course.l10n.sample.json';
import type { GetCourseDocument } from '@/shared/types/rise';
import {
  valueTypeOf,
  collectCells,
  lessonIdByRef,
  courseRefMap,
  inlineTranslationChanges,
  planCellWrites,
  junkCellIds,
  cellKey,
} from './tables';
import { remapMediaKeys } from '@/core/import/remap';

const doc = sample as unknown as GetCourseDocument;

describe('valueTypeOf', () => {
  it('classifies plain / rich / mediaRecord (capture-observed)', () => {
    expect(valueTypeOf('Lesson One')).toBe('plain');
    expect(valueTypeOf('<p>x</p>')).toBe('rich');
    expect(valueTypeOf('<strong>Heading</strong>')).toBe('rich');
    expect(valueTypeOf({ image: { key: 'k' } })).toBe('mediaRecord');
  });
});

describe('collectCells', () => {
  it('emits the default locale first, then the others (write-order invariant)', () => {
    const cells = collectCells(doc);
    const locales = cells.map((c) => c.locale);
    const firstNonDefault = locales.findIndex((l) => l !== 'en-us');
    expect(locales.slice(0, firstNonDefault).every((l) => l === 'en-us')).toBe(true);
    expect(locales.slice(firstNonDefault).every((l) => l !== 'en-us')).toBe(true);
    // every table cell is present exactly once
    const total = Object.values(doc.l10n!.translations!).reduce(
      (n, t) => n + Object.keys(t).length,
      0,
    );
    expect(cells).toHaveLength(total);
  });

  it('copies values verbatim (media objects intact)', () => {
    const cells = collectCells(doc);
    const ruHero = cells.find(
      (c) => c.locale === 'ru' && c.l10nId === 'cccc3333-0000-4000-8000-000000000004',
    );
    expect((ruHero!.value as { image: { translationOverride: boolean } }).image
      .translationOverride).toBe(true);
  });
});

describe('lessonIdByRef', () => {
  it('maps lesson-scoped refs (titles + block fields) to their lesson', () => {
    const map = lessonIdByRef(doc);
    expect(map.get('bbbb2222-0000-4000-8000-000000000001')).toBe(
      'lessonA-0000000000000000000000',
    );
    expect(map.get('cccc3333-0000-4000-8000-000000000005')).toBe(
      'lessonB-0000000000000000000000',
    );
    // course-level refs are not lesson-scoped
    expect(map.has('aaaa1111-0000-4000-8000-000000000001')).toBe(false);
  });
});

describe('courseRefMap', () => {
  it('maps course-level refs by structural position and reports unmatched', () => {
    const target: GetCourseDocument = {
      course: {
        id: 'newCourse',
        title: { l10nId: 'tttt-title' },
        description: { l10nId: 'tttt-desc' },
        media: { l10nId: 'tttt-logo' },
        coverImage: { media: { l10nId: 'tttt-cover' } },
      },
    };
    const { map, unmatched } = courseRefMap(doc, target);
    expect(map.get('aaaa1111-0000-4000-8000-000000000001')).toBe('tttt-title');
    expect(map.get('aaaa1111-0000-4000-8000-000000000004')).toBe('tttt-cover');
    expect(map.size).toBe(4);
    expect(unmatched).toEqual([]);
  });

  it('flags source refs with no target counterpart', () => {
    const { unmatched } = courseRefMap(doc, { course: { title: { l10nId: 't' } } });
    expect(unmatched.map((u) => u.path)).toEqual(
      expect.arrayContaining(['course.description', 'course.media.l10nId'].slice(0, 1)),
    );
    expect(unmatched).toHaveLength(3);
  });
});

describe('inlineTranslationChanges', () => {
  it('builds default-locale add-changes for the refs in a blocks subtree', () => {
    const blocks = doc.lessons![0]!.items!;
    const changes = inlineTranslationChanges(blocks, doc, 'lessonA-0000000000000000000000');
    const ids = changes.map((c) => c.l10nId);
    expect(ids).toEqual([
      'cccc3333-0000-4000-8000-000000000001',
      'cccc3333-0000-4000-8000-000000000002',
      'cccc3333-0000-4000-8000-000000000003',
      'cccc3333-0000-4000-8000-000000000004',
    ]);
    expect(changes[0]).toMatchObject({
      action: 'add',
      locale: 'en-us',
      lessonId: 'lessonA-0000000000000000000000',
      valueType: 'rich',
    });
    expect(changes[3]!.valueType).toBe('mediaRecord');
  });

  it('skips refs whose cell exists only in a non-default locale', () => {
    const blocks = doc.lessons![1]!.items!;
    // cccc…0005 is ru-only → no default value to inline
    expect(inlineTranslationChanges(blocks, doc)).toEqual([]);
  });
});

describe('planCellWrites', () => {
  it('batches per locale, default first, applying idMap/remap/skip', () => {
    const cells = collectCells(doc);
    const keyMap = new Map([
      [
        'rise/courses/stackCourse000000000000000000000/heroRU0000000000.jpg',
        'rise/courses/NEWCOURSE/newHeroRu.jpg',
      ],
    ]);
    const batches = planCellWrites(cells, {
      idMap: new Map([['aaaa1111-0000-4000-8000-000000000001', 'tttt-title']]),
      remapValue: (v) => remapMediaKeys(v as never, keyMap) as typeof v,
      lessonIds: lessonIdByRef(doc),
      skip: new Set([cellKey('cccc3333-0000-4000-8000-000000000001', 'en-us')]),
      batchSize: 3,
    });
    // no envelope mixes locales; no envelope exceeds the batch size
    for (const b of batches) {
      expect(new Set(b.map((c) => c.locale)).size).toBe(1);
      expect(b.length).toBeLessThanOrEqual(3);
    }
    const flat = batches.flat();
    // skip honored
    expect(
      flat.some(
        (c) => c.l10nId === 'cccc3333-0000-4000-8000-000000000001' && c.locale === 'en-us',
      ),
    ).toBe(false);
    // idMap applied (course title cell rides the TARGET id, all locales)
    expect(flat.filter((c) => c.l10nId === 'tttt-title')).toHaveLength(3);
    expect(flat.some((c) => c.l10nId === 'aaaa1111-0000-4000-8000-000000000001')).toBe(false);
    // media remap applied inside object values
    const ruHero = flat.find(
      (c) => c.l10nId === 'cccc3333-0000-4000-8000-000000000004' && c.locale === 'ru',
    );
    expect(JSON.stringify(ruHero!.value)).toContain('rise/courses/NEWCOURSE/newHeroRu.jpg');
    // default-locale batches come first
    const localeSeq = batches.map((b) => b[0]!.locale);
    const firstNonDefault = localeSeq.findIndex((l) => l !== 'en-us');
    expect(localeSeq.slice(0, firstNonDefault).every((l) => l === 'en-us')).toBe(true);
    // lessonId present on lesson-scoped adds
    const lessonCell = flat.find((c) => c.l10nId === 'bbbb2222-0000-4000-8000-000000000001');
    expect(lessonCell!.lessonId).toBe('lessonA-0000000000000000000000');
  });
});

describe('junkCellIds', () => {
  it('returns target-only ids minus the keep set', () => {
    const target: GetCourseDocument = {
      l10n: {
        translations: {
          'en-us': {
            'tttt-title': 'placeholder',
            'junk-1': '!importing: x',
            'cccc3333-0000-4000-8000-000000000001': 'kept (source id)',
          },
          ru: { 'junk-1': 'x', 'junk-2': 'y' },
        },
      },
    };
    expect(junkCellIds(doc, target, ['tttt-title']).sort()).toEqual(['junk-1', 'junk-2']);
  });
});
