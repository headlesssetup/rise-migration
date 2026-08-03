import { describe, it, expect } from 'vitest';
import sample from '../../tests/fixtures/get-course.l10n.sample.json';
import type { Block, GetCourseDocument, Lesson } from '@/shared/types/rise';
import { isL10nRef, materializeLocale, resolveStackTitle } from './materialize';
import { scanCourse } from '@/core/census/scan';

const doc = sample as unknown as GetCourseDocument;

const blockItems = (m: GetCourseDocument, lesson: number, block: number) =>
  ((m.lessons![lesson]!.items as Block[])[block]!.items as Record<string, unknown>[])[0]!;

describe('isL10nRef', () => {
  it('accepts exactly {l10nId: string}', () => {
    expect(isL10nRef({ l10nId: 'abc' })).toBe(true);
    expect(isL10nRef({ l10nId: 'abc', extra: 1 })).toBe(false);
    expect(isL10nRef('abc')).toBe(false);
    expect(isL10nRef(null)).toBe(false);
    expect(isL10nRef(['l10nId'])).toBe(false);
  });
});

describe('materializeLocale', () => {
  it('resolves the default locale', () => {
    const { doc: m, locale, unresolved } = materializeLocale(doc);
    expect(locale).toBe('en-us');
    expect(unresolved).toEqual([]);
    expect(m.course?.title).toBe('Fixture Stack Course');
    expect(m.lessons?.[0]?.title).toBe('Lesson One');
    expect(blockItems(m, 0, 0).heading).toBe('<strong>Heading EN</strong>');
  });

  it('resolves a target locale with fallback to the default', () => {
    const { doc: m, unresolved } = materializeLocale(doc, 'ar');
    expect(unresolved).toEqual([]);
    expect(m.course?.title).toBe('دورة مكدسة (عينة)');
    // ar has no lesson-two title → falls back to en-us
    expect(m.lessons?.[1]?.title).toBe('Lesson Two');
    // ar has no hero media → falls back to the en-us media object, intact
    const media = blockItems(m, 0, 1).media as { image: { key: string } };
    expect(media.image.key).toBe(
      'rise/courses/stackCourse000000000000000000000/heroEN0000000000.jpg',
    );
  });

  it('falls back to ANY locale for cells missing everywhere else (ru-only cell)', () => {
    const { doc: m, unresolved } = materializeLocale(doc, 'en-us');
    expect(unresolved).toEqual([]);
    // cccc…0005 exists only in ru
    expect(blockItems(m, 1, 0).paragraph).toBe('<p>Только по-русски</p>');
  });

  it('keeps per-locale media overrides when materializing that locale', () => {
    const { doc: m } = materializeLocale(doc, 'ru');
    const media = blockItems(m, 0, 1).media as { image: { key: string } };
    expect(media.image.key).toBe(
      'rise/courses/stackCourse000000000000000000000/heroRU0000000000.jpg',
    );
  });

  it('strips the overlay and stack markers, reports unresolved refs, never mutates', () => {
    const before = JSON.stringify(doc);
    const withGap = JSON.parse(before) as GetCourseDocument;
    ((withGap.lessons![1]!.items as Block[])[0]!.items as Record<string, unknown>[])[0]!.paragraph =
      { l10nId: 'ffff9999-0000-4000-8000-000000000001' };
    const { doc: m, unresolved } = materializeLocale(withGap);
    expect(unresolved).toEqual(['ffff9999-0000-4000-8000-000000000001']);
    expect((m as Record<string, unknown>).l10n).toBeUndefined();
    expect((m.course as Record<string, unknown>).localizationMetadata).toBeUndefined();
    expect((m.course as Record<string, unknown>).defaultLocaleId).toBeUndefined();
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('passes a non-stack doc through as a deep copy', () => {
    const plain: GetCourseDocument = {
      course: { id: 'c1', title: 'Plain' },
      lessons: [{ id: 'l1', title: 'L', items: [] } as Lesson],
    };
    const { doc: m, locale, unresolved } = materializeLocale(plain);
    expect(m).toEqual(plain);
    expect(m).not.toBe(plain);
    expect(locale).toBe('');
    expect(unresolved).toEqual([]);
  });

  it('strips the l10n key of a MONOLINGUAL doc too (languageCodeMetadata)', () => {
    // Real monolingual GET_COURSE payloads carry l10n.languageCodeMetadata —
    // the strip is unconditional (documented contract); everything else
    // round-trips.
    const plain = {
      course: { id: 'c1', title: 'Plain' },
      lessons: [],
      l10n: { languageCodeMetadata: { 'en-us': { name: 'English' } } },
    } as unknown as GetCourseDocument;
    const { doc: m } = materializeLocale(plain);
    expect((m as Record<string, unknown>).l10n).toBeUndefined();
    expect(m.course).toEqual(plain.course);
  });

  it('materialized stacks produce no l10nId field paths in the census scan', () => {
    const { doc: m } = materializeLocale(doc);
    const scan = scanCourse(m as Parameters<typeof scanCourse>[0]);
    const allFields = scan.variantFields.flatMap((v) => Object.keys(v.fieldCounts));
    expect(allFields.some((f) => f.includes('l10nId'))).toBe(false);
  });
});

describe('resolveStackTitle', () => {
  it('resolves a stack title via the default locale', () => {
    expect(resolveStackTitle(doc)).toBe('Fixture Stack Course');
  });

  it('passes plain titles through and falls back to the id', () => {
    expect(resolveStackTitle({ course: { id: 'c1', title: 'Plain' } })).toBe('Plain');
    expect(resolveStackTitle({ course: { id: 'c1', title: { l10nId: 'nope' } } })).toBe('c1');
  });
});
