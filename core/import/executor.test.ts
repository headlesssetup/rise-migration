import { describe, it, expect } from 'vitest';
import { buildPlan, type PlanInput } from './plan';
import { executePlan, type Relay, type RelayResponse } from './executor';
import { IdMap } from './ids';
import { parseTypefaces } from './typefaces';

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

describe('executePlan — multi-key block (key + crushedKey)', () => {
  it('uploads + remaps BOTH keys so no source key survives', async () => {
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [
        { key: 'rise/courses/SRC/orig.jpg', kind: 'media-image', file: 'assets/a.jpg', ext: 'jpg' },
        { key: 'rise/courses/SRC/crush.jpg', kind: 'media-image', file: 'assets/b.jpg', ext: 'jpg' },
      ],
      banksById: new Map(),
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
                id: 'cblock00000000000000000000',
                family: 'image',
                variant: 'hero',
                items: [
                  {
                    id: 'citem000000000000000000000',
                    media: {
                      image: {
                        key: 'rise/courses/SRC/orig.jpg',
                        crushedKey: 'rise/courses/SRC/crush.jpg',
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const steps = buildPlan(input);
    let yurlN = 0;
    const { relay } = mockRelay({
      ...happyHandlers,
      'GET_YURL': () => ({
        payload: { key: `rise/courses/NEWCOURSE/srv${yurlN++}.jpg`, url: 'https://s3/put', type: 'image/jpeg' },
      }),
    });
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    expect(res.survivingKeys).toEqual([]);
    // two uploads happened (orig + crushed)
    expect(res.envelopes.filter((e) => e.label === 'S3 PUT (upload bytes)').length).toBe(2);
  });
});

describe('executePlan — course with a cover image', () => {
  it('flags course-level media (no captured write path) without false-failing', async () => {
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [{ key: 'rise/courses/SRC/cover.jpg', kind: 'media-image', file: 'assets/c.jpg', ext: 'jpg' }],
      banksById: new Map(),
      course: {
        course: {
          id: 'SRC',
          title: 'C',
          coverImage: { key: 'rise/courses/SRC/cover.jpg' },
          theme: { themeId: 't', coverImage: 'rise/courses/SRC/cover.jpg' },
        },
        lessons: [
          {
            id: 'L1',
            position: 0,
            type: 'blocks',
            title: 'L',
            headerImage: { key: 'rise/courses/SRC/hdr.jpg' },
            items: [{ id: 'cb1aaaaaaaaaaaaaaaaaaaaaa', family: 'text', variant: 'p', items: [] }],
          },
        ],
      },
    };
    const steps = buildPlan(input);
    const { relay } = mockRelay(happyHandlers);
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    // The run succeeds: course/lesson/theme media is flagged, not shipped as a key.
    expect(res.ok).toBe(true);
    expect(res.survivingKeys).toEqual([]);
    expect(res.flags.some((f) => f.kind === 'unsupported-media')).toBe(true);
  });
});

describe('executePlan — block ordering (batched create)', () => {
  it('sends ALL of a lesson’s blocks in ONE ordered CREATE_BLOCKS', async () => {
    const families = ['text', 'divider', 'continue', 'list', 'impact'];
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [],
      banksById: new Map(),
      course: {
        course: { id: 'SRC', title: 'C' },
        lessons: [
          {
            id: 'L1',
            position: 0,
            type: 'blocks',
            title: 'L',
            items: families.map((f, i) => ({
              id: `cblk${i}aaaaaaaaaaaaaaaaaaaa`,
              family: f,
              variant: 'v',
              items: [],
            })),
          },
        ],
      },
    };
    const steps = buildPlan(input);
    const createBlocksCalls: unknown[][] = [];
    const relay: Relay = async (spec) => {
      if (spec.label.includes('/manage/api/content')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      if (spec.label.includes('CREATE_LESSON')) return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON' } } }) };
      if (spec.label.includes('CREATE_BLOCKS')) {
        const blocks = JSON.parse(spec.body!).payload.blocks as { id: string }[];
        createBlocksCalls.push(blocks);
        // Return metadata in REVERSED order to prove id-based (not positional) mapping.
        const metas = [...blocks].reverse().map((b) => ({ id: b.id, globalBlockId: 'g' }));
        return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: metas } }) };
      }
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(steps, { input, relay, readAsset: async () => null, ids: new IdMap(counterMint()), mintId: counterMint() });
    expect(res.ok).toBe(true);
    // Exactly ONE CREATE_BLOCKS for the lesson, carrying all 5 blocks in source order.
    expect(createBlocksCalls.length).toBe(1);
    expect(createBlocksCalls[0]!.length).toBe(5);
    // Every source block id is mapped (id-based metadata matching survives reordering).
    for (let i = 0; i < 5; i++) {
      expect(res.idMap[`cblk${i}aaaaaaaaaaaaaaaaaaaa`]).toBeTruthy();
    }
  });
});

