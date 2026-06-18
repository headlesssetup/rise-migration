import { describe, expect, it } from 'vitest';
import { buildGetCourseRequest, buildSearchRequest } from './index';

describe('buildSearchRequest', () => {
  it('builds the captured search URL with defaults', () => {
    const { url, method } = buildSearchRequest({ page: 1 });
    expect(method).toBe('GET');
    expect(url).toContain('/manage/api/content/search?');
    expect(url).toContain('page=1');
    expect(url).toContain('pageSize=16');
    expect(url).toContain('sort=RECENTLY_UPDATED');
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
