import { describe, it, expect } from 'vitest';
import { buildPlan, type PlanInput } from './plan';
import { executePlan, type Relay } from './executor';
import { IdMap } from './ids';
import { counterMint, imageCourse } from './executor.fixtures';

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
      if (spec.label.includes('GET_COURSE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }) };
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

  it('binds to a bank imported in step B (boundBanks) without creating it', async () => {
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [],
      banksById: new Map(),
      // Bank already imported separately (step B): id + question pool persisted.
      boundBanks: new Map([['bank1', { newBankId: 'PREBANK', questionIds: ['nq1', 'nq2'] }]]),
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
    let bindBody: any = null;
    const relay: Relay = async (spec) => {
      seen.push(spec.label);
      if (spec.label.includes('/manage/api/content')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      if (spec.label.includes('GET_COURSE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }) };
      if (spec.label.includes('CREATE_LESSON')) return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON' } } }) };
      if (spec.label.includes('CREATE_BLOCKS')) {
        const id = JSON.parse(spec.body!).payload.blocks[0].id;
        return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: [{ id, globalBlockId: 'g' }] } }) };
      }
      if (spec.label.includes('INSERT_QUESTION_BANK_QUESTIONS')) {
        bindBody = JSON.parse(spec.body!).payload;
        return { ok: true, status: 200, text: '{}' };
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
    // No bank create/put — the bank already exists from step B.
    expect(seen.some((s) => s.includes('/manage/api/question-banks'))).toBe(false);
    expect(seen.some((s) => s.includes('question_banks/'))).toBe(false);
    // Bound to the pre-imported bank id + its persisted question pool.
    expect(bindBody.questionBankId).toBe('PREBANK');
    expect(bindBody.questionList).toEqual(['nq1', 'nq2']);
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
      if (spec.label.includes('GET_COURSE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }) };
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

  it('flags an orphan-bank when the question PUT fails — and never auto-deletes', async () => {
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
    const urls: string[] = [];
    const relay: Relay = async (spec) => {
      urls.push(spec.url);
      // Bank shell creates fine, but the question PUT fails (e.g. stale token).
      if (spec.url.includes('/manage/api/question-banks')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWBANK' }) };
      if (spec.label.includes('question_banks/')) return { ok: false, status: 401, text: 'Unauthorized' };
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => null,
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(false);
    expect(res.flags.some((f) => f.kind === 'orphan-bank')).toBe(true);
    // The empty bank is left in place — nothing is auto-deleted.
    expect(urls.some((u) => u.includes('/content/soft-delete'))).toBe(false);
    expect(urls.some((u) => u.includes('question-banks') && u.includes('DELETE'))).toBe(false);
  });
});
