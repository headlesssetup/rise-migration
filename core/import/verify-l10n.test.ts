import { describe, it, expect } from 'vitest';
import { verifyL10nParity, l10nParityToMarkdown } from './verify-l10n';

describe('verifyL10nParity (multi-language stacks)', () => {
  const source = {
    course: {
      id: 'SRC',
      title: { l10nId: 'src-title' },
      description: { l10nId: 'src-desc' },
    },
    lessons: [{ id: 'SL1', title: { l10nId: 'src-l1' }, items: [] }],
    l10n: {
      defaultLocale: 'en-us',
      locales: [
        { id: 'r1', locale: 'en-us' },
        { id: 'r2', locale: 'ru' },
      ],
      translations: {
        'en-us': {
          'src-title': 'Title',
          'src-desc': '<p>Desc</p>',
          'src-l1': 'Lesson 1',
          'cell-1': '<p>Body</p>',
          'cell-media': { image: { key: 'rise/courses/SRC/a.jpg', type: 'image' } },
        },
        ru: { 'src-title': 'Заголовок', 'cell-1': '<p>Тело</p>' },
      },
    },
  } as never;

  const goodTarget = {
    course: {
      id: 'TGT',
      title: { l10nId: 'tgt-title' },
      description: { l10nId: 'tgt-desc' },
    },
    lessons: [{ id: 'TL1', title: { l10nId: 'tgt-l1' }, items: [] }],
    l10n: {
      defaultLocale: 'en-us',
      locales: [
        { id: 't1', locale: 'en-us' },
        { id: 't2', locale: 'ru' },
      ],
      translations: {
        'en-us': {
          'tgt-title': 'Title',
          'tgt-desc': '<p>Desc</p>',
          'tgt-l1': 'Lesson 1',
          'cell-1': '<p>Body</p>',
          'cell-media': { image: { key: 'rise/courses/TGT/new.jpg', type: 'image' } },
        },
        ru: { 'tgt-title': 'Заголовок', 'cell-1': '<p>Тело</p>' },
      },
    },
  } as never;

  it('passes when every cell matches (ids via ref map, media keys tokenized)', () => {
    const r = verifyL10nParity(source, goodTarget);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.cells.compared).toBe(7);
    expect(r.locales.target).toEqual(['en-us', 'ru']);
  });

  it('reports missing locales, missing cells, changed cells and extra cells', () => {
    const bad = JSON.parse(JSON.stringify(goodTarget)) as {
      l10n: { translations: Record<string, Record<string, unknown>> };
    };
    delete bad.l10n.translations.ru; // locale gone
    const en = bad.l10n.translations['en-us']!;
    en['cell-1'] = '<p>Different</p>'; // changed
    delete en['cell-media']; // missing
    en['junk-9'] = 'leftover'; // extra
    const r = verifyL10nParity(source, bad as never);
    expect(r.ok).toBe(false);
    const kinds = r.issues.map((i) => i.kind).sort();
    expect(kinds).toContain('missing-locale');
    expect(kinds).toContain('missing-cell');
    expect(kinds).toContain('cell-changed');
    expect(kinds).toContain('extra-cell');
  });

  it('is empty-safe on monolingual docs', () => {
    const r = verifyL10nParity({ course: {} } as never, { course: {} } as never);
    expect(r.ok).toBe(true);
    expect(r.cells).toEqual({ source: 0, target: 0, compared: 0 });
  });

  it('F3: a target-only ref over a DEEP-EMPTY source slot is EXPECTED, not a divergence', () => {
    // The empty-logo artifact: the source has no course.media at all (or a
    // deep-empty object), yet the conversion mints a ref + a default-locale
    // cell for the slot. Every no-logo stack went `partial` on exactly this.
    const tgt = JSON.parse(JSON.stringify(goodTarget)) as {
      course: Record<string, unknown>;
      l10n: { translations: Record<string, Record<string, unknown>> };
    };
    tgt.course.media = { l10nId: 'tgt-logo' };
    tgt.l10n.translations['en-us']!['tgt-logo'] = { image: null };
    const r = verifyL10nParity(source, tgt as never);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.expected).toEqual([
      {
        kind: 'extra-cell',
        locale: 'en-us',
        l10nId: 'tgt-logo',
        detail: 'target-only ref over an empty source slot (conversion artifact)',
      },
    ]);

    // Same with a deep-empty (not absent) source slot.
    const src2 = JSON.parse(JSON.stringify(source)) as { course: Record<string, unknown> };
    src2.course.media = { image: null };
    expect(verifyL10nParity(src2 as never, tgt as never).ok).toBe(true);

    // A NON-empty source slot still counts the unmapped target cell as an issue.
    const src3 = JSON.parse(JSON.stringify(source)) as { course: Record<string, unknown> };
    src3.course.media = { image: { key: 'rise/courses/SRC/logo.png' } };
    const r3 = verifyL10nParity(src3 as never, tgt as never);
    expect(r3.ok).toBe(false);
    expect(r3.issues.some((i) => i.kind === 'extra-cell' && i.l10nId === 'tgt-logo')).toBe(true);
  });
});


