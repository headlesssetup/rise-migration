import { describe, it, expect } from 'vitest';
import sample from '../../tests/fixtures/get-course.l10n.sample.json';
import type { GetCourseDocument } from '@/shared/types/rise';
import {
  cellKey,
  collectCells,
  defaultOnlyCells,
  defaultOnlyTextCells,
  isStorylineCell,
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
      lessonIds: new Map([
        ['bbbb2222-0000-4000-8000-000000000001', 'lessonA-0000000000000000000000'],
      ]),
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
