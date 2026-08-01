import { describe, it, expect } from 'vitest';
import {
  updateCourseTitle,
  updateCourseFieldThrottle,
  getYurl,
  s3Put,
  createLesson,
  copyReviewItem,
  buildStorylineMedia,
  updateBlockDebounce,
  s3PutReview,
} from './envelopes';
import * as env from './envelopes';

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

  it('copy_review_item is a direct rise-runtime POST with {id,reviewPrefix,jobId=blockId}', () => {
    const spec = copyReviewItem({ courseId: 'C1', reviewPrefix: 'review/items/LEAF', blockId: 'blk_9' });
    expect(spec.url).toBe('/api/rise-runtime/copy_review_item');
    expect(spec.method).toBe('POST');
    expect(JSON.parse(spec.body!)).toEqual({
      id: 'C1',
      reviewPrefix: 'review/items/LEAF',
      jobId: 'blk_9',
    });
  });

  it('buildStorylineMedia derives src from contentPrefix and marks processing:false', () => {
    const media = buildStorylineMedia({
      contentPrefix: 'rise/courses/C1/LEAF',
      meta: { title: 'Geo 101', version: '1' },
      title: 'Geo 101',
    });
    expect(media).toEqual({
      storyline: {
        contentPrefix: 'rise/courses/C1/LEAF',
        src: 'rise/courses/C1/LEAF/story.html',
        meta: { title: 'Geo 101', version: '1' },
        processing: false,
        title: 'Geo 101',
        type: 'storyline',
      },
    });
  });

  it('Review-360 S3 PUT carries Content-MD5, is no-auth, application/zip', () => {
    const spec = s3PutReview({ url: 'https://s3/x.zip?sig', base64Body: 'QUJD', contentMd5Base64: 'bWQ1' });
    expect(spec.method).toBe('PUT');
    expect(spec.noAuth).toBe(true);
    expect(spec.contentType).toBe('application/zip');
    expect(spec.headers).toEqual({ 'Content-MD5': 'bWQ1' });
    expect(spec.base64Body).toBe('QUJD');
  });

  it('storyline media drops into UPDATE_BLOCK_DEBOUNCE as the block item media', () => {
    const media = buildStorylineMedia({ contentPrefix: 'rise/courses/C1/LEAF', meta: {} });
    const spec = updateBlockDebounce({
      id: 'blk_9',
      courseId: 'C1',
      lessonId: 'les_1',
      item: { id: 'item_1', media },
    });
    expect(spec.url).toBe('/api/rise-runtime/ducks/rise/lessons/UPDATE_BLOCK_DEBOUNCE');
    const body = JSON.parse(spec.body!);
    expect(body.payload.item.media.storyline.src).toBe('rise/courses/C1/LEAF/story.html');
    expect(body.payload.id).toBe('blk_9');
  });
});

describe('multi-language stack envelopes (docs/rise-multilang.md)', () => {
  it('createTranslations POSTs sourceLanguage/targetLanguages/formality', () => {
    const spec = env.createTranslations('C1', {
      sourceLanguage: 'en-us',
      targetLanguages: ['ar', 'ru'],
      formality: 'more',
    });
    expect(spec.method).toBe('POST');
    expect(spec.url).toBe('/manage/api/content/C1/translations');
    expect(JSON.parse(spec.body!)).toEqual({
      sourceLanguage: 'en-us',
      targetLanguages: ['ar', 'ru'],
      formality: 'more',
    });
    // null formality is omitted (capture: the field is absent, not null)
    const noF = env.createTranslations('C1', {
      sourceLanguage: 'en-us',
      targetLanguages: ['de'],
      formality: null,
    });
    expect(JSON.parse(noF.body!)).toEqual({ sourceLanguage: 'en-us', targetLanguages: ['de'] });
  });

  it('getTranslations / getSubscription / getAvailableLanguages are GETs', () => {
    expect(env.getTranslations('C1')).toMatchObject({
      method: 'GET',
      url: '/manage/api/content/C1/translations',
    });
    expect(env.getSubscription()).toMatchObject({ method: 'GET', url: '/manage/api/subscription' });
    expect(env.getAvailableLanguages('SUB1').url).toBe(
      '/manage/api/subscription/SUB1/available-languages',
    );
  });

  it('updateL10nBatch wraps changes in the ducks envelope', () => {
    const spec = env.updateL10nBatch('C1', [
      { action: 'add', l10nId: 'x', lessonId: 'L', locale: 'ru', value: 'v', valueType: 'plain' },
      { action: 'delete', l10nId: 'y' },
    ]);
    expect(spec.url).toBe('/api/rise-runtime/ducks/rise/l10n/UPDATE_L10N_BATCH');
    const body = JSON.parse(spec.body!);
    expect(body.type).toBe('rise/l10n/UPDATE_L10N_BATCH');
    expect(body.payload.courseId).toBe('C1');
    expect(body.payload.changes).toHaveLength(2);
  });

  it('updateLocale / createLabelSet / updateLabels match the captured shapes', () => {
    expect(JSON.parse(env.updateLocale({ courseId: 'C1', locale: 'sq', labelSetId: 'S1' }).body!))
      .toEqual({
        type: 'rise/l10n/UPDATE_LOCALE',
        payload: { courseId: 'C1', locale: 'sq', labelSetId: 'S1' },
      });
    expect(JSON.parse(env.createLabelSet({ iso639Code: 'sq', name: 'Copy of Albanian' }).body!).payload)
      .toEqual({ iso639Code: 'sq', name: 'Copy of Albanian' });
    expect(JSON.parse(env.updateLabels({ id: 'S1', labels: { courseStart: 'FILLONI' } }).body!).payload)
      .toEqual({ id: 'S1', labels: { courseStart: 'FILLONI' } });
  });

  it('createLesson/createBlocks carry translationChanges + ref titles when given', () => {
    const cl = env.createLesson({
      author: 'a',
      courseId: 'C1',
      position: 2,
      title: { l10nId: 'ref-1' },
      translationChanges: [{ action: 'add', l10nId: 'ref-1', locale: 'en-us', value: 'T', valueType: 'plain' }],
    });
    const clBody = JSON.parse(cl.body!);
    expect(clBody.payload.title).toEqual({ l10nId: 'ref-1' });
    expect(clBody.payload.translationChanges).toHaveLength(1);
    // absent when not provided (monolingual envelope unchanged)
    const plain = env.createLesson({ author: 'a', courseId: 'C1', position: 0, title: 'T' });
    expect(JSON.parse(plain.body!).payload).not.toHaveProperty('translationChanges');
    const cb = env.createBlocks({
      courseId: 'C1',
      lessonId: 'L1',
      previousBlockId: null,
      blocks: [{ id: 'b1' }],
      translationChanges: [],
    });
    expect(JSON.parse(cb.body!).payload).not.toHaveProperty('translationChanges');
  });
});
