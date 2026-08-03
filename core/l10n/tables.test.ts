import { describe, it, expect } from 'vitest';
import sample from '../../tests/fixtures/get-course.l10n.sample.json';
import type { GetCourseDocument } from '@/shared/types/rise';
import {
  cellKey,
  collectCells,
  courseRefMap,
  defaultOnlyCells,
  inlineTranslationChanges,
  isStorylineCell,
  junkCellIds,
  lessonIdByRef,
  orphanLocaleTables,
  planCellWrites,
  storylineCells,
  valueTypeOf,
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

  it('excludes archived and row-less locale tables (orphanLocaleTables reports them)', () => {
    // The target can only have the default + live locales (convert-stack
    // recreates exactly those) — cells for an archived or row-less locale
    // would ship UPDATE_L10N_BATCH for a locale the target doesn't know.
    const stack = {
      l10n: {
        defaultLocale: 'en-us',
        locales: [
          { id: 'L1', locale: 'en-us', deletedAt: null },
          { id: 'L2', locale: 'ru', deletedAt: null },
          { id: 'L3', locale: 'ar', deletedAt: '2026-08-01T00:00:00Z' },
        ],
        translations: {
          'en-us': { a: 'x' },
          ru: { a: 'х' },
          ar: { a: 'أ', b: 'ب' },
          lv: { a: 'ā' },
        },
      },
    } as never;
    const locales = new Set(collectCells(stack).map((c) => c.locale));
    expect(locales).toEqual(new Set(['en-us', 'ru']));
    expect(orphanLocaleTables(stack)).toEqual([
      { locale: 'ar', reason: 'archived', cells: 2 },
      { locale: 'lv', reason: 'no-locale-row', cells: 1 },
    ]);
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
    expect(unmatched.map((u) => u.path).sort()).toEqual([
      'course.coverImage.media',
      'course.description',
      'course.media',
    ]);
  });

  it('recurses into arrays on both sides (positional pairing)', () => {
    const source = {
      course: {
        banners: [{ media: { l10nId: 's-0' } }, { media: { l10nId: 's-1' } }],
      },
    } as unknown as GetCourseDocument;
    const target = {
      course: {
        banners: [{ media: { l10nId: 't-0' } }],
      },
    } as unknown as GetCourseDocument;
    const { map, unmatched } = courseRefMap(source, target);
    expect(map.get('s-0')).toBe('t-0');
    // source overhang (no target counterpart) is reported, never dropped
    expect(unmatched).toEqual([{ path: 'course.banners[1].media', l10nId: 's-1' }]);
  });

  it('reports refs inside arrays when the whole subtree is absent on target', () => {
    const source = {
      course: { gallery: { items: [{ media: { l10nId: 's-g0' } }] } },
    } as unknown as GetCourseDocument;
    const { map, unmatched } = courseRefMap(source, { course: {} });
    expect(map.size).toBe(0);
    expect(unmatched).toEqual([{ path: 'course.gallery.items[0].media', l10nId: 's-g0' }]);
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
    // lesson B's paragraph block: cccc…0005 is ru-only → no default to inline
    const paragraphBlock = doc.lessons![1]!.items!.filter((b) => b.family === 'text');
    expect(inlineTranslationChanges(paragraphBlock, doc)).toEqual([]);
  });

  it('never inlines a STORYLINE cell (its contentPrefix is source-owned)', () => {
    // lesson B also holds a storyline block whose en-us cell DOES exist —
    // it must still be skipped (docs/rise-multilang.md §4.3b).
    const changes = inlineTranslationChanges(doc.lessons![1]!.items!, doc);
    expect(changes.every((c) => c.valueType !== 'storyline')).toBe(true);
    expect(changes.map((c) => c.l10nId)).not.toContain(
      'cccc3333-0000-4000-8000-000000000009',
    );
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

  it('never deletes a cell the target document still references (dangling-cover guard)', () => {
    // Source has no cover → the target's random built-in cover was l10n-ified
    // by the conversion into a cell that maps to nothing in the source.
    // Deleting it would leave course.coverImage pointing at a dead l10nId.
    const target: GetCourseDocument = {
      course: {
        id: 'T',
        coverImage: { media: { l10nId: 'tgt-own-cover' } },
      },
      lessons: [],
      l10n: {
        translations: {
          'en-us': {
            'tgt-own-cover': { image: { key: 'assets/rise/builtin.jpg' } },
            'junk-1': '!importing: x',
          },
        },
      },
    };
    expect(junkCellIds(doc, target, [])).toEqual(['junk-1']);
  });
});

describe('storyline cells (docs/rise-multilang.md §4.3b)', () => {
  it('isStorylineCell / valueTypeOf classify a storyline package object', () => {
    const cell = doc.l10n!.translations!['en-us']!['cccc3333-0000-4000-8000-000000000009']!;
    expect(isStorylineCell(cell)).toBe(true);
    expect(valueTypeOf(cell)).toBe('storyline');
    // a plain image cell is NOT storyline
    const img = doc.l10n!.translations!['en-us']!['cccc3333-0000-4000-8000-000000000004']!;
    expect(isStorylineCell(img)).toBe(false);
    expect(valueTypeOf(img)).toBe('mediaRecord');
  });

  it('storylineCells lists every (cell, locale) holding a package', () => {
    const cells = storylineCells(doc);
    expect(cells.map((c) => c.locale)).toEqual(['en-us', 'ru']); // default first
    expect(new Set(cells.map((c) => c.l10nId))).toEqual(
      new Set(['cccc3333-0000-4000-8000-000000000009']),
    );
  });
});

describe('defaultOnlyCells — the "N source changes detected" badge', () => {
  it('counts per target locale, split media vs text (pinned to the fixture)', () => {
    // This function is the operator's benign-vs-broken discriminator for the
    // "N source changes detected" badge — the counts are pinned exactly, not
    // as inequalities (a counting bug must not slip through). Fixture math:
    // ar holds 4 cells (title, desc, lesson titles) → 7 of the 11 default
    // cells are default-only for ar (4 media + 3 text); ru holds all but 3
    // (2 media + 1 text).
    expect(defaultOnlyCells(doc)).toEqual({
      ru: { total: 3, media: 2, text: 1 },
      ar: { total: 7, media: 4, text: 3 },
    });
  });

  it('is empty when every locale mirrors the default', () => {
    const full = {
      l10n: {
        defaultLocale: 'en-us',
        locales: [
          { id: 'L1', locale: 'en-us', deletedAt: null },
          { id: 'L2', locale: 'ru', deletedAt: null },
        ],
        translations: { 'en-us': { a: 'x', b: 'y' }, ru: { a: 'х', b: 'у' } },
      },
    } as never;
    expect(defaultOnlyCells(full)).toEqual({ ru: { total: 0, media: 0, text: 0 } });
  });

  it('excludes archived (deletedAt) and row-less locales from the prediction', () => {
    // Rise's badge counts pending cells per LIVE stack item only: an archived
    // language is not on the target, so counting it would make the predicted
    // number disagree with Rise on every import (a false "real signal").
    const doc = {
      l10n: {
        defaultLocale: 'en-us',
        locales: [
          { id: 'L1', locale: 'en-us', deletedAt: null },
          { id: 'L2', locale: 'ru', deletedAt: null },
          { id: 'L3', locale: 'ar', deletedAt: '2026-08-01T00:00:00Z' },
        ],
        translations: {
          'en-us': { a: 'x', b: { image: { key: 'k' } } },
          ru: { a: 'х' },
          ar: {}, // archived — would otherwise predict 2 pending cells
          lv: {}, // no locale row at all — same
        },
      },
    } as never;
    expect(defaultOnlyCells(doc)).toEqual({ ru: { total: 1, media: 1, text: 0 } });
  });

  it('is empty for a monolingual course', () => {
    expect(defaultOnlyCells({ course: {} } as never)).toEqual({});
  });
});
