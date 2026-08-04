// Structural pairing for the idea-2 stack import: source refs ↔ the refs the
// TARGET's own conversion minted, matched by course path / lesson id map /
// minted block ids — never by raw array order (F1) and never by bare block id
// (the v0.6.3 duplicate-id trap).

import { describe, expect, it } from 'vitest';
import { pairL10nRefs } from './pair';
import type { GetCourseDocument } from '@/shared/types/rise';

const ref = (id: string): { l10nId: string } => ({ l10nId: id });

function docs(): { source: GetCourseDocument; target: GetCourseDocument } {
  const source = {
    course: {
      id: 'SRC',
      title: ref('s-title'),
      description: ref('s-desc'),
      lessons: ['sl1', 'sl2'],
    },
    // Raw array order INVERTED vs course.lessons — pairing goes via the id
    // map, so this must not matter.
    lessons: [
      {
        id: 'sl2',
        title: ref('s-l2title'),
        items: [{ id: '1', family: 'text', variant: 'paragraph', items: [{ id: 'i1', title: ref('s-b2text') }] }],
      },
      {
        id: 'sl1',
        title: ref('s-l1title'),
        items: [{ id: '1', family: 'text', variant: 'paragraph', items: [{ id: 'i1', title: ref('s-b1text') }] }],
      },
    ],
  } as never as GetCourseDocument;
  const target = {
    course: {
      id: 'TGT',
      title: ref('t-title'),
      description: ref('t-desc'),
      lessons: ['tl1', 'tl2'],
    },
    lessons: [
      {
        id: 'tl1',
        title: ref('t-l1title'),
        items: [{ id: 'nb1', family: 'text', variant: 'paragraph', items: [{ id: 'ni1', title: ref('t-b1text') }] }],
      },
      {
        id: 'tl2',
        title: ref('t-l2title'),
        items: [{ id: 'nb2', family: 'text', variant: 'paragraph', items: [{ id: 'ni2', title: ref('t-b2text') }] }],
      },
    ],
  } as never as GetCourseDocument;
  return { source, target };
}

const idMaps = {
  lessonId: (l: string): string | undefined =>
    ({ sl1: 'tl1', sl2: 'tl2' } as Record<string, string>)[l],
  blockId: (l: string, b: string): string | undefined =>
    ({ 'sl1 1': 'nb1', 'sl2 1': 'nb2' } as Record<string, string>)[`${l} ${b}`],
};

describe('pairL10nRefs', () => {
  it('pairs course fields by path, lessons by id map, blocks by minted id (duplicate "1" ids safe)', () => {
    const { source, target } = docs();
    const r = pairL10nRefs(source, target, idMaps);
    expect(Object.fromEntries(r.map)).toEqual({
      's-title': 't-title',
      's-desc': 't-desc',
      's-l1title': 't-l1title',
      's-l2title': 't-l2title',
      's-b1text': 't-b1text',
      's-b2text': 't-b2text',
    });
    expect(r.unmatched).toEqual([]);
    expect(r.targetOnly).toEqual([]);
    expect(r.targetOnlyEmpty).toEqual([]);
  });

  it('reports a source ref the target did not localize as unmatched (loud)', () => {
    const { source, target } = docs();
    (target.course as Record<string, unknown>).description = 'plain string';
    const r = pairL10nRefs(source, target, idMaps);
    expect(r.unmatched).toEqual([{ path: 'course.description', l10nId: 's-desc' }]);
    expect(r.map.has('s-desc')).toBe(false);
  });

  it('classifies target-only refs: deep-empty source slot → expected, non-empty → surfaced', () => {
    const { source, target } = docs();
    // No logo at the source; the conversion minted a ref anyway (F3 analog).
    (target.course as Record<string, unknown>).media = ref('t-logo');
    (source.course as Record<string, unknown>).media = { image: null };
    // A field the source held as PLAIN text but today's Rise localizes.
    (source.course as Record<string, unknown>).subtitle = 'plain subtitle';
    (target.course as Record<string, unknown>).subtitle = ref('t-subtitle');
    const r = pairL10nRefs(source, target, idMaps);
    expect(r.targetOnlyEmpty).toEqual([{ path: 'course.media', l10nId: 't-logo' }]);
    expect(r.targetOnly).toEqual([{ path: 'course.subtitle', l10nId: 't-subtitle' }]);
  });

  it('a source block with no target counterpart collects ALL its refs as unmatched', () => {
    const { source, target } = docs();
    const r = pairL10nRefs(source, target, {
      ...idMaps,
      blockId: (l, b) => (l === 'sl1' ? undefined : idMaps.blockId(l, b)),
    });
    expect(r.unmatched).toEqual([
      { path: 'lessons[sl1].block[1].items[0].title', l10nId: 's-b1text' },
    ]);
  });
});
