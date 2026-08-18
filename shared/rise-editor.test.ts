import { describe, expect, it } from 'vitest';
import { courseEditorUrl, editorCourseIdFromUrl } from './rise-editor';

describe('courseEditorUrl', () => {
  it('uses the live US tab origin and the capture-confirmed authoring route', () => {
    expect(courseEditorUrl('https://rise.articulate.com/manage/folder/abc?x=1', 'course-1')).toBe(
      'https://rise.articulate.com/authoring/course-1',
    );
  });

  it('keeps an EU export on the EU plane', () => {
    expect(courseEditorUrl('https://rise.eu.articulate.com/', 'course-2')).toBe(
      'https://rise.eu.articulate.com/authoring/course-2',
    );
  });

  it('refuses non-Rise origins and empty ids', () => {
    expect(courseEditorUrl('https://example.com/', 'course-1')).toBeNull();
    expect(courseEditorUrl('https://rise.articulate.com/manage', '   ')).toBeNull();
  });
});

describe('editorCourseIdFromUrl', () => {
  it('reads the course id off an editor URL on either plane', () => {
    expect(
      editorCourseIdFromUrl('https://rise.articulate.com/authoring/abc123/outline?x=1'),
    ).toBe('abc123');
    expect(
      editorCourseIdFromUrl('https://rise.eu.articulate.com/authoring/xyz'),
    ).toBe('xyz');
  });

  it('round-trips with courseEditorUrl', () => {
    const url = courseEditorUrl('https://rise.articulate.com/manage', 'course-1');
    expect(editorCourseIdFromUrl(url)).toBe('course-1');
  });

  it('returns null for non-editor Rise pages, non-Rise URLs, and missing input', () => {
    expect(editorCourseIdFromUrl('https://rise.articulate.com/manage/folder/1')).toBeNull();
    expect(editorCourseIdFromUrl('https://rise.articulate.com/')).toBeNull();
    expect(editorCourseIdFromUrl('https://example.com/authoring/abc')).toBeNull();
    expect(editorCourseIdFromUrl(undefined)).toBeNull();
    expect(editorCourseIdFromUrl(null)).toBeNull();
  });
});
