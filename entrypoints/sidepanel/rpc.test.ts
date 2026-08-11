import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundResponse } from '@/shared/messaging';
import { RPC_TIMEOUT_MS, rpc, rpcTimeoutFor } from './rpc';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// `sendMessage` has void-returning overloads, so the implementation is cast in.
function stubSendMessage(impl: () => Promise<unknown>): void {
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(impl as never);
}

describe('rpcTimeoutFor', () => {
  it('gives the long socket waits their own deadline', () => {
    // Must clear the background handler's own internal timeouts (240s export
    // build, 180s contentPrefix poll) or the panel abandons a healthy job.
    expect(rpcTimeoutFor('STORYLINE_EXPORT')).toBeGreaterThan(240_000);
    expect(rpcTimeoutFor('STORYLINE_UPLOAD')).toBeGreaterThan(180_000);
  });

  it('defaults paced reads/writes to the standard deadline', () => {
    expect(rpcTimeoutFor('RELAY_WRITE')).toBe(RPC_TIMEOUT_MS);
    expect(rpcTimeoutFor('GET_COURSE')).toBe(RPC_TIMEOUT_MS);
  });

  it('fails the session poll fast so Connecting cannot hang silently', () => {
    expect(rpcTimeoutFor('GET_SESSION_STATE')).toBe(5_000);
  });
});

describe('rpc', () => {
  it('rejects with a clear error when the background never answers', async () => {
    vi.useFakeTimers();
    stubSendMessage(() => new Promise(() => {}));
    const pending = rpc({ type: 'GET_SESSION_STATE' });
    const assertion = expect(pending).rejects.toThrow(
      /did not answer GET_SESSION_STATE within 5s/,
    );
    await vi.advanceTimersByTimeAsync(5_010);
    await assertion;
  });

  it('honors a per-call override', async () => {
    vi.useFakeTimers();
    stubSendMessage(() => new Promise(() => {}));
    const pending = rpc({ type: 'REAUTH' }, { timeoutMs: 5_000 });
    const assertion = expect(pending).rejects.toThrow(/within 5s/);
    await vi.advanceTimersByTimeAsync(5_010);
    await assertion;
  });

  it('passes the response through untouched when the background answers', async () => {
    const answer: BackgroundResponse = {
      type: 'RISE_TAB_PIN',
      result: {
        ok: true,
        status: 200,
        data: { pinnedTabId: 3, expectedPlane: 'eu', url: 'https://rise.eu.articulate.com/' },
      },
    };
    stubSendMessage(async () => answer);
    await expect(rpc({ type: 'PIN_RISE_TAB' })).resolves.toEqual(answer);
  });
});
