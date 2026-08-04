// F5: the pending SET parser, pinned against the capture round-2 payload shape
// (capture_banks-and-count.mitm — courseUpdates array + lessonItemUpdates
// lesson→block→entries nesting; mondrian/aiScenario excluded).

import { describe, expect, it } from 'vitest';
import { diffPendingSets, parseTranslationUpdates, pendingKey } from './updates';

const CAPTURE_SHAPED = {
  updateCount: 8,
  localeUpdateCounts: { ru: 8 },
  courseUpdates: [
    {
      locale: 'ru',
      localeId: '0433dd77-43db-4183-95fe-b54ccec48d4b',
      l10nId: 'title-ref',
      updatedAt: '2026-08-04T14:32:39.650Z',
      value: 'Just a co',
      valueType: 'plain',
      translatedAt: '2026-08-04T14:32:16.630Z',
      targetValue: 'Просто небольшой курс',
    },
  ],
  lessonItemUpdates: {
    lessonX: {
      root: [
        {
          locale: 'ru',
          localeId: '0433dd77…',
          l10nId: 'lesson-title-ref',
          updatedAt: 't',
          value: 'Heading',
          valueType: 'plain',
          translatedAt: null,
          targetValue: 'Заголовок',
        },
      ],
      blockY: [
        {
          locale: 'ru',
          localeId: '0433dd77…',
          l10nId: 'cell-ref',
          updatedAt: 't',
          value: '<strong>Heading</strong>',
          valueType: 'rich',
          translatedAt: null,
          targetValue: '<strong>Заголовок</strong>',
        },
      ],
    },
  },
  mondrianUpdates: { count: 2, locales: ['ru'] }, // separate subsystem — ignored
  aiScenarioUpdates: { count: 2, locales: ['ru'] }, // separate subsystem — ignored
  inProgress: false,
};

describe('parseTranslationUpdates', () => {
  it('flattens courseUpdates + lessonItemUpdates into the pending set', () => {
    const r = parseTranslationUpdates(CAPTURE_SHAPED);
    expect(r.updateCount).toBe(8);
    expect(r.inProgress).toBe(false);
    expect(r.pending.map(pendingKey).sort()).toEqual([
      'cell-ref ru',
      'lesson-title-ref ru',
      'title-ref ru',
    ]);
    // translatedAt carried through (null = never AI-stamped).
    expect(r.pending.find((p) => p.l10nId === 'title-ref')?.translatedAt).toBe(
      '2026-08-04T14:32:16.630Z',
    );
    expect(r.pending.find((p) => p.l10nId === 'cell-ref')?.translatedAt).toBeNull();
  });

  it('is tolerant of empty/missing sections', () => {
    expect(parseTranslationUpdates({})).toEqual({
      updateCount: null,
      pending: [],
      inProgress: false,
    });
    expect(parseTranslationUpdates(null).pending).toEqual([]);
    expect(
      parseTranslationUpdates({ courseUpdates: 'garbage', lessonItemUpdates: [] }).pending,
    ).toEqual([]);
  });
});

describe('diffPendingSets', () => {
  it('reports both difference sides as sorted keys', () => {
    const actual = [
      { l10nId: 'a', locale: 'ru' },
      { l10nId: 'b', locale: 'ru' },
    ];
    const expected = [
      { l10nId: 'b', locale: 'ru' },
      { l10nId: 'c', locale: 'ar' },
    ];
    expect(diffPendingSets(actual, expected)).toEqual({
      unexpected: ['a ru'],
      missing: ['c ar'],
    });
    expect(diffPendingSets(actual, actual)).toEqual({ unexpected: [], missing: [] });
  });
});
