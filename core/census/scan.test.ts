import { describe, expect, it } from 'vitest';
import sample from '../../tests/fixtures/get-course.sample.json';
import { classifyString, scanCourse } from './scan';
import type { GetCourseDocument } from '@/shared/types/rise';

describe('classifyString', () => {
  it('classifies usercontent + rise/ keys as media-key', () => {
    expect(classifyString('https://articulateusercontent.com/rise/x.jpg')).toBe(
      'media-key',
    );
    expect(classifyString('rise/courses/abc/file.jpg')).toBe('media-key');
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
    expect(kinds).toContain('media-key');
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
