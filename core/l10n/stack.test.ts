import { describe, it, expect } from 'vitest';
import sample from '../../tests/fixtures/get-course.l10n.sample.json';
import type { GetCourseDocument, SearchResultItem } from '@/shared/types/rise';
import {
  isLocalizedStack,
  defaultLocaleOf,
  requireDefaultLocale,
  stackLocales,
  writableLocaleCodes,
  listingLocales,
  formatLocales,
  archiveIsStaleForLocales,
  formalityGroups,
} from './stack';

const doc = sample as unknown as GetCourseDocument;

describe('isLocalizedStack', () => {
  it('detects the fixture stack', () => {
    expect(isLocalizedStack(doc)).toBe(true);
  });

  it('detects each marker independently', () => {
    expect(
      isLocalizedStack({ course: { localizationMetadata: { isLocalized: true } } }),
    ).toBe(true);
    expect(isLocalizedStack({ course: { defaultLocaleId: 'loc-1' } })).toBe(true);
    expect(isLocalizedStack({ l10n: { locales: [{ id: 'x', locale: 'de' }] } })).toBe(true);
  });

  it('passes monolingual shapes (empty metadata, null defaultLocaleId, metadata-only l10n)', () => {
    expect(
      isLocalizedStack({
        course: { id: 'c', title: 'Plain', localizationMetadata: {}, defaultLocaleId: null },
        l10n: { languageCodeMetadata: { de: {} } },
      }),
    ).toBe(false);
    expect(isLocalizedStack({})).toBe(false);
    expect(isLocalizedStack(undefined)).toBe(false);
  });
});

describe('defaultLocaleOf / stackLocales', () => {
  it('reads the default locale', () => {
    expect(defaultLocaleOf(doc)).toBe('en-us');
  });

  it('falls back to resolving defaultLocaleId against locale rows', () => {
    expect(
      defaultLocaleOf({
        course: { defaultLocaleId: 'row-1' },
        l10n: { locales: [{ id: 'row-1', locale: 'fr-fr' }] },
      }),
    ).toBe('fr-fr');
  });

  it('orders locales default-first and drops archived rows', () => {
    const withArchived = JSON.parse(JSON.stringify(sample)) as GetCourseDocument;
    withArchived.l10n!.locales!.push({
      id: 'loc-row-x',
      locale: 'xx',
      deletedAt: '2026-08-01T00:00:00Z',
    });
    const codes = stackLocales(withArchived).map((l) => l.locale);
    expect(codes).toEqual(['en-us', 'ar', 'ru']);
    // the writable set mirrors it (default + live rows, archived excluded)
    expect(writableLocaleCodes(withArchived)).toEqual(new Set(['en-us', 'ar', 'ru']));
  });

  it('requireDefaultLocale throws loudly on a malformed stack', () => {
    expect(requireDefaultLocale(doc)).toBe('en-us');
    // No defaultLocale and an unresolvable defaultLocaleId: guessing would
    // break the write-order invariant, so this must abort the course.
    expect(() =>
      requireDefaultLocale({
        course: { defaultLocaleId: 'row-ghost' },
        l10n: { locales: [{ id: 'row-1', locale: 'fr-fr' }], translations: {} },
      }),
    ).toThrow(/no resolvable default locale/);
  });
});

describe('listingLocales / formatLocales', () => {
  const item: SearchResultItem = {
    id: 'c1',
    defaultLocaleId: 'row-de',
    locales: [
      { id: 'row-ar', locale: 'ar' },
      { id: 'row-de', locale: 'de' },
    ],
  };

  it('orders default first', () => {
    expect(listingLocales(item)).toEqual(['de', 'ar']);
  });

  it('is empty for monolingual rows', () => {
    expect(listingLocales({ id: 'c2', locales: [], defaultLocaleId: null })).toEqual([]);
    expect(listingLocales({ id: 'c3' })).toEqual([]);
  });

  it('formats for the inventory column', () => {
    expect(formatLocales(['de', 'ar'])).toBe('de | ar');
    expect(formatLocales([])).toBe('');
  });
});

describe('archiveIsStaleForLocales', () => {
  const item: SearchResultItem = {
    id: 'c1',
    defaultLocaleId: 'loc-row-en-us',
    locales: [
      { id: 'loc-row-en-us', locale: 'en-us' },
      { id: 'loc-row-ru', locale: 'ru' },
      { id: 'loc-row-ar', locale: 'ar' },
    ],
  };

  it('is fresh when the archive has every listed locale', () => {
    expect(archiveIsStaleForLocales(item, doc)).toBe(false);
  });

  it('is stale when the archive predates a listed locale', () => {
    const old = JSON.parse(JSON.stringify(sample)) as GetCourseDocument;
    old.l10n!.locales = old.l10n!.locales!.filter((l) => l.locale !== 'ar');
    expect(archiveIsStaleForLocales(item, old)).toBe(true);
  });

  it('is stale when the archive predates the conversion entirely', () => {
    expect(archiveIsStaleForLocales(item, { course: { id: 'c1' } })).toBe(true);
  });

  it('never stale for monolingual listing rows', () => {
    expect(archiveIsStaleForLocales({ id: 'c1', locales: [] }, { course: {} })).toBe(false);
  });
});

describe('formalityGroups', () => {
  it('groups non-default locales by formality', () => {
    expect(formalityGroups(doc)).toEqual([
      { formality: 'more', locales: ['ar'] },
      { formality: 'less', locales: ['ru'] },
    ]);
  });

  it('groups null/absent formality together', () => {
    const d: GetCourseDocument = {
      l10n: {
        defaultLocale: 'en-us',
        locales: [
          { id: '1', locale: 'en-us' },
          { id: '2', locale: 'de', formality: null },
          { id: '3', locale: 'fr-fr' },
        ],
      },
    };
    expect(formalityGroups(d)).toEqual([{ formality: null, locales: ['de', 'fr-fr'] }]);
  });
});
