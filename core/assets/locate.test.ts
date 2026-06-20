import { describe, expect, it } from 'vitest';
import sample from '../../tests/fixtures/get-course.sample.json';
import { formatLocation, locateKey } from './locate';

describe('locateKey', () => {
  it('resolves a key path to its lesson + block in the fixture', () => {
    // The image block lives in lesson "Content" (type "blocks").
    const loc = locateKey(
      sample,
      '$.lessons[1].items[1].items[0].media.image.key',
    );
    expect(loc.lessonTitle).toBe('Content');
    expect(loc.lessonType).toBe('blocks');
    expect(loc.family).toBe('image');
    expect(loc.variant).toBe('hero');
    expect(loc.blockId).toBe('block-2');
  });

  it('does not let a block\'s own type/title clobber the lesson title', () => {
    // Quiz lesson; a question item has its own type+title ("Pick one").
    const loc = locateKey(sample, '$.lessons[2].items[0]');
    expect(loc.lessonTitle).toBe('Quiz');
    expect(loc.lessonType).toBe('quiz');
  });

  it('returns best-effort partial info when the path diverges', () => {
    const loc = locateKey(sample, '$.lessons[99].items[0].media');
    expect(loc.lessonTitle).toBeUndefined();
    expect(loc.family).toBeUndefined();
  });

  it('formats a compact one-line location', () => {
    expect(
      formatLocation({ lessonTitle: 'Chapter 2', family: 'image', variant: 'hero' }),
    ).toBe('Chapter 2 › image/hero');
    expect(formatLocation({})).toBe('? › block');
  });
});
