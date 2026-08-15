import { describe, expect, it } from 'vitest';
import { courseEditorUrl } from './rise-editor';

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
