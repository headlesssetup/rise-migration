// Operation A (account settings) — the C4 tab-pin contract at the entry point.
// Folder creation and the font GET_YURL/CREATE_TYPEFACE calls are authoring
// writes, and the reads that feed them (the live-course probe, the target font
// list) must come from the SAME account, so the whole step runs on one pinned tab.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountIdentity } from '@/core/import';
import type { Storage } from '@/core/storage/storage';
import type { BackgroundRequest, BackgroundResponse } from '@/shared/messaging';
import { rpc } from '../rpc';
import { importAccountSettings } from './import-account';
import type { ProgressEvent } from './shared';

vi.mock('../rpc', () => ({ rpc: vi.fn() }));
const rpcMock = vi.mocked(rpc);

const PIN = { pinnedTabId: 5, expectedPlane: 'eu' as const };
const TARGET: AccountIdentity = { name: 'Target EU', userId: 'u1', plane: 'eu' };
const NO_PACING = { baseMs: 0, jitterMs: 0 };

const SOURCE_FOLDERS = JSON.stringify([
  { id: 'sRoot', name: 'Shared', isRoot: true, folderType: 'shared' },
  { id: 'sf1', name: 'Marketing', parentFolderId: 'sRoot', folderType: 'shared' },
]);
const TARGET_FOLDERS = JSON.stringify([
  { id: 'tRoot', name: 'Shared', isRoot: true, folderType: 'shared' },
]);

const storage = {
  readManifest: async () => null,
  readFolders: async () => SOURCE_FOLDERS,
  // No source typefaces → no font writes; this test is about the pin, not fonts.
  readTypefaces: async () => '[]',
  readFontManifest: async () => null,
  writeImportArtifact: async () => {},
} as unknown as Storage;

const sink = (): { onEvent: (e: ProgressEvent) => void; logs: string[] } => {
  const logs: string[] = [];
  return { logs, onEvent: (e) => void (e.kind === 'log' && logs.push(e.message)) };
};

const sent = (): BackgroundRequest[] => rpcMock.mock.calls.map((c) => c[0]);

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
      case 'SEARCH_COURSES':
        return {
          type: 'SEARCH_RESULT',
          result: { ok: true, status: 200, data: { items: [{ id: 'live1', title: 'x' }] } as never },
        };
      case 'FETCH_TYPEFACES':
        return {
          type: 'RAW_RESULT',
          kind: 'typefaces',
          result: { ok: true, status: 200, data: { raw: '[]', doc: [] } },
        };
      case 'RELAY_WRITE':
        return {
          type: 'WRITE_RESULT',
          result: {
            ok: true,
            status: 200,
            text: req.spec.method === 'GET' ? TARGET_FOLDERS : '{"id":"newF1"}',
          },
        };
      default:
        throw new Error(`unexpected ${req.type}`);
    }
  });
}

describe('importAccountSettings — run tab pin (C4)', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('pins once and carries the pin on every read and write of the step', async () => {
    mockBackground(true);
    const { onEvent } = sink();
    const res = await importAccountSettings(storage, TARGET, { dryRun: false, pacing: NO_PACING }, onEvent);

    expect(res.blocked).toBeUndefined();
    expect(res.summary?.folders.mapped).toBe(1);

    expect(sent()[0]!.type).toBe('PIN_RISE_TAB');
    for (const r of sent().slice(1)) expect(r.pin).toEqual(PIN);
    // the folder create — the authoring write that could land in the source account
    const create = sent().find((r) => r.type === 'RELAY_WRITE' && r.spec.method === 'POST');
    expect(create).toBeDefined();
    expect(create!.pin).toEqual(PIN);
    // the live-course probe feeding FETCH_TYPEFACES is pinned to the same account
    expect(sent().some((r) => r.type === 'SEARCH_COURSES' && !!r.pin)).toBe(true);
  });

  it('BLOCKS a live run (writing nothing) when the tab cannot be pinned', async () => {
    mockBackground(false);
    const { onEvent, logs } = sink();
    const res = await importAccountSettings(storage, TARGET, { dryRun: false, pacing: NO_PACING }, onEvent);

    expect(res.blocked).toMatch(/Could not pin the target Rise tab/);
    expect(res.summary).toBeUndefined();
    expect(sent().filter((r) => r.type === 'RELAY_WRITE')).toEqual([]);
    expect(logs.some((l) => /^BLOCKED:/.test(l))).toBe(true);
  });
});