describe('executePlan — course cover image', () => {
  it('uploads the cover, CRUSHes it, and sets it via UPDATE_COURSE (no surviving key)', async () => {
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [{ key: 'rise/courses/SRC/cover.jpg', kind: 'media-image', file: 'assets/c.jpg', ext: 'jpg' }],
      banksById: new Map(),
      course: {
        course: {
          id: 'SRC',
          title: 'C',
          coverImage: {
            media: { image: { key: 'rise/courses/SRC/cover.jpg', crushedKey: 'rise/courses/SRC/cc.jpg', sourcedFrom: 'USER' } } },
        },
        lessons: [
          { id: 'L1', position: 0, type: 'blocks', title: 'L', items: [{ id: 'cb1aaaaaaaaaaaaaaaaaaaaaa', family: 'text', variant: 'p', items: [] }] },
        ],
      },
    };
    let coverPayload: any = null;
    const relay: Relay = async (spec) => {
      if (spec.url.includes('/manage/api/content')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      if (spec.label.includes('GET_YURL')) return { ok: true, status: 200, text: JSON.stringify({ payload: { key: 'rise/courses/NEWCOURSE/srv.jpg', url: 'https://s3/c', type: 'image/jpeg' } }) };
      if (spec.label.includes('CRUSH_IMAGE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { key: 'rise/courses/NEWCOURSE/srv-crushed.jpg' } }) };
      if (spec.label.endsWith('/UPDATE_COURSE')) { const p = JSON.parse(spec.body!).payload; if (p.coverImage) coverPayload = p; return { ok: true, status: 200, text: '{}' }; }
      if (spec.label.includes('CREATE_LESSON')) return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON' } } }) };
      if (spec.label.includes('CREATE_BLOCKS')) { const id = JSON.parse(spec.body!).payload.blocks[0].id; return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: [{ id, globalBlockId: 'g' }] } }) }; }
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    expect(res.survivingKeys).toEqual([]);
    expect(coverPayload).toBeTruthy();
    // the new cover key was written (source key remapped to the uploaded one)
    expect(coverPayload.coverImage.media.image.key).toBe('rise/courses/NEWCOURSE/srv.jpg');
    expect(coverPayload.coverImage.media.image.crushedKey).toBe('rise/courses/NEWCOURSE/srv-crushed.jpg');
    // and it's not left flagged
    expect(res.flags.some((f) => f.sourceKey === 'rise/courses/SRC/cover.jpg')).toBe(false);
  });
});

