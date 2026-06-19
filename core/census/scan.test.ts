import { describe, expect, it } from 'vitest';
import sample from '../../tests/fixtures/get-course.sample.json';
import { classifyString, scanCourse } from './scan';
import type { GetCourseDocument } from '@/shared/types/rise';

describe('classifyString', () => {
  it('subtypes uploaded media keys by extension/path', () => {
    expect(classifyString('https://articulateusercontent.com/rise/x.jpg')).toBe(
      'media-image',
    );
    expect(classifyString('rise/courses/abc/file.mp4')).toBe('media-video');
    expect(classifyString('rise/courses/abc/clip.mp3')).toBe('media-audio');
    // Question-bank assets live under rise/questionBanks/{id}/…
    expect(classifyString('rise/questionBanks/bnk/img.jpg')).toBe('media-image');
    // No extension hint, but the JSON path says it's a video.
    expect(
      classifyString('rise/courses/abc/transcoded-xyz', '$.media.video.key'),
    ).toBe('media-video');
    // Storyline bundle keys are tagged by path.
    expect(
      classifyString('rise/courses/abc/pkg/story.html', '$.media.storyline.src'),
    ).toBe('media-storyline');
  });

  it('classifies CDN and embeds distinctly', () => {
    expect(classifyString('https://cdn.articulate.com/assets/x.jpg')).toBe('cdn');
    expect(classifyString('https://www.youtube.com/watch?v=1')).toBe('embed');
    expect(classifyString('https://vimeo.com/123')).toBe('embed');
  });

  it('returns null for plain strings', () => {
    expect(classifyString('<p>Hello</p>')).toBeNull();
    expect(classifyString('Module header')).toBeNull();
  });
});

describe('scanCourse', () => {
  const scan = scanCourse(sample as GetCourseDocument);

  it('captures the courseId and version signal', () => {
    expect(scan.courseId).toBe('course-abc123');
    expect(scan.versionSignal).toBe('2024.1');
  });

  it('enumerates every distinct family/variant', () => {
    const keys = new Set(scan.blocks.map((b) => b.key));
    expect(keys).toEqual(
      new Set([
        'text/paragraph',
        'image/hero',
        'multimedia/embed',
        '360/storyline',
        'knowledgeCheck/draw from question bank',
      ]),
    );
  });

  it('records lesson and question types', () => {
    expect(scan.lessonTypes).toEqual(['blocks', 'quiz', 'section']);
    expect(scan.questionTypes).toEqual(['MATCHING', 'MULTIPLE_CHOICE']);
  });

  it('flags media keys, cross-refs, cdn and embeds by kind', () => {
    const kinds = scan.refs.map((r) => r.kind);
    expect(kinds).toContain('media-image'); // image/hero block key
    expect(kinds).toContain('media-storyline'); // storyline bundle keys
    expect(kinds).toContain('cdn');
    expect(kinds).toContain('embed');
    expect(kinds).toContain('storyline-crossref');
    expect(kinds).toContain('draw-from-bank-crossref');
  });

  it('records a JSON path for each reference', () => {
    for (const ref of scan.refs) {
      expect(ref.path.startsWith('$')).toBe(true);
    }
  });
});
