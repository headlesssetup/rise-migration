// Course import (step C) — the C4 tab-pin contract for a whole run.
//
// This is the finding this file guards: relayed URLs are relative, so they
// resolve against whichever tab executes them. With a source-plane AND a
// target-plane Rise tab open, an unpinned run let window focus decide which
// account received the authoring writes. A run therefore pins ONE tab up front
// and every message it issues — writes AND the read-back — must name that tab.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountIdentity } from '@/core/import';
import type { Storage } from '@/core/storage/storage';
import type { BackgroundRequest, BackgroundResponse } from '@/shared/messaging';
import { rpc } from '../rpc';
import { runImport } from './import';
import type { ProgressEvent } from './shared';

vi.mock('../rpc', () => ({ rpc: vi.fn() }));
const rpcMock = vi.mocked(rpc);

const PIN = { pinnedTabId: 3, expectedPlane: 'eu' as const };
const TARGET: AccountIdentity = { name: 'Target EU', userId: 'u1', plane: 'eu' };
const NO_PACING = { baseMs: 0, jitterMs: 0 };

// A minimal lesson-less course: enough for a real plan (create → theme → title)
// without dragging block/asset machinery into a pinning test.
const COURSE = JSON.stringify({ payload: { course: { id: 'C1', title: 'Geo 101' }, lessons: [] } });

const storage = {
  readManifest: async () => null,
  listSaved: async () => ['C1'],
  readCourse: async () => COURSE,
  readAsset: async () => null,
  readFolders: async () => null,
  readTypefaces: async () => null,
  readFontManifest: async () => null,
  readInventory: async () => null,
  readAssetManifest: async () => null,
  readStorylineManifest: async () => null,
  readImportArtifact: async () => null,
  writeImportArtifact: async () => {},
} as unknown as Storage;

const sink = (): { onEvent: (e: ProgressEvent) => void; logs: string[] } => {
  const logs: string[] = [];
  return { logs, onEvent: (e) => void (e.kind === 'log' && logs.push(e.message)) };
};

const sent = (): BackgroundRequest[] => rpcMock.mock.calls.map((c) => c[0]);

function mockBackground(pinOk: boolean, readBackOk = true): void {
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
        return { type: 'SEARCH_RESULT', result: { ok: true, status: 200, data: {} as never } };
      case 'GET_COURSE':
        // Faithful read-back (title included): structural parity divergences
        // now downgrade a course to `partial`, so an unfaithful mock would
        // fail the status assertion — correctly.
        if (!readBackOk) {
          return {
            type: 'COURSE_RESULT',
            result: { ok: false, status: 503, error: 'read-back unavailable' },
          };
        }
        return {
          type: 'COURSE_RESULT',
          result: {
            ok: true,
            status: 200,
            data: { raw: '{"course":{"id":"newC1","title":"Geo 101"},"lessons":[]}' },
          },
        };
      case 'RELAY_WRITE':
        // Serves both the create (`id`) and its GET_COURSE handshake (`course`).
        return {
          type: 'WRITE_RESULT',
          result: { ok: true, status: 200, text: '{"id":"newC1","course":{"id":"newC1"}}' },
        };
      default:
        throw new Error(`unexpected ${req.type}`);
    }
  });
}

describe('runImport — run tab pin (C4)', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('pins once and every write + the parity read-back names that tab', async () => {
    mockBackground(true);
    const { onEvent } = sink();
    const res = await runImport(storage, ['C1'], TARGET, { dryRun: false, pacing: NO_PACING }, onEvent);

    expect(res.blocked).toBeUndefined();
    expect(res.outcomes[0]).toMatchObject({ courseId: 'C1', status: 'imported' });

    // resolved ONCE, first, before any network work
    expect(sent()[0]!.type).toBe('PIN_RISE_TAB');
    expect(sent().filter((r) => r.type === 'PIN_RISE_TAB')).toHaveLength(1);
    for (const r of sent().slice(1)) expect(r.pin).toEqual(PIN);

    const relayed = sent().filter((r) => r.type === 'RELAY_WRITE');
    expect(relayed.length).toBeGreaterThan(0);
    // the read-back must GET the new course from the tab it was written to
    expect(sent().some((r) => r.type === 'GET_COURSE' && !!r.pin)).toBe(true);
  });

  it('BLOCKS a live run before any write when the tab cannot be pinned', async () => {
    mockBackground(false);
    const { onEvent, logs } = sink();
    const res = await runImport(storage, ['C1'], TARGET, { dryRun: false, pacing: NO_PACING }, onEvent);

    expect(res.blocked).toMatch(/Could not pin the target Rise tab/);
    expect(res.outcomes).toEqual([]);
    expect(sent().filter((r) => r.type === 'RELAY_WRITE')).toEqual([]);
    expect(logs.some((l) => /^BLOCKED:/.test(l))).toBe(true);
  });

  it('marks a completed write partial when GET_COURSE parity cannot be confirmed', async () => {
    mockBackground(true, false);
    const { onEvent, logs } = sink();
    const res = await runImport(
      storage,
      ['C1'],
      TARGET,
      { dryRun: false, pacing: NO_PACING },
      onEvent,
    );

    expect(res.outcomes[0]).toMatchObject({
      courseId: 'C1',
      status: 'partial',
      report: {
        ok: false,
        error: expect.stringContaining('Parity read-back UNAVAILABLE'),
      },
    });
    expect(logs.some((l) => l.includes('could not GET_COURSE newC1'))).toBe(true);
  });

  it('does not trust a completed report from the older permissive parity policy', async () => {
    mockBackground(true);
    const oldReportStorage = {
      ...storage,
      readImportArtifact: async (name: string) =>
        name === 'C1.report.json'
          ? JSON.stringify({
              ok: true,
              dryRun: false,
              stopped: false,
              sourceCourseId: 'C1',
              newCourseId: 'newC1',
              idMap: { C1: 'newC1' },
              // No readBackPolicyVersion: this is an old report.
            })
          : null,
    } as unknown as Storage;
    const { onEvent, logs } = sink();
    const res = await runImport(
      oldReportStorage,
      ['C1'],
      TARGET,
      { dryRun: false, pacing: NO_PACING },
      onEvent,
    );

    expect(res.outcomes[0]).toMatchObject({ courseId: 'C1', status: 'imported' });
    expect(logs.some((l) => l.includes('predates read-back policy v2'))).toBe(true);
    expect(sent().some((r) => r.type === 'RELAY_WRITE')).toBe(true);
    expect(sent().some((r) => r.type === 'GET_COURSE')).toBe(true);
  });
});