describe('executePlan — typography migration', () => {
  it('recreates a missing custom font and sets the new typeface id on the course', async () => {
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [],
      banksById: new Map(),
      course: {
        course: {
          id: 'SRC',
          title: 'C',
          bodyTypefaceId: 'src-brand',
          theme: { themeId: 'organic', bodyTypefaceId: 'src-brand' },
        },
        lessons: [
          { id: 'L1', position: 0, type: 'blocks', title: 'L', items: [{ id: 'cb1aaaaaaaaaaaaaaaaaaaaaa', family: 'text', variant: 'p', items: [] }] },
        ],
      },
    };
    const sourceTypefaces = parseTypefaces({
      typefaces: [
        { id: 'src-brand', name: 'AcmeBrand', default: false, fonts: [{ key: 'rise/fonts/a.woff', style: 'regular', original: 'Acme.woff' }] },
      ],
    });
    const seen: string[] = [];
    let coverBody: any = null;
    const relay: Relay = async (spec) => {
      seen.push(spec.label);
      if (spec.url.includes('/manage/api/content')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      if (spec.label.includes('FETCH_TYPEFACES'))
        return { ok: true, status: 200, text: JSON.stringify({ payload: { typefaces: [{ id: 'tgt-lato', name: 'Lato', default: true, fonts: [] }] } }) };
      if (spec.label.includes('GET_YURL'))
        return { ok: true, status: 200, text: JSON.stringify({ payload: { key: 'rise/fonts/NEW.woff', url: 'https://s3/f', type: 'font/woff', filename: 'NEW.woff' } }) };
      if (spec.label.includes('CREATE_TYPEFACE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { id: 'NEWTF' } }) };
      // The theme write is the plain UPDATE_COURSE (NOT UPDATE_COURSE_FIELD_THROTTLE).
      if (spec.label.endsWith('/UPDATE_COURSE')) { coverBody = JSON.parse(spec.body!).payload; return { ok: true, status: 200, text: '{}' }; }
      if (spec.label.includes('CREATE_LESSON')) return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON' } } }) };
      if (spec.label.includes('CREATE_BLOCKS')) {
        const id = JSON.parse(spec.body!).payload.blocks[0].id;
        return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: [{ id, globalBlockId: 'g' }] } }) };
      }
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(steps2(input), {
      input,
      relay,
      readAsset: async () => null,
      sourceTypefaces,
      readFontBytes: async () => ({ base64: 'AAAA', contentType: 'font/woff' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    // The font was uploaded + registered, and the course got the NEW typeface id.
    expect(res.envelopes.some((e) => e.label === 'S3 PUT (font)')).toBe(true);
    expect(seen.some((s) => s.includes('CREATE_TYPEFACE'))).toBe(true);
    expect(coverBody.bodyTypefaceId).toBe('NEWTF');
    expect(coverBody.theme.bodyTypefaceId).toBe('NEWTF');
  });
});

function steps2(input: PlanInput) {
  return buildPlan(input);
}

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
      recreateBanks: true,
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

  it('creates the bank with folderId:null (NOT the course `all` sentinel)', async () => {
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all', // course folder — must NOT leak into the bank POST
      recreateBanks: true,
      assets: [],
      banksById: new Map([['bank1', { id: 'bank1', title: 'Bank', questions: [] }]]),
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
                items: [{ id: 'ci1aaaaaaaaaaaaaaaaaaaaaa', type: 'DRAW_FROM_QUESTION_BANK', questionBankId: 'bank1' }],
              },
            ],
          },
        ],
      },
    };
    const steps = buildPlan(input);
    let bankBody: any = null;
    const relay: Relay = async (spec) => {
      if (spec.url.includes('/manage/api/question-banks')) {
        bankBody = JSON.parse(spec.body!);
        return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWBANK' }) };
      }
      if (spec.label.includes('question_banks/')) return { ok: true, status: 200, text: JSON.stringify({ version: 1 }) };
      if (spec.label.includes('/manage/api/content')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      if (spec.label.includes('CREATE_LESSON')) return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON' } } }) };
      if (spec.label.includes('CREATE_BLOCKS')) {
        const id = JSON.parse(spec.body!).payload.blocks[0].id;
        return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: [{ id, globalBlockId: 'g' }] } }) };
      }
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(steps, { input, relay, readAsset: async () => null, ids: new IdMap(counterMint()), mintId: counterMint() });
    expect(res.ok).toBe(true);
    expect(bankBody).toEqual({ folderId: null, title: 'Bank' });
  });

  it('surfaces the server response body on a write failure', async () => {
    const input = imageCourse();
    const steps = buildPlan(input);
    const relay: Relay = async (spec) =>
      spec.label.includes('/manage/api/content')
        ? { ok: false, status: 500, text: '{"error":"folder not found"}' }
        : { ok: true, status: 200, text: '{}' };
    const res = await executePlan(steps, { input, relay, readAsset: async () => null, ids: new IdMap(counterMint()), mintId: counterMint() });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('folder not found'); // body snippet surfaced
  });
});