describe('verifyL10nParity — tolerated missing cells (flagged storyline)', () => {
  const source = {
    course: { id: 'S' },
    lessons: [],
    l10n: {
      defaultLocale: 'en-us',
      translations: {
        'en-us': {
          'cell-text': 'Hello',
          'cell-sl': { storyline: { contentPrefix: 'rise/courses/S/leaf', src: 'x' } },
        },
        ru: { 'cell-sl': { storyline: { contentPrefix: 'rise/courses/S/leafRU', src: 'y' } } },
      },
    },
  } as never;
  const target = {
    course: { id: 'T' },
    lessons: [],
    l10n: {
      defaultLocale: 'en-us',
      translations: { 'en-us': { 'cell-text': 'Hello' }, ru: {} },
    },
  } as never;

  it('routes tolerated absences to `expected` and stays ok', () => {
    const tolerated = new Set(['cell-sl en-us', 'cell-sl ru']);
    const r = verifyL10nParity(source, target, { toleratedMissing: tolerated });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.expected).toHaveLength(2);
    expect(r.expected![0]).toMatchObject({ kind: 'missing-cell', l10nId: 'cell-sl' });
  });

  it('still fails on absences that were NOT announced', () => {
    const r = verifyL10nParity(source, target);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => `${i.l10nId} ${i.locale}`).sort()).toEqual([
      'cell-sl en-us',
      'cell-sl ru',
    ]);
  });

  it('G1: a tolerated cell that EXISTS with a blanked package reference is expected too', () => {
    // The 067-run false-partial: under idea 2 the conversion MINTS the flagged
    // storyline cell from the blanked block we shipped, so the cell is PRESENT
    // with contentPrefix:"" — present-but-blanked, not absent. Both partials
    // of the 2026-08-05 run were exactly this one cell-changed each.
    const tgt = JSON.parse(JSON.stringify(target)) as {
      l10n: { translations: Record<string, Record<string, unknown>> };
    };
    tgt.l10n.translations['en-us']!['cell-sl'] = {
      storyline: { contentPrefix: '', src: '' },
    };
    tgt.l10n.translations.ru!['cell-sl'] = {
      storyline: { contentPrefix: '', src: '' },
    };
    const tolerated = new Set(['cell-sl en-us', 'cell-sl ru']);
    const r = verifyL10nParity(source, tgt as never, { toleratedMissing: tolerated });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.expected).toHaveLength(2);
    expect(r.expected![0]).toMatchObject({ kind: 'cell-changed', l10nId: 'cell-sl' });
    // …and an UNANNOUNCED divergence on the same shape still fails.
    const r2 = verifyL10nParity(source, tgt as never);
    expect(r2.ok).toBe(false);
    expect(r2.issues.every((i) => i.kind === 'cell-changed')).toBe(true);
  });
});

describe('verifyL10nParity — surviving placeholder cells (conversion junk)', () => {
  // The conversion AI-translated the provisional title/description into EVERY
  // locale; set-stack-titles overwrites only the locales the SOURCE holds.
  // A target row under a mapped id, in a locale the source has no row for,
  // is visible junk (the source falls back to its default language there).
  const source = {
    course: {
      id: 'S',
      title: { l10nId: 'src-title' },
      description: { l10nId: 'src-desc' },
    },
    lessons: [],
    l10n: {
      defaultLocale: 'en-us',
      translations: {
        // description exists ONLY in the default locale (fallback cell)
        'en-us': { 'src-title': 'Course', 'src-desc': 'Real description' },
        ru: { 'src-title': 'Курс' },
      },
    },
  } as never;
  const target = {
    course: {
      id: 'T',
      title: { l10nId: 'tgt-title' },
      description: { l10nId: 'tgt-desc' },
    },
    lessons: [],
    l10n: {
      defaultLocale: 'en-us',
      translations: {
        'en-us': { 'tgt-title': 'Course', 'tgt-desc': 'Real description' },
        // the ru description row is the AI translation of the '.' placeholder
        ru: { 'tgt-title': 'Курс', 'tgt-desc': '.' },
      },
    },
  } as never;

  it('surfaces target-only locale rows under mapped ids as placeholderJunk', () => {
    const r = verifyL10nParity(source, target);
    expect(r.issues).toEqual([]); // no unexpected structural divergence
    expect(r.placeholderJunk).toHaveLength(1);
    expect(r.placeholderJunk![0]).toMatchObject({
      kind: 'placeholder-cell',
      locale: 'ru',
      l10nId: 'tgt-desc',
    });
    // Not status-flipping (expected residue under idea 2 — no proofread source
    // row exists to overwrite the AI text with) but never hidden: the markdown
    // renders it with the per-cell list.
    expect(r.ok).toBe(true);
    expect(l10nParityToMarkdown(r)).toMatch(/conversion's AI translation/);
  });

  it('is empty when the source holds every locale the target does', () => {
    const fullSource = JSON.parse(JSON.stringify(source)) as {
      l10n: { translations: Record<string, Record<string, unknown>> };
    };
    fullSource.l10n.translations['ru']!['src-desc'] = 'Настоящее описание';
    const fullTarget = JSON.parse(JSON.stringify(target)) as {
      l10n: { translations: Record<string, Record<string, unknown>> };
    };
    fullTarget.l10n.translations['ru']!['tgt-desc'] = 'Настоящее описание';
    const r = verifyL10nParity(fullSource as never, fullTarget as never);
    expect(r.placeholderJunk).toBeUndefined();
    expect(r.ok).toBe(true);
  });
});
