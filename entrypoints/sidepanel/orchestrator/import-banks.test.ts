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
        // The bank read-back GET must echo a bank matching what was PUT
        // (canonicalized ids, so the source shape suffices).
        const spec = (req as { spec?: { method?: string; url?: string } }).spec;
        if (spec?.method === 'GET' && spec.url?.includes('/question_banks/')) {
          return {
            type: 'WRITE_RESULT',
            result: {
              ok: true,
              status: 200,
              text: JSON.stringify({
                id: 'nb1',
                title: 'Anatomy',
                questions: [{ id: 'qX1', type: 'multipleChoice' }],
              }),
            },
          };
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
    expect(writes()).toHaveLength(3); // POST bank + PUT questions + read-back GET
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
