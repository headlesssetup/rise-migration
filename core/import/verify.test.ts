import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  verifyParity,
  verifyL10nParity,
  parityReportToMarkdown,
  l10nParityToMarkdown,
} from './verify';
import type { GetCourseDocument } from '@/shared/types/rise';

describe('canonicalize', () => {
  it('drops volatile fields and tokenizes ids + media keys', () => {
    const out = canonicalize({
      id: 'cmqjv8g0g002i3b7oabdf4pav',
      globalBlockId: 'f2736c59-3152-408f-add8-b8e307a6a014',
      createdAt: 'x',
      family: 'image',
      variant: 'hero',
      media: { image: { key: 'rise/courses/SRC/a.jpg' } },
    }) as Record<string, unknown>;
    expect('id' in out).toBe(false);
    expect('globalBlockId' in out).toBe(false);
    expect('createdAt' in out).toBe(false);
    expect(out.family).toBe('image');
    expect((out.media as any).image.key).toBe('#media');
  });

  it('keeps cdn/embed URLs verbatim', () => {
    expect(canonicalize('https://cdn.articulate.com/x.jpg')).toBe('https://cdn.articulate.com/x.jpg');
    expect(canonicalize('https://youtu.be/abc')).toBe('https://youtu.be/abc');
  });

  it('collapses HTML whitespace so re-serialization noise is ignored', () => {
    expect(canonicalize('<p>hello   world\n</p>')).toBe('<p>hello world </p>');
  });

  it('is order-insensitive for object keys', () => {
    const a = canonicalize({ b: 1, a: 2 });
    const b = canonicalize({ a: 2, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// A source course and a faithful target read-back differing only by ids/keys.
function src(): GetCourseDocument {
  return {
    course: { id: 'SRC', title: 'C' },
    lessons: [
      {
        id: 'L1src',
        position: 0,
        type: 'blocks',
        title: 'Lesson 1',
        items: [
          { id: 'b1src', family: 'text', variant: 'paragraph', items: [{ id: 'i1', paragraph: '<p>Hello</p>' }] },
          { id: 'b2src', family: 'image', variant: 'hero', items: [{ id: 'i2', media: { image: { key: 'rise/courses/SRC/a.jpg' } } }] },
        ],
      },
    ],
  };
}
function faithfulTarget(): GetCourseDocument {
  return {
    course: { id: 'NEW', title: 'C' },
    lessons: [
      {
        id: 'L1new',
        position: 0,
        type: 'blocks',
        title: 'Lesson 1',
        items: [
          { id: 'b1new', globalBlockId: 'g1', createdAt: 't', family: 'text', variant: 'paragraph', items: [{ id: 'i1new', paragraph: '<p>Hello</p>' }] },
          { id: 'b2new', globalBlockId: 'g2', family: 'image', variant: 'hero', items: [{ id: 'i2new', media: { image: { key: 'rise/courses/NEW/z.jpg', crushedKey: 'rise/courses/NEW/zz.jpg' } } }] },
        ],
      },
    ],
  };
}

describe('verifyParity', () => {
  it('passes for a faithful round-trip (ids/keys/server fields aside)', () => {
    const r = verifyParity(src(), faithfulTarget());
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.blocks).toEqual({ source: 2, target: 2, compared: 2 });
  });

  it('flags a missing block on the target', () => {
    const t = faithfulTarget();
    t.lessons![0]!.items!.pop(); // drop the image block
    const r = verifyParity(src(), t);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.kind === 'missing-block')).toBe(true);
  });

  it('flags a changed block type', () => {
    const t = faithfulTarget();
    (t.lessons![0]!.items![0] as any).variant = 'heading';
    const r = verifyParity(src(), t);
    expect(r.issues.some((i) => i.kind === 'block-type-changed')).toBe(true);
  });

  it('treats only an announced legacy Storyline donor replacement as expected', () => {
    const s = src();
    (s.lessons![0]!.items![0] as any) = {
      id: 'b1src',
      family: '360',
      variant: 'storyline',
      items: [{ id: 'i1', media: { storyline: { meta: { version: '3.48.24159.0' } } } }],
    };
    const t = faithfulTarget();
    const r = verifyParity(s, t, [
      {
        kind: 'storyline',
        sourceLessonId: 'L1src',
        sourceBlockId: 'b1src',
        expectedReplacement: 'legacy-storyline',
        detail: 'legacy placeholder',
      },
    ]);
    expect(r.issues.some((issue) => issue.kind === 'block-type-changed')).toBe(false);
    expect(
      r.expectedDivergences.some((issue) => issue.kind === 'block-type-changed'),
    ).toBe(true);
  });

  it('flags real content change (text differs)', () => {
    const t = faithfulTarget();
    (t.lessons![0]!.items![0] as any).items[0].paragraph = '<p>Goodbye</p>';
    const r = verifyParity(src(), t);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.kind === 'content-changed')).toBe(true);
  });

  it('classifies a dropped media slot as a real issue by default', () => {
    const t = faithfulTarget();
    (t.lessons![0]!.items![1] as any).items[0].media.image.key = '';
    (t.lessons![0]!.items![1] as any).items[0].media.image.crushedKey = '';
    const r = verifyParity(src(), t);
    expect(r.issues.some((i) => i.kind === 'media-missing')).toBe(true);
  });

  it('treats a dropped media slot as EXPECTED when the block was flagged', () => {
    const t = faithfulTarget();
    (t.lessons![0]!.items![1] as any).items[0].media.image.key = '';
    (t.lessons![0]!.items![1] as any).items[0].media.image.crushedKey = '';
    const r = verifyParity(src(), t, [
      { kind: 'orphan-media', sourceBlockId: 'b2src', detail: 'gone' },
    ]);
    expect(r.issues.some((i) => i.kind === 'media-missing')).toBe(false);
    expect(r.expectedDivergences.some((i) => i.kind === 'media-missing')).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('a COURSE-LEVEL flag does not excuse a block media loss (per-block tolerance, M5)', () => {
    // Regression: one unsupported-media flag (e.g. a custom theme image) used to
    // make EVERY block's media-missing divergence "expected", course-wide.
    const t = faithfulTarget();
    (t.lessons![0]!.items![1] as any).items[0].media.image.key = '';
    (t.lessons![0]!.items![1] as any).items[0].media.image.crushedKey = '';
    const r = verifyParity(src(), t, [
      { kind: 'unsupported-media', sourceKey: 'rise/courses/SRC/theme-logo.svg', detail: 'theme image' },
      { kind: 'storyline', sourceBlockId: 'someOtherBlock', detail: 'other block' },
    ]);
    expect(r.issues.some((i) => i.kind === 'media-missing')).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('tolerates media loss when the flagged KEY lives in this block (oversize/unsupported)', () => {
    // Oversize flags carry a sourceKey but no block id — the block that actually
    // contains that key tolerates the loss; others do not.
    const t = faithfulTarget();
    (t.lessons![0]!.items![1] as any).items[0].media.image.key = '';
    (t.lessons![0]!.items![1] as any).items[0].media.image.crushedKey = '';
    const r = verifyParity(src(), t, [
      { kind: 'unsupported-media', sourceKey: 'rise/courses/SRC/a.jpg', detail: 'too large' },
    ]);
    expect(r.issues.some((i) => i.kind === 'media-missing')).toBe(false);
    expect(r.expectedDivergences.some((i) => i.kind === 'media-missing')).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('renders a markdown summary', () => {
    const md = parityReportToMarkdown(verifyParity(src(), faithfulTarget()));
    expect(md).toContain('Read-back parity');
    expect(md).toContain('Unexpected divergences: 0');
  });

  // Regression: parity must align both sides by the authoritative `course.lessons`
  // id list — NOT by `position` (which scrambles a real course). Here the source's
  // position order is the REVERSE of its course.lessons order; the target was built
  // in course.lessons order (positions 0,1). Sorting by position would compare a
  // section against a content lesson and manufacture divergences. With the correct
  // ordering both sides align and the round-trip passes.
  it('orders lessons by course.lessons, not position (scramble-proof)', () => {
    const scrambledSource: GetCourseDocument = {
      course: { id: 'SRC', title: 'C', lessons: ['Lsec', 'Lcontent'] } as any,
      lessons: [
        // Array/position order is the OPPOSITE of course.lessons order.
        {
          id: 'Lcontent',
          position: 0,
          type: 'blocks',
          title: 'Content',
          items: [{ id: 'b1src', family: 'text', variant: 'paragraph', items: [{ id: 'i1', paragraph: '<p>Hi</p>' }] }],
        },
        { id: 'Lsec', position: 1, type: 'section', title: 'Section' },
      ],
    };
    const builtTarget: GetCourseDocument = {
      course: { id: 'NEW', title: 'C', lessons: ['Tsec', 'Tcontent'] } as any,
      lessons: [
        { id: 'Tsec', position: 0, type: 'section', title: 'Section' },
        {
          id: 'Tcontent',
          position: 1,
          type: 'blocks',
          title: 'Content',
          items: [{ id: 'b1new', family: 'text', variant: 'paragraph', items: [{ id: 'i1new', paragraph: '<p>Hi</p>' }] }],
        },
      ],
    };
    const r = verifyParity(scrambledSource, builtTarget);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

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

describe('verifyParity — course-field read-back (theme, images, settings)', () => {
  const base = (over: Record<string, unknown> = {}): GetCourseDocument =>
    ({
      course: {
        id: 'X',
        title: 'My Course',
        description: '<p>About</p>',
        theme: {
          themeId: 'classic',
          colorAccent: '#ff631e',
          navigationType: 'SIDEBAR',
          uiTypefaceId: 't1Nkx9Ab7dQb4z_F5v8EgdA0Q11M3_If',
        },
        coverImage: { media: { image: { key: 'rise/courses/X/cover.jpg', type: 'image' } } },
        cardImage: null,
        media: {},
        sidebarMode: 'open',
        markComplete: false,
        lessons: [],
        ...over,
      },
      lessons: [],
    }) as never;

  it('passes when fields match modulo remapped ids/media and empty-shape noise', () => {
    const target = base({
      id: 'Y',
      // remapped media key + a DIFFERENT (target) typeface id + {} vs null
      coverImage: { media: { image: { key: 'rise/courses/Y/new.jpg', type: 'image' } } },
      theme: {
        themeId: 'classic',
        colorAccent: '#ff631e',
        navigationType: 'SIDEBAR',
        uiTypefaceId: 'Zt9Qx1Ab7dQb4z_F5v8EgdA0Q11M3_Zz',
      },
      cardImage: {},
      media: null,
    });
    const r = verifyParity(base(), target);
    expect(r.issues).toEqual([]);
  });

  it('catches a dropped cover image (the built-in-cover bug class)', () => {
    const target = base({ coverImage: {} });
    const r = verifyParity(base(), target);
    expect(r.issues).toEqual([
      expect.objectContaining({ kind: 'course-field-changed', path: 'course.coverImage' }),
    ]);
  });

  it('catches a leftover !importing: title', () => {
    const target = base({ title: '!importing: My Course' });
    const r = verifyParity(base(), target);
    expect(r.issues.map((i) => i.path)).toContain('course.title');
  });

  it('reports unmigrated settings honestly as EXPECTED (known gap); theme stays a real issue', () => {
    const source = base({
      sidebarMode: 'closed',
      markComplete: true,
      theme: { themeId: 'classic', colorAccent: '#123456' },
    });
    const target = base(); // fresh-course defaults
    const r = verifyParity(source, target);
    // Settings are verified + reported, but routed to the expected bucket: the
    // tool documents it doesn't migrate them yet, so they must not mark an
    // otherwise-faithful course partial. Theme IS written by the import — a
    // theme divergence is a real, unexpected failure.
    expect(r.issues.map((i) => i.path)).toEqual(['course.theme']);
    const expectedPaths = r.expectedDivergences.map((i) => i.path).sort();
    expect(expectedPaths).toEqual(['course.markComplete', 'course.sidebarMode']);
    expect(
      r.expectedDivergences.every((i) => i.detail?.includes('not migrated yet')),
    ).toBe(true);
  });

  it('stack refs on both sides canonicalize equal (different l10nIds)', () => {
    const source = base({
      title: { l10nId: 'aaaa1111-0000-4000-8000-000000000001' },
      description: { l10nId: 'aaaa1111-0000-4000-8000-000000000002' },
    });
    const target = base({
      title: { l10nId: 'bbbb2222-0000-4000-8000-00000000000a' },
      description: { l10nId: 'bbbb2222-0000-4000-8000-00000000000b' },
    });
    expect(verifyParity(source, target).issues).toEqual([]);
  });

  it('marks a divergence EXPECTED when the field holds a flagged key', () => {
    const source = base();
    const target = base({ coverImage: {} });
    const r = verifyParity(source, target, [
      { kind: 'orphan-media', sourceKey: 'rise/courses/X/cover.jpg', detail: 'deleted at source' },
    ]);
    expect(r.issues).toEqual([]);
    expect(r.expectedDivergences).toEqual([
      expect.objectContaining({ kind: 'course-field-changed', expected: true }),
    ]);
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
