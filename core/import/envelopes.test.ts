import { describe, it, expect } from 'vitest';
import {
  updateCourseTitle,
  updateCourseFieldThrottle,
  getYurl,
  s3Put,
  createLesson,
} from './envelopes';

describe('write envelopes', () => {
  it('title uses the confirmed UPDATE_COURSE_FIELD_THROTTLE with {course:{id,title}}', () => {
    const spec = updateCourseTitle('C1', 'Hello');
    expect(spec.url).toBe('/api/rise-runtime/ducks/rise/courses/UPDATE_COURSE_FIELD_THROTTLE');
    const body = JSON.parse(spec.body!);
    expect(body.type).toBe('rise/courses/UPDATE_COURSE_FIELD_THROTTLE');
    expect(body.payload).toEqual({ course: { id: 'C1', title: 'Hello' } });
  });

  it('generic field throttle nests any scalar under course', () => {
    const body = JSON.parse(updateCourseFieldThrottle('C1', 'description', '<p>x</p>').body!);
    expect(body.payload).toEqual({ course: { id: 'C1', description: '<p>x</p>' } });
  });

  it('GET_YURL assetPath is courses/<id> (server dictates key + upload host)', () => {
    const body = JSON.parse(getYurl({ courseId: 'C1', filename: 'a.jpg' }).body!);
    expect(body.payload.assetPath).toBe('courses/C1');
    expect(body.payload.filename).toBe('a.jpg');
  });

  it('S3 PUT is no-auth, binary, with the returned content-type (matches the EU/US browser PUT)', () => {
    const spec = s3Put({ url: 'https://bucket.s3/x', base64Body: 'AAAA', contentType: 'image/jpeg' });
    expect(spec.method).toBe('PUT');
    expect(spec.noAuth).toBe(true);
    expect(spec.contentType).toBe('image/jpeg');
    expect(spec.base64Body).toBe('AAAA');
    // no x-amz-acl header — the captured successful EU PUT sent only Content-Type
  });

  it('CREATE_LESSON carries author + selectedAuthorId', () => {
    const body = JSON.parse(createLesson({ author: 'auth0|x', courseId: 'C1', position: 0, title: 'L' }).body!);
    expect(body.payload.author).toBe('auth0|x');
    expect(body.payload.selectedAuthorId).toBe('auth0|x');
    expect(body.payload.courseId).toBe('C1');
  });
});
