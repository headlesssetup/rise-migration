import { describe, it, expect } from 'vitest';
import { canonicalize, verifyParity, parityReportToMarkdown } from './verify';
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
