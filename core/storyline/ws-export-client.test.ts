import { describe, expect, it } from 'vitest';
import { awaitExportLocation, wsExportUrlForPlane, type WsLike } from './ws-export-client';

describe('wsExportUrlForPlane', () => {
  it('maps US to the .com host and EU/unknown to the .eu host', () => {
    expect(wsExportUrlForPlane('us')).toBe('wss://ws.articulate.com/');
    expect(wsExportUrlForPlane('eu')).toBe('wss://ws.eu.articulate.com/');
    expect(wsExportUrlForPlane(null)).toBe('wss://ws.eu.articulate.com/');
  });
});

// A fake WebSocket that records sends and lets the test drive events.
class FakeWs implements WsLike {
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Array<(ev?: { data?: unknown }) => void>> = {};
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, cb: (ev?: { data?: unknown }) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  fire(type: string, ev?: { data?: unknown }): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

const SUCCESS = (jobId: string, location: string): { data: string } => ({
  data: JSON.stringify({
    jsonrpc: '2.0',
    method: 'notify',
    params: { type: 'package:success', payload: { jobId, location } },
  }),
});

describe('awaitExportLocation', () => {
  it('identifies on open and resolves with the matching job location', async () => {
    const ws = new FakeWs();
    const p = awaitExportLocation({ token: 'JWT', sessionId: 'S', jobId: '8797', connect: () => ws });

    ws.fire('open');
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ method: 'identify', params: { token: 'JWT' } });

    ws.fire('message', { data: '{"id":0,"result":{"sessionId":"S"}}' }); // ignored, keep waiting
    ws.fire('message', SUCCESS('8797', 'https://cdn/x.zip'));

    await expect(p).resolves.toEqual({ location: 'https://cdn/x.zip', jobId: '8797' });
    expect(ws.closed).toBe(true);
    // a close frame was sent before teardown
    expect(ws.sent.some((s) => s.includes('"method":"close"'))).toBe(true);
  });

  it('fires onIdentified with the bound session id (to trigger build/raw)', async () => {
    const ws = new FakeWs();
    const seen: string[] = [];
    const p = awaitExportLocation({
      token: 'JWT',
      sessionId: 'S',
      jobId: '8797',
      connect: () => ws,
      onIdentified: (sid) => {
        seen.push(sid);
      },
    });
    ws.fire('open');
    ws.fire('message', { data: '{"id":0,"result":{"sessionId":"S"}}' });
    ws.fire('message', SUCCESS('8797', 'https://cdn/x.zip'));
    await expect(p).resolves.toEqual({ location: 'https://cdn/x.zip', jobId: '8797' });
    expect(seen).toEqual(['S']);
  });

  it('ignores a notify for a different job, then resolves on ours', async () => {
    const ws = new FakeWs();
    const p = awaitExportLocation({ token: 'JWT', sessionId: 'S', jobId: '8797', connect: () => ws });
    ws.fire('open');
    ws.fire('message', SUCCESS('9999', 'https://cdn/other.zip'));
    ws.fire('message', SUCCESS('8797', 'https://cdn/ours.zip'));
    await expect(p).resolves.toEqual({ location: 'https://cdn/ours.zip', jobId: '8797' });
  });

  it('rejects on a package error frame', async () => {
    const ws = new FakeWs();
    const p = awaitExportLocation({ token: 'JWT', sessionId: 'S', jobId: '8797', connect: () => ws });
    ws.fire('open');
    ws.fire('message', {
      data: '{"method":"notify","params":{"type":"package:error","payload":{"jobId":"8797","message":"boom"}}}',
    });
    await expect(p).rejects.toThrow(/package error.*boom/);
  });

  it('rejects on socket close before success', async () => {
    const ws = new FakeWs();
    const p = awaitExportLocation({ token: 'JWT', sessionId: 'S', connect: () => ws });
    ws.fire('open');
    ws.fire('close');
    await expect(p).rejects.toThrow(/closed before/);
  });

  it('rejects on timeout', async () => {
    const ws = new FakeWs();
    const p = awaitExportLocation({ token: 'JWT', sessionId: 'S', connect: () => ws, timeoutMs: 5, identifyTimeoutMs: 50 });
    ws.fire('open');
    await expect(p).rejects.toThrow(/timed out/);
  });

  it('fails fast when identify never arrives (stale token)', async () => {
    const ws = new FakeWs();
    const p = awaitExportLocation({
      token: 'JWT',
      connect: () => ws,
      identifyTimeoutMs: 5,
      timeoutMs: 100_000,
    });
    ws.fire('open');
    await expect(p).rejects.toThrow(/identify not received.*stale/);
  });

  it('clears the identify timer once identified (no false stale failure)', async () => {
    const ws = new FakeWs();
    const p = awaitExportLocation({
      token: 'JWT',
      connect: () => ws,
      identifyTimeoutMs: 20,
      timeoutMs: 100_000,
    });
    ws.fire('open');
    ws.fire('message', { data: '{"id":0,"result":{"sessionId":"S"}}' });
    await new Promise((r) => setTimeout(r, 35)); // past identifyTimeout
    ws.fire('message', SUCCESS('8797', 'https://cdn/x.zip'));
    await expect(p).resolves.toMatchObject({ location: 'https://cdn/x.zip' });
  });
});
