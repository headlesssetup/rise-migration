// Operation B (question banks) — the C4 tab-pin contract at the entry point.
// The bank POST/PUT are authoring writes: unpinned, the background re-resolves
// "the active Rise tab" per message, so focusing the SOURCE tab mid-run created
// the banks in the source account.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Storage } from '@/core/storage/storage';
import type { AccountIdentity } from '@/core/import';
import type { BackgroundRequest, BackgroundResponse } from '@/shared/messaging';
import { rpc } from '../rpc';
import { importBanks } from './import-banks';
import type { ProgressEvent } from './shared';

vi.mock('../rpc', () => ({ rpc: vi.fn() }));
const rpcMock = vi.mocked(rpc);

const PIN = { pinnedTabId: 11, expectedPlane: 'eu' as const };
const TARGET: AccountIdentity = { name: 'Target EU', userId: 'u1', plane: 'eu' };
const NO_PACING = { baseMs: 0, jitterMs: 0 };

const BANK = JSON.stringify({
  id: 'b1',
  title: 'Anatomy',
  questions: [{ id: 'q1', type: 'multipleChoice' }],
});

const storage = {
  readManifest: async () => null,
  readQuestionBank: async () => BANK,
  readImportArtifact: async () => null,
  writeImportArtifact: async () => {},
} as unknown as Storage;

const sink = (): { onEvent: (e: ProgressEvent) => void; logs: string[] } => {
  const logs: string[] = [];
  return { logs, onEvent: (e) => void (e.kind === 'log' && logs.push(e.message)) };
};

const sent = (): BackgroundRequest[] => rpcMock.mock.calls.map((c) => c[0]);
const writes = (): BackgroundRequest[] => sent().filter((r) => r.type === 'RELAY_WRITE');

/** Background stub: pins successfully (or not) and accepts every write. */
function mockBackground(pinOk: boolean): void {
  rpcMock.mockImplementation(async (req: BackgroundRequest): Promise<BackgroundResponse> => {
    switch (req.type) {
      case 'PIN_RISE_TAB':
        return pinOk
          ? {
              type: 'RISE_TAB_PIN',
              result: {
                ok: true,
                status: 200,
                data: { ...PIN, url: 'https://rise.eu.articulate.com/authoring/x' },
              },
            }
          : { type: 'RISE_TAB_PIN', result: { ok: false, error: 'No open Rise tab' } };
      case 'REAUTH':
        return { type: 'REAUTH_RESULT', advanced: true, valid: true, identity: null };
      case 'RELAY_WRITE': {
        // The read-back is the LIST route (F4: the US plane has no per-id GET) —
        // it must return the bank we wrote, questions inline, canonicalizable.
        const spec = (req as { spec?: { method?: string; url?: string } }).spec;
        if (spec?.method === 'GET' && spec.url?.endsWith('/question_banks')) {
          return {
            type: 'WRITE_RESULT',
            result: {
              ok: true,
              status: 200,
              text: JSON.stringify({
                question_banks: [
                  { id: 'other', title: 'Unrelated', questions: [] },
                  { id: 'nb1', title: 'Anatomy', questions: [{ id: 'qX1', type: 'multipleChoice' }] },
                ],
              }),
            },
          };
        }
        if (spec?.method === 'GET' && spec.url?.includes('/question_banks/')) {
          // The per-id route must never be used for the read-back (404 on US).
          return { type: 'WRITE_RESULT', result: { ok: false, status: 404, text: '{"error":"Not Found"}' } };
        }
        return { type: 'WRITE_RESULT', result: { ok: true, status: 200, text: '{"id":"nb1"}' } };
      }
      default:
        throw new Error(`unexpected ${req.type}`);
    }
  });
}

describe('importBanks — run tab pin (C4)', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('pins the run once and carries that pin on the bank create + question write', async () => {
    mockBackground(true);
    const { onEvent } = sink();
    const res = await importBanks(storage, TARGET, ['b1'], { dryRun: false, pacing: NO_PACING }, onEvent);

    expect(res.blocked).toBeUndefined();
    expect(res.outcomes[0]).toMatchObject({ sourceBankId: 'b1', newBankId: 'nb1', ok: true });

    // resolved ONCE, up front, before anything else touches the network
    expect(sent()[0]!.type).toBe('PIN_RISE_TAB');
    expect(sent().filter((r) => r.type === 'PIN_RISE_TAB')).toHaveLength(1);
    // and every later message of the run names that tab
    for (const r of sent().slice(1)) expect(r.pin).toEqual(PIN);
    expect(writes()).toHaveLength(3); // POST bank + PUT questions + read-back LIST
    // F4: the read-back must be the LIST route, never the US-broken per-id GET
    const rbSpec = (writes()[2] as { spec?: { method?: string; url?: string } }).spec;
    expect(rbSpec?.method).toBe('GET');
    expect(rbSpec?.url).toMatch(/\/question_banks$/);
  });

  it('F4: an honest message when the PUT succeeded but the read-back list lacks the bank', async () => {
    mockBackground(true);
    // Same background, but the LIST omits our bank.
    const impl = rpcMock.getMockImplementation()!;
    rpcMock.mockImplementation(async (req: BackgroundRequest): Promise<BackgroundResponse> => {
      const spec = (req as { spec?: { method?: string; url?: string } }).spec;
      if (req.type === 'RELAY_WRITE' && spec?.method === 'GET' && spec.url?.endsWith('/question_banks')) {
        return {
          type: 'WRITE_RESULT',
          result: { ok: true, status: 200, text: JSON.stringify({ question_banks: [] }) },
        };
      }
      return impl(req);
    });
    const { onEvent, logs } = sink();
    const res = await importBanks(storage, TARGET, ['b1'], { dryRun: false, pacing: NO_PACING }, onEvent);
    expect(res.outcomes[0]).toMatchObject({ ok: false, orphanedBankId: 'nb1' });
    // Never mislabel a PUT-accepted bank as "empty" — say the questions landed.
    const failLine = logs.find((l) => l.includes('FAILED'));
    expect(failLine).toMatch(/questions WERE accepted/i);
    expect(failLine).not.toMatch(/empty bank/i);
  });

  it('BLOCKS a live run (writing nothing) when the tab cannot be pinned', async () => {
    mockBackground(false);
    const { onEvent, logs } = sink();
    const res = await importBanks(storage, TARGET, ['b1'], { dryRun: false, pacing: NO_PACING }, onEvent);

    expect(res.blocked).toMatch(/Could not pin the target Rise tab/);
    expect(res.outcomes).toEqual([]);
    expect(writes()).toEqual([]);
    expect(logs.some((l) => /^BLOCKED:/.test(l))).toBe(true);
  });

  it('lets a DRY run continue unpinned (it writes nothing) with a warning', async () => {
    mockBackground(false);
    const { onEvent, logs } = sink();
    const res = await importBanks(storage, TARGET, ['b1'], { dryRun: true, pacing: NO_PACING }, onEvent);

    expect(res.blocked).toBeUndefined();
    expect(res.outcomes[0]).toMatchObject({ ok: true, newBankId: 'dry-bank-b1' });
    expect(writes()).toEqual([]);
    expect(logs.some((l) => /WARN Could not pin/.test(l))).toBe(true);
  });
});
