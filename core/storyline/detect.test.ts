import { describe, expect, it } from 'vitest';
import { findStorylineBlocks, hasStorylineBlocks } from './detect';

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
});
