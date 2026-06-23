// Shared fixtures for the executePlan test suites (split out of the old monolithic
// executor.test.ts). NOT a `.test.ts` file, so vitest does not collect it — it just
// supplies the deterministic id minter, the scripted relay, and a canonical
// image-course input + happy-path handler map used across the split test files.
import type { Relay, RelayResponse } from './executor';
import type { PlanInput } from './plan';

// A deterministic id minter for stable assertions.
export function counterMint(): () => string {
  let n = 0;
  return () => `cnew${String(n++).padStart(20, '0')}`;
}

// A scripted relay: maps a ducks action / path to a canned JSON response.
export function mockRelay(handlers: Record<string, (body: unknown) => unknown>): {
  relay: Relay;
  calls: { url: string; method: string }[];
} {
  const calls: { url: string; method: string }[] = [];
  const relay: Relay = async (spec) => {
    calls.push({ url: spec.url, method: spec.method });
    // key by the ducks action suffix or the REST path
    const key = spec.label;
    const body = spec.body ? JSON.parse(spec.body) : undefined;
    for (const [match, fn] of Object.entries(handlers)) {
      if (key.includes(match) || spec.url.includes(match)) {
        const data = fn(body);
        return { ok: true, status: 200, text: JSON.stringify(data) } as RelayResponse;
      }
    }
    return { ok: true, status: 200, text: '{}' } as RelayResponse;
  };
  return { relay, calls };
}

export function imageCourse(): PlanInput {
  return {
    author: 'auth0|target',
    targetFolderId: 'all',
    assets: [
      { key: 'rise/courses/SRC/a.jpg', kind: 'media-image', file: 'assets/h.jpg', ext: 'jpg' },
    ],
    banksById: new Map(),
    course: {
      course: { id: 'SRC', title: 'My Course', theme: { themeId: 'classic' } },
      lessons: [
        {
          id: 'L1',
          position: 0,
          type: 'blocks',
          title: 'Lesson 1',
          icon: 'Article',
          items: [
            {
              id: 'cblock00000000000000000000',
              family: 'image',
              variant: 'hero',
              type: 'image',
              items: [
                {
                  id: 'citem000000000000000000000',
                  media: { image: { key: 'rise/courses/SRC/a.jpg', type: 'image' } },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

export const happyHandlers = {
  '/manage/api/content': () => ({ id: 'NEWCOURSE' }),
  // Post-create materialization handshake — return a real course.
  'GET_COURSE': () => ({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }),
  'CREATE_LESSON': () => ({ payload: { lesson: { id: 'NEWLESSON', createdAt: 't' } } }),
  'CREATE_BLOCKS': (body: unknown) => {
    const blocks = ((body as { payload: { blocks: { id: string }[] } }).payload).blocks;
    return { payload: { success: true, blockMetadata: [{ id: blocks[0]!.id, globalBlockId: 'g1' }] } };
  },
  'GET_YURL': () => ({
    payload: { key: 'rise/courses/NEWCOURSE/server.jpg', url: 'https://s3/put', type: 'image/jpeg' },
  }),
  'UPDATE_COURSE': () => ({ payload: {} }),
  'UPDATE_BLOCK_DEBOUNCE': () => ({ payload: { success: true } }),
};
