import { describe, expect, it, vi } from 'vitest';
import type { Storage } from '@/core/storage/storage';
import type { ProgressEvent } from './shared';

vi.mock('../rpc', () => ({ rpc: vi.fn() }));

import { rpc } from '../rpc';
import { fetchQuestionBanks } from './banks';

function listResponse(doc: unknown) {
  return {
    type: 'BANKS_RESULT',
    result: { ok: true, status: 200, data: { raw: JSON.stringify(doc), doc } },
  } as Awaited<ReturnType<typeof rpc>>;
}

describe('fetchQuestionBanks', () => {
  it('skips a bank already saved on disk instead of rewriting the archive', async () => {
    const doc = {
      question_banks: [
        { id: 'b1', title: 'Already saved', questions: [{ id: 'q1' }] },
        { id: 'b2', title: 'New bank', questions: [{ id: 'q2' }] },
      ],
    };
    vi.mocked(rpc).mockResolvedValue(listResponse(doc));

    const written: string[] = [];
    const storage = {
      writeBankIndex: async () => {},
      hasQuestionBank: async (id: string) => id === 'b1',
      writeQuestionBank: async (id: string) => {
        written.push(id);
      },
    } as unknown as Storage;

    const events: ProgressEvent[] = [];
    const res = await fetchQuestionBanks(storage, (e) => events.push(e));

    expect(res).toEqual({ bankCount: 2, saved: 1, skipped: 1, failed: [] });
    expect(written).toEqual(['b2']); // b1's archived file untouched
    const logs = events
      .filter((e) => e.kind === 'log')
      .map((e) => (e as { message: string }).message);
    expect(logs.some((m) => m.includes('[1/2 banks] Skipped (already saved): Already saved'))).toBe(true);
    expect(logs.some((m) => m.includes('[2/2 banks] Saved bank: New bank'))).toBe(true);
  });
});
