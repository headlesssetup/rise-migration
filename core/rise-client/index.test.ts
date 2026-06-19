import { describe, expect, it } from 'vitest';
import { buildGetCourseRequest, buildSearchRequest } from './index';

describe('buildSearchRequest', () => {
  it('builds a relative search URL with defaults and NO type filter', () => {
    const { url, method } = buildSearchRequest({ page: 0 });
    expect(method).toBe('GET');
    expect(url.startsWith('/manage/api/content/search?')).toBe(true);
    expect(url).toContain('page=0');
    expect(url).toContain('pageSize=16');
    expect(url).toContain('sort=RECENTLY_UPDATED');
    expect(url).not.toContain('type='); // omitted by default → all content
  });

  it('includes type params only when explicitly requested', () => {
    const { url } = buildSearchRequest({
      page: 0,
      types: ['COURSE', 'MICROLEARNING'],
    });
    expect(url).toContain('type=COURSE');
    expect(url).toContain('type=MICROLEARNING');
  });
});

describe('buildGetCourseRequest', () => {
  it('builds the ducks GET_COURSE POST', () => {
    const spec = buildGetCourseRequest('course-1');
    expect(spec.method).toBe('POST');
    expect(spec.url).toContain('/ducks/rise/courses/GET_COURSE');
    expect(JSON.parse(spec.body!)).toEqual({
      type: 'rise/courses/GET_COURSE',
      payload: { courseId: 'course-1' },
    });
  });
});
