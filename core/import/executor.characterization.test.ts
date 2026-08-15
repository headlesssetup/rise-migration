// Characterization harness for the proven import state machine. This freezes
// the exact ordered envelopes for one representative archived image course,
// including write bodies. Any future executor/plan refactor must produce an
// intentional fixture diff before it can be considered behavior-preserving.

import { describe, expect, it } from 'vitest';
import { executePlan, type Relay } from './executor';
import { buildPlan } from './plan';
import { IdMap } from './ids';
import type { WriteSpec } from './envelopes';
import {
  counterMint,
  happyHandlers,
  imageCourse,
  mockRelay,
} from './executor.fixtures';

interface EnvelopeRecord {
  label: string;
  method: WriteSpec['method'];
  url: string;
  body?: string;
  base64Body?: string;
  contentType?: string;
  noAuth?: boolean;
}

function record(spec: WriteSpec): EnvelopeRecord {
  return {
    label: spec.label,
    method: spec.method,
    url: spec.url,
    ...(spec.body ? { body: spec.body } : {}),
    ...(spec.base64Body ? { base64Body: spec.base64Body } : {}),
    ...(spec.contentType ? { contentType: spec.contentType } : {}),
    ...(spec.noAuth ? { noAuth: true } : {}),
  };
}

describe('import executor characterization', () => {
  it('preserves the exact ordered write envelopes for the canonical image course', async () => {
    const input = imageCourse();
    const scripted = mockRelay(happyHandlers);
    const trace: EnvelopeRecord[] = [];
    const relay: Relay = async (spec) => {
      trace.push(record(spec));
      return scripted.relay(spec);
    };

    const result = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });

    expect(result.ok).toBe(true);
    expect(trace).toEqual([
      {
        label: 'POST /manage/api/content (create course)',
        method: 'POST',
        url: '/manage/api/content',
        body: '{"createBookmark":false,"folderId":"all"}',
      },
      {
        label: 'rise/courses/GET_COURSE',
        method: 'POST',
        url: '/api/rise-runtime/ducks/rise/courses/GET_COURSE',
        body: '{"type":"rise/courses/GET_COURSE","payload":{"courseId":"NEWCOURSE"}}',
      },
      {
        label: 'rise/lessons/CREATE_LESSON',
        method: 'POST',
        url: '/api/rise-runtime/ducks/rise/lessons/CREATE_LESSON',
        body: '{"type":"rise/lessons/CREATE_LESSON","payload":{"author":"auth0|target","selectedAuthorId":"auth0|target","courseId":"NEWCOURSE","position":0,"title":"Lesson 1","type":null}}',
      },
      {
        label: 'rise/courses/UPDATE_COURSE_FIELD_THROTTLE',
        method: 'POST',
        url: '/api/rise-runtime/ducks/rise/courses/UPDATE_COURSE_FIELD_THROTTLE',
        body: '{"type":"rise/courses/UPDATE_COURSE_FIELD_THROTTLE","payload":{"course":{"id":"NEWCOURSE","title":"My Course"}}}',
      },
      {
        label: 'rise/lessons/UPDATE_LESSON',
        method: 'POST',
        url: '/api/rise-runtime/ducks/rise/lessons/UPDATE_LESSON',
        body: '{"type":"rise/lessons/UPDATE_LESSON","payload":{"id":"NEWLESSON","courseId":"NEWCOURSE","type":"blocks","icon":"Article","bulkUpdateBlocks":{"deletes":[],"creates":[],"updates":[],"moves":[]}}}',
      },
      {
        label: 'rise/lessons/CREATE_BLOCKS',
        method: 'POST',
        url: '/api/rise-runtime/ducks/rise/lessons/CREATE_BLOCKS',
        body: '{"type":"rise/lessons/CREATE_BLOCKS","payload":{"courseId":"NEWCOURSE","lessonId":"NEWLESSON","previousBlockId":null,"blocks":[{"id":"cnew00000000000000000000","family":"image","variant":"hero","type":"image","items":[{"id":"cnew00000000000000000001","media":{"image":{"key":"","type":"image"}}}]}]}}',
      },
      {
        label: 'rise/uploads/GET_YURL',
        method: 'POST',
        url: '/api/rise-runtime/ducks/rise/uploads/GET_YURL',
        body: '{"type":"rise/uploads/GET_YURL","payload":{"assetPath":"courses/NEWCOURSE","courseId":"NEWCOURSE","filename":"a.jpg"}}',
      },
      {
        label: 'S3 PUT (upload bytes)',
        method: 'PUT',
        url: 'https://s3/put',
        base64Body: 'AAAA',
        contentType: 'image/jpeg',
        noAuth: true,
      },
      {
        label: 'rise/lessons/UPDATE_BLOCK_DEBOUNCE',
        method: 'POST',
        url: '/api/rise-runtime/ducks/rise/lessons/UPDATE_BLOCK_DEBOUNCE',
        body: '{"type":"rise/lessons/UPDATE_BLOCK_DEBOUNCE","payload":{"id":"cnew00000000000000000000","courseId":"NEWCOURSE","lessonId":"NEWLESSON","item":{"id":"cnew00000000000000000000","family":"image","variant":"hero","type":"image","items":[{"id":"cnew00000000000000000001","media":{"image":{"key":"rise/courses/NEWCOURSE/server.jpg","type":"image"}}}]}}}',
      },
      {
        label: 'rise/courses/UPDATE_COURSE',
        method: 'POST',
        url: '/api/rise-runtime/ducks/rise/courses/UPDATE_COURSE',
        body: '{"type":"rise/courses/UPDATE_COURSE","payload":{"id":"NEWCOURSE","theme":{"themeId":"classic"}}}',
      },
    ]);
  });
});
