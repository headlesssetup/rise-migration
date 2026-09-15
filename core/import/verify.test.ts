import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  verifyParity,
  parityReportToMarkdown,
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
    expect(md).toContain('Blocking divergences: 0');
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

  it('blocks on writable settings; legacy top-level mirrors are expected only', () => {
    // v0.9.9 policy (capture 2026-08-31, `-settings.mitm` + `-fonts.mitm`):
    // the current editor writes settings/exportSettings/aiTutorConfig and the
    // THEME twins of the navigation scalars — the top-level scalars are
    // unwritable legacy mirrors (source courses even disagree with their own
    // theme and still preview/publish). Behavior parity rides `theme`
    // (blocking); the mirrors demote to expected divergences.
    const source = base({
      sidebarMode: 'closed',
      markComplete: true,
      settings: { aiTutorEnabled: false, isAIConceptToCourse: true },
      theme: { themeId: 'classic', colorAccent: '#123456' },
    });
    const target = base(); // fresh-course defaults
    const r = verifyParity(source, target);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.path).sort()).toEqual([
      'course.settings',
      'course.theme',
    ]);
    expect(r.expectedDivergences.map((i) => i.path).sort()).toEqual([
      'course.markComplete',
      'course.sidebarMode',
    ]);
    expect(
      r.expectedDivergences.every((i) => i.detail?.includes('legacy top-level mirror')),
    ).toBe(true);
  });

  it('settings compares absent booleans as OFF (the panel writes explicit false)', () => {
    // {} vs {aiTutorEnabled:false} — both mean the AI tutor is off.
    const r = verifyParity(
      base({ settings: {} }),
      base({ settings: { aiTutorEnabled: false } }),
    );
    expect(r.issues.filter((i) => i.path === 'course.settings')).toEqual([]);
    // {} vs {aiTutorEnabled:true} — a REAL behavior difference, blocking.
    const r2 = verifyParity(
      base({ settings: {} }),
      base({ settings: { aiTutorEnabled: true } }),
    );
    expect(r2.issues.some((i) => i.path === 'course.settings')).toBe(true);
  });

  it('reads back the full settings surface: writable fields block, mirrors expected', () => {
    const mirrors: Record<string, unknown> = {
      sidebarMode: 'closed',
      navigationMode: 'restricted',
      showLessonCount: false,
      showNavigationButtons: false,
      allowSearch: false,
      animateBlockEntrance: false,
      markComplete: true,
      enableVideoPlaybackSpeed: false,
      color: '#123456',
    };
    const writable: Record<string, unknown> = {
      allowCopy: true, // no captured control writes it anywhere → stays loud
      settings: { aiTutorEnabled: true, isAIConceptToCourse: true },
      aiTutorConfig: { mode: 'guided' },
    };
    const source = base({ ...mirrors, ...writable });
    const target = base();
    const r = verifyParity(source, target);
    expect(r.ok).toBe(false);
    expect(new Set(r.issues.map((i) => i.path))).toEqual(
      new Set(Object.keys(writable).map((field) => `course.${field}`)),
    );
    expect(new Set(r.expectedDivergences.map((i) => i.path))).toEqual(
      new Set(Object.keys(mirrors).map((field) => `course.${field}`)),
    );
  });

  it('confirms the course kind created by the importer', () => {
    const r = verifyParity(base({ type: 'onePage' }), base({ type: null }));
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([
      expect.objectContaining({ kind: 'course-field-changed', path: 'course.type' }),
    ]);
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


describe('course fields the source never carried (Creator-built courses, v0.9.12)', () => {
  it('treats a target default in an ABSENT source field as expected, never blocking', () => {
    const s = src();
    delete (s.course as Record<string, unknown>).theme;
    delete (s.course as Record<string, unknown>).allowCopy;
    const t = faithfulTarget();
    (t.course as Record<string, unknown>).theme = { themeId: 'classic', colorAccent: '#0f0' };
    (t.course as Record<string, unknown>).allowCopy = false;
    const r = verifyParity(s, t);
    expect(r.issues.filter((i) => i.path === 'course.theme' || i.path === 'course.allowCopy')).toEqual([]);
    expect(r.expectedDivergences.some((i) => i.path === 'course.theme' && /never carried/.test(i.detail ?? ''))).toBe(true);
  });

  it('still blocks when the source CARRIES the field and the target differs', () => {
    const s = src();
    (s.course as Record<string, unknown>).theme = { themeId: 'organic' };
    const t = faithfulTarget();
    (t.course as Record<string, unknown>).theme = { themeId: 'classic' };
    const r = verifyParity(s, t);
    expect(r.issues.some((i) => i.path === 'course.theme')).toBe(true);
  });
});
