import { describe, expect, it } from 'vitest';
import { findStorylineBlocks, hasStorylineBlocks, storylineLeaves } from './detect';

const course = {
  course: { id: 'C1' },
  lessons: [
    {
      id: 'les_1',
      items: [
        { id: 'blk_text', family: 'text', variant: 'paragraph', items: [{ id: 'i0' }] },
        {
          id: 'blk_story',
          type: 'interactive',
          family: '360',
          variant: 'storyline',
          items: [
            {
              id: 'item_1',
              media: {
                storyline: {
                  contentPrefix: 'rise/courses/C1/k3sFdQgN6xRXAoBp',
                  src: 'rise/courses/C1/k3sFdQgN6xRXAoBp/story.html',
                  meta: { title: 'Geo 101', version: '7' },
                },
              },
            },
          ],
        },
      ],
    },
    {
      id: 'les_2',
      items: [
        // a never-attached placeholder storyline block (no media yet)
        { id: 'blk_empty', family: '360', variant: 'storyline', items: [{ id: 'item_2' }] },
      ],
    },
  ],
};

describe('findStorylineBlocks', () => {
  it('finds both attached and placeholder storyline blocks with lesson ids', () => {
    const refs = findStorylineBlocks(course);
    expect(refs).toHaveLength(2);

    const attached = refs.find((r) => r.blockId === 'blk_story')!;
    expect(attached.lessonId).toBe('les_1');
    expect(attached.itemId).toBe('item_1');
    expect(attached.leaf).toBe('k3sFdQgN6xRXAoBp');
    expect(attached.meta).toEqual({ title: 'Geo 101', version: '7' });

    const placeholder = refs.find((r) => r.blockId === 'blk_empty')!;
    expect(placeholder.lessonId).toBe('les_2');
    expect(placeholder.itemId).toBe('item_2');
    expect(placeholder.leaf).toBeUndefined();
    expect(placeholder.meta).toBeUndefined();
  });

  it('ignores non-storyline blocks', () => {
    const refs = findStorylineBlocks(course);
    expect(refs.some((r) => r.family === 'text')).toBe(false);
  });

  it('hasStorylineBlocks reflects presence', () => {
    expect(hasStorylineBlocks(course)).toBe(true);
    expect(hasStorylineBlocks({ course: { id: 'X' }, lessons: [{ id: 'l', items: [] }] })).toBe(false);
    expect(hasStorylineBlocks({})).toBe(false);
  });

  it('handles a ducks-wrapped / course.lessons nesting', () => {
    const wrapped = { payload: { course: { id: 'C', lessons: course.lessons } } };
    expect(findStorylineBlocks(wrapped).length).toBe(2);
  });

  it('dedupes a block reachable via two paths by BLOCK ID, keeping the first path', () => {
    // The same lessons array hangs off two keys (e.g. top-level AND under
    // course), so every block is reachable via two distinct JSON paths.
    const doubled = { lessons: course.lessons, course: { id: 'C1', lessons: course.lessons } };
    const refs = findStorylineBlocks(doubled);
    expect(refs.map((r) => r.blockId).sort()).toEqual(['blk_empty', 'blk_story']); // one ref per block
    // the FIRST path found is kept (diagnostics) — top-level lessons walk first
    expect(refs.find((r) => r.blockId === 'blk_story')!.path).toMatch(/^\$\.lessons\[0\]/);
  });

  it('does NOT collapse distinct id-less (malformed) blocks', () => {
    const doc = {
      lessons: [
        {
          id: 'les_x',
          items: [
            { family: '360', variant: 'storyline', items: [] },
            { family: '360', variant: 'storyline', items: [] },
          ],
        },
      ],
    };
    expect(findStorylineBlocks(doc)).toHaveLength(2);
  });
});

describe('findStorylineBlocks — multi-language stacks (docs/rise-multilang.md §4.3b)', () => {
  // A stack storyline block: media is an {l10nId} ref; each locale's cell holds
  // its OWN package (capture2aug: en-us and ru attached different bundles).
  const stackDoc = {
    course: { id: 'STACK', localizationMetadata: { isLocalized: true } },
    lessons: [
      {
        id: 'L1',
        items: [
          {
            id: 'blkSL',
            family: '360',
            variant: 'storyline',
            items: [{ id: 'itemSL', media: { l10nId: 'cell-sl' } }],
          },
        ],
      },
    ],
    l10n: {
      defaultLocale: 'en-us',
      translations: {
        'en-us': {
          'cell-sl': {
            storyline: {
              contentPrefix: 'rise/courses/STACK/leafEN',
              src: 'rise/courses/STACK/leafEN/story.html',
              meta: { title: 'Onboarding EN' },
            },
          },
        },
        ru: {
          'cell-sl': {
            storyline: {
              contentPrefix: 'rise/courses/STACK/leafRU',
              meta: { title: 'Onboarding RU' },
            },
          },
        },
        // a locale with no override: falls back, so no entry of its own
        ar: { other: 'text' },
      },
    },
  };

  it('yields one entry per language that holds a package, with locale + cell id', () => {
    const refs = findStorylineBlocks(stackDoc);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => [r.locale, r.leaf])).toEqual([
      ['en-us', 'leafEN'],
      ['ru', 'leafRU'],
    ]);
    for (const r of refs) {
      expect(r.blockId).toBe('blkSL');
      expect(r.lessonId).toBe('L1');
      expect(r.itemId).toBe('itemSL');
      expect(r.l10nId).toBe('cell-sl');
    }
    expect(refs[1]!.meta).toEqual({ title: 'Onboarding RU' });
  });

  it('reports every distinct leaf once (the repackaging unit)', () => {
    expect(storylineLeaves(findStorylineBlocks(stackDoc)).sort()).toEqual(['leafEN', 'leafRU']);
    // two languages sharing ONE package → a single leaf
    const shared = JSON.parse(JSON.stringify(stackDoc)) as typeof stackDoc;
    (shared.l10n.translations.ru!['cell-sl'] as { storyline: { contentPrefix: string } })
      .storyline.contentPrefix = 'rise/courses/STACK/leafEN';
    expect(storylineLeaves(findStorylineBlocks(shared))).toEqual(['leafEN']);
  });

  it('still yields one leaf-less entry for a stack block with no package anywhere', () => {
    const empty = JSON.parse(JSON.stringify(stackDoc)) as typeof stackDoc;
    empty.l10n.translations = { 'en-us': {}, ru: {} } as never;
    const refs = findStorylineBlocks(empty);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.blockId).toBe('blkSL');
    expect(refs[0]!.leaf).toBeUndefined();
    expect(refs[0]!.locale).toBeUndefined();
  });

  it('leaves monolingual detection unchanged (no locale/l10nId fields)', () => {
    const mono = {
      lessons: [
        {
          id: 'L1',
          items: [
            {
              id: 'b1',
              family: '360',
              variant: 'storyline',
              items: [
                {
                  id: 'i1',
                  media: { storyline: { contentPrefix: 'rise/courses/C/leaf1', meta: {} } },
                },
              ],
            },
          ],
        },
      ],
    };
    const refs = findStorylineBlocks(mono);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.leaf).toBe('leaf1');
    expect(refs[0]!.locale).toBeUndefined();
    expect(refs[0]!.l10nId).toBeUndefined();
  });
});
