import { describe, expect, it } from 'vitest';
import sample from '../../tests/fixtures/get-course.sample.json';
import { classifyString, scanCourse } from './scan';
import type { GetCourseDocument } from '@/shared/types/rise';

describe('classifyString', () => {
  it('subtypes uploaded media keys by extension/path (by KEY PATH, any host)', () => {
    // An upload is the rise/courses|questionBanks key path — regardless of host.
    expect(classifyString('https://articulateusercontent.com/rise/courses/abc/x.jpg')).toBe(
      'media-image',
    );
    // EU usercontent host — same rule.
    expect(classifyString('https://articulateusercontent.eu/rise/courses/abc/x.jpg')).toBe(
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

  it('classifies CDN and embeds distinctly (US + EU planes)', () => {
    expect(classifyString('https://cdn.articulate.com/assets/x.jpg')).toBe('cdn');
    expect(classifyString('https://cdn.eu.articulate.com/assets/rise/assets/themes/classic/cover.jpg')).toBe('cdn');
    expect(classifyString('https://www.youtube.com/watch?v=1')).toBe('embed');
    expect(classifyString('https://vimeo.com/123')).toBe('embed');
  });

  it('keeps a BUILT-IN served from the usercontent host as cdn (not an upload)', () => {
    // The usercontent host serves built-ins under /assets/rise/… — these must NOT
    // be treated as uploads (they'd be wrongly blanked from a migrated theme).
    expect(
      classifyString('https://articulateusercontent.eu/assets/rise/assets/themes/example-header-image.jpg'),
    ).toBe('cdn');
    expect(
      classifyString('https://articulateusercontent.com/assets/rise/assets/themes/example-header-image.jpg'),
    ).toBe('cdn');
    // A bare source filename (image block `originalUrl`) is not a media key.
    expect(classifyString('9f49b7678e07e72d17ca07b51087353f.jpg')).toBeNull();
  });

  it('returns null for plain strings', () => {
    expect(classifyString('<p>Hello</p>')).toBeNull();
    expect(classifyString('Module header')).toBeNull();
  });

  it('a string mixing an embed URL and an uploaded key classifies as MEDIA (key wins)', () => {
    // Regression (C3): with embed checked first, the uploaded key was invisible
    // to download/remap/blank/verify — a silent key survival with no backstop.
    // (The media SUBTYPE of an embedded key is incidental — media-ness is what
    // keeps it visible to the pipeline.)
    const isMedia = (v: string): boolean => classifyString(v)?.startsWith('media-') ?? false;
    expect(
      isMedia(
        '<p>Watch https://www.youtube.com/watch?v=1 and see <img src="https://articulateusercontent.com/rise/courses/abc/x.jpg"></p>',
      ),
    ).toBe(true);
    expect(isMedia('https://vimeo.com/123 rise/courses/abc/clip.mp3')).toBe(true);
  });

  it('recognizes keys behind (, =, ",", >, ; boundaries (CSS url(), unquoted attrs, entities)', () => {
    // Regression (H8): the leading boundary class missed these embeddings.
    const isMedia = (v: string): boolean => classifyString(v)?.startsWith('media-') ?? false;
    expect(isMedia('background-image:url(rise/courses/abc/bg.png)')).toBe(true);
    expect(isMedia('<img src=rise/courses/abc/x.jpg>')).toBe(true);
    expect(isMedia('a.jpg,rise/courses/abc/b.jpg')).toBe(true);
    expect(isMedia('<br>rise/courses/abc/x.jpg')).toBe(true);
    expect(isMedia('&quot;rise/courses/abc/x.jpg&quot;')).toBe(true);
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

  it('versionSignal fallback picks the SHALLOWEST version field, not the first in DFS order', () => {
    const doc = {
      course: { id: 'c1' },
      lessons: [],
      // DFS visits `a.b.version` (depth 3) before the top-level `version`
      // (depth 1) — shallowest must still win.
      a: { b: { version: 'deep' } },
      version: 'shallow',
    } as unknown as GetCourseDocument;
    expect(scanCourse(doc).versionSignal).toBe('shallow');
  });

  it('an explicit course.version beats any fallback version field', () => {
    const doc = {
      course: { id: 'c1', version: '2025.2' },
      lessons: [],
      version: 'shallow',
    } as unknown as GetCourseDocument;
    expect(scanCourse(doc).versionSignal).toBe('2025.2');
  });
});
