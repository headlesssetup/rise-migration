import { describe, it, expect } from 'vitest';
import { buildPlan, type PlanInput } from './plan';
import { executePlan, type Relay, type RelayResponse } from './executor';
import { IdMap } from './ids';

// A deterministic id minter for stable assertions.
function counterMint(): () => string {
  let n = 0;
  return () => `cnew${String(n++).padStart(20, '0')}`;
}

// A scripted relay: maps a ducks action / path to a canned JSON response.
function mockRelay(handlers: Record<string, (body: unknown) => unknown>): {
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

function imageCourse(): PlanInput {
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

const happyHandlers = {
  '/manage/api/content': () => ({ id: 'NEWCOURSE' }),
  'CREATE_LESSON': () => ({ payload: { lesson: { id: 'NEWLESSON', createdAt: 't' } } }),
  'CREATE_BLOCKS': (body: unknown) => {
    const blocks = ((body as { payload: { blocks: { id: string }[] } }).payload).blocks;
    return { payload: { success: true, blockMetadata: [{ id: blocks[0]!.id, globalBlockId: 'g1' }] } };
  },
  'GET_YURL': () => ({
    payload: { key: 'rise/courses/NEWCOURSE/server.jpg', url: 'https://s3/put', type: 'image/jpeg' },
  }),
  'CRUSH_IMAGE': () => ({ payload: { key: 'rise/courses/NEWCOURSE/crushed.jpg' } }),
  'UPDATE_COURSE': () => ({ payload: {} }),
  'UPDATE_BLOCK_DEBOUNCE': () => ({ payload: { success: true } }),
};

describe('executePlan — image course happy path', () => {
  it('creates course → lesson → block → uploads → patches, no surviving keys', async () => {
    const input = imageCourse();
    const steps = buildPlan(input);
    const { relay, calls } = mockRelay(happyHandlers);
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.newCourseId).toBe('NEWCOURSE');
    expect(res.survivingKeys).toEqual([]);
    // The S3 PUT and CRUSH both fired.
    expect(calls.some((c) => c.url === 'https://s3/put' && c.method === 'PUT')).toBe(true);
    // old→new course mapping recorded in the resumable job log
    expect(res.idMap['SRC']).toBe('NEWCOURSE');
    expect(res.idMap['L1']).toBe('NEWLESSON');
  });
});

describe('executePlan — dry run', () => {
  it('collects every envelope without relaying', async () => {
    const input = imageCourse();
    const steps = buildPlan(input);
    let relayed = 0;
    const relay: Relay = async () => {
      relayed++;
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => null,
      dryRun: true,
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(relayed).toBe(0); // nothing sent
    expect(res.ok).toBe(true);
    expect(res.envelopes.length).toBeGreaterThan(0);
    // dry-run still synthesizes a course id so downstream steps resolve
    expect(res.newCourseId).toBeTruthy();
    expect(res.envelopes.some((e) => e.label.includes('CREATE_BLOCKS'))).toBe(true);
    expect(res.envelopes.some((e) => e.label.includes('S3 PUT'))).toBe(true);
  });
});

describe('executePlan — loud fail', () => {
  it('aborts when CREATE_BLOCKS does not confirm the sent id', async () => {
    const input = imageCourse();
    const steps = buildPlan(input);
    const { relay } = mockRelay({
      ...happyHandlers,
      'CREATE_BLOCKS': () => ({ payload: { success: true, blockMetadata: [{ id: 'WRONG' }] } }),
    });
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/create-block/);
  });

  it('aborts on a non-ok HTTP response', async () => {
    const input = imageCourse();
    const steps = buildPlan(input);
    const relay: Relay = async (spec) =>
      spec.label.includes('CREATE_LESSON')
        ? { ok: false, status: 500, text: 'boom' }
        : { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => null,
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/HTTP 500/);
  });
});

describe('executePlan — draw-from-bank', () => {
  it('creates the bank, writes questions, then binds the block', async () => {
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [],
      banksById: new Map([
        ['bank1', { id: 'bank1', title: 'Bank', questions: [{ id: 'q1aaaaaaaaaaaaaaaaaaaaaaa', answers: [] }] }],
      ]),
      course: {
        course: { id: 'SRC', title: 'C' },
        lessons: [
          {
            id: 'L1',
            position: 0,
            type: 'blocks',
            title: 'L',
            items: [
              {
                id: 'cb1aaaaaaaaaaaaaaaaaaaaaa',
                family: 'knowledgeCheck',
                variant: 'draw from question bank',
                items: [{ id: 'ci1aaaaaaaaaaaaaaaaaaaaaa', type: 'DRAW_FROM_QUESTION_BANK', questionBankId: 'bank1', drawCount: 2 }],
              },
            ],
          },
        ],
      },
    };
    const steps = buildPlan(input);
    const seen: string[] = [];
    const relay: Relay = async (spec) => {
      seen.push(spec.label);
      if (spec.url.includes('/manage/api/question-banks')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWBANK' }) };
      if (spec.label.includes('question_banks/')) return { ok: true, status: 200, text: JSON.stringify({ version: 1, questions: [] }) };
      if (spec.label.includes('/manage/api/content')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      if (spec.label.includes('CREATE_LESSON')) return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON' } } }) };
      if (spec.label.includes('CREATE_BLOCKS')) {
        const id = JSON.parse(spec.body!).payload.blocks[0].id;
        return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: [{ id, globalBlockId: 'g' }] } }) };
      }
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => null,
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    expect(res.idMap['bank1']).toBe('NEWBANK');
    // bank create + put happened before the bind
    const bankPut = seen.findIndex((s) => s.includes('question_banks/'));
    const bind = seen.findIndex((s) => s.includes('INSERT_QUESTION_BANK_QUESTIONS'));
    expect(bankPut).toBeGreaterThanOrEqual(0);
    expect(bind).toBeGreaterThan(bankPut);
  });
});
