import { describe, expect, it, vi, type Mock } from 'vitest';
import { io } from 'socket.io-client';
import {
  assertAckOk,
  awaitContentPrefix,
  connectReviewSocket,
  emitAck,
  parseItemId,
  reviewSocketBaseForPlane,
  uploadStorylinePackage,
  type AckSocket,
} from './review-socket-client';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));

// A fake socket.io socket: routes each emit to a canned ack, recording calls.
class FakeSocket implements AckSocket {
  calls: Array<{ event: string; args: unknown[] }> = [];
  constructor(private responder: (event: string, args: unknown[]) => unknown) {}
  emit(event: string, ...args: unknown[]): void {
    const ack = args[args.length - 1];
    const payloadArgs = typeof ack === 'function' ? args.slice(0, -1) : args;
    this.calls.push({ event, args: payloadArgs });
    if (typeof ack === 'function') {
      // respond asynchronously, like a real round-trip
      queueMicrotask(() => (ack as (r: unknown) => void)(this.responder(event, payloadArgs)));
    }
  }
  disconnect(): void {}
}

const PRESIGNED =
  'https://360-prod-eu-central-1.s3.eu-central-1.amazonaws.com/review/uploads/PFX/blk_9.zip?X-Amz-Signature=z';

describe('reviewSocketBaseForPlane', () => {
  it('maps plane to the review-sockets host (US drops .eu)', () => {
    expect(reviewSocketBaseForPlane('us')).toBe('https://360-review-sockets.articulate.com');
    expect(reviewSocketBaseForPlane('eu')).toBe('https://360-review-sockets.eu.articulate.com');
  });

  it('throws loudly on an unknown plane instead of defaulting to EU', () => {
    expect(() => reviewSocketBaseForPlane(null)).toThrow(/plane unknown/i);
    expect(() => reviewSocketBaseForPlane(undefined)).toThrow(/plane unknown/i);
  });
});

// A fake socket.io-client Socket for connectReviewSocket (on/off/emit/disconnect).
class FakeIoSocket {
  private handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  emitted: Array<{ event: string; args: unknown[] }> = [];
  disconnected = false;
  on(event: string, cb: (...a: unknown[]) => void): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(cb);
    return this;
  }
  off(event: string, cb: (...a: unknown[]) => void): this {
    this.handlers.get(event)?.delete(cb);
    return this;
  }
  emit(event: string, ...args: unknown[]): this {
    this.emitted.push({ event, args });
    return this;
  }
  disconnect(): this {
    this.disconnected = true;
    return this;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const cb of [...(this.handlers.get(event) ?? [])]) cb(...args);
  }
  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

describe('connectReviewSocket', () => {
  const connect = (sock: FakeIoSocket) => {
    (io as unknown as Mock).mockReturnValue(sock);
    return connectReviewSocket({ userId: 'auth0|u1', token: 'JWT', base: 'https://base' });
  };

  it('disables auto-reconnect (one-shot upload semantics) and keeps the raw namespace', () => {
    const sock = new FakeIoSocket();
    void connect(sock);
    const [ns, opts] = (io as unknown as Mock).mock.lastCall as [string, Record<string, unknown>];
    expect(ns).toBe('https://base/user/auth0|u1'); // literal pipe — never percent-encoded
    expect(opts).toMatchObject({ reconnection: false, forceNew: true, auth: { token: 'JWT' } });
    sock.fire('connect'); // settle so no timer leaks into other tests
  });

  it('resolves on connect, emits auth:login, and removes its handshake listeners', async () => {
    const sock = new FakeIoSocket();
    const p = connect(sock);
    sock.fire('connect');
    await expect(p).resolves.toBe(sock);
    expect(sock.emitted).toEqual([{ event: 'auth:login', args: ['JWT'] }]);
    // the resolved socket's connect/connect_error listeners are gone — they can
    // never fire again spuriously
    expect(sock.listenerCount('connect')).toBe(0);
    expect(sock.listenerCount('connect_error')).toBe(0);
    expect(sock.disconnected).toBe(false);
  });

  it('disconnects the socket on connect_error (no lingering manager in the SW)', async () => {
    const sock = new FakeIoSocket();
    const p = connect(sock);
    sock.fire('connect_error', new Error('websocket error'));
    await expect(p).rejects.toThrow(/connect_error: websocket error/);
    expect(sock.disconnected).toBe(true);
    expect(sock.listenerCount('connect')).toBe(0);
    expect(sock.listenerCount('connect_error')).toBe(0);
  });

  it('disconnects the socket on connect timeout', async () => {
    const sock = new FakeIoSocket();
    (io as unknown as Mock).mockReturnValue(sock);
    const p = connectReviewSocket({ userId: 'u', token: 'T', base: 'https://b', timeoutMs: 5 });
    await expect(p).rejects.toThrow(/connect timed out/);
    expect(sock.disconnected).toBe(true);
  });
});

describe('assertAckOk', () => {
  it('passes success/primitive/error-less acks', () => {
    expect(() => assertAckOk('items:update', { success: true })).not.toThrow();
    expect(() => assertAckOk('items:update', 'ok')).not.toThrow();
    expect(() => assertAckOk('items:update', undefined)).not.toThrow();
    expect(() => assertAckOk('items:update', { value: {} })).not.toThrow();
  });

  it('throws with the server message on an error ack', () => {
    expect(() => assertAckOk('items:update', { success: false, error: 'md5 mismatch' })).toThrow(
      /items:update failed: md5 mismatch/,
    );
    expect(() => assertAckOk('items:upload', { ok: false, message: 'nope' })).toThrow(
      /items:upload failed: nope/,
    );
    expect(() => assertAckOk('yurl:get', { error: 'denied' })).toThrow(/yurl:get failed: denied/);
    // no message field at all — still loud, dumps the ack
    expect(() => assertAckOk('items:get', { success: false })).toThrow(/"success":false/);
  });
});

describe('awaitContentPrefix', () => {
  it('polls items:get until a contentPrefix appears (unwrapping {success,value})', async () => {
    let calls = 0;
    const sock = new FakeSocket(() => {
      calls += 1;
      return calls < 3
        ? { success: true, value: { versions: [{ state: 'uploading' }] } }
        : { success: true, value: { contentPrefix: 'review/items/QQ' } };
    });
    const cp = await awaitContentPrefix(sock, 'item-1', { pollMs: 0, sleep: async () => {} });
    expect(cp).toBe('review/items/QQ');
    expect(calls).toBe(3);
    expect(sock.calls.every((c) => c.event === 'items:get')).toBe(true);
  });

  it('throws on timeout', async () => {
    const sock = new FakeSocket(() => ({ success: true, value: {} }));
    let t = 0;
    await expect(
      awaitContentPrefix(sock, 'item-1', { pollMs: 1, timeoutMs: 5, sleep: async () => {}, now: () => (t += 10) }),
    ).rejects.toThrow(/not ready/);
  });

  it('fails fast with the server message on an items:get error ack (no 180s poll grind)', async () => {
    const sock = new FakeSocket(() => ({ success: false, error: 'item deleted' }));
    await expect(
      awaitContentPrefix(sock, 'item-1', { pollMs: 0, sleep: async () => {} }),
    ).rejects.toThrow(/items:get failed: item deleted/);
    expect(sock.calls).toHaveLength(1); // no retry loop on a refused read
  });
});

describe('parseItemId', () => {
  it('reads id from assorted ack shapes', () => {
    expect(parseItemId({ id: 'a' })).toBe('a');
    expect(parseItemId({ item: { id: 'b' } })).toBe('b');
    expect(parseItemId({ data: { _id: 'c' } })).toBe('c');
    expect(parseItemId('d')).toBe('d');
  });
  it('throws when absent', () => {
    expect(() => parseItemId({ nope: 1 })).toThrow(/no item id/);
  });
});

describe('emitAck', () => {
  it('resolves with the server ack', async () => {
    const sock = new FakeSocket(() => ({ ok: true }));
    await expect(emitAck(sock, 'x', [{ a: 1 }])).resolves.toEqual({ ok: true });
    expect(sock.calls[0]).toEqual({ event: 'x', args: [{ a: 1 }] });
  });
  it('rejects on timeout when no ack comes', async () => {
    const silent: AckSocket = { emit: () => {}, disconnect: () => {} };
    await expect(emitAck(silent, 'x', [], 5)).rejects.toThrow(/timed out/);
  });
});

describe('uploadStorylinePackage', () => {
  it('runs create→yurl→PUT→update→upload in order and returns {itemId,key}', async () => {
    const responder = (event: string): unknown => {
      switch (event) {
        case 'items:create':
          return { item: { id: 'item-uuid' } };
        case 'yurl:get':
          return PRESIGNED;
        case 'items:update':
          return { ok: true };
        case 'items:upload':
          return { ok: true };
        default:
          return null;
      }
    };
    const sock = new FakeSocket(responder);
    const putBytes = vi.fn(async () => {});
    const zipBytes = new Uint8Array([1, 2, 3]);

    const res = await uploadStorylinePackage({
      socket: sock,
      userId: 'auth0|u',
      fileName: 'blk_9.zip',
      createdAt: '2026-06-24T00:00:00.000Z',
      zipBytes,
      md5Base64: 'MD5B64==',
      md5Hex: 'deadbeef',
      putBytes,
    });

    expect(res).toEqual({ itemId: 'item-uuid', key: 'review/uploads/PFX/blk_9.zip' });
    expect(sock.calls.map((c) => c.event)).toEqual([
      'items:create',
      'yurl:get',
      'items:update',
      'items:upload',
    ]);

    // PUT got the presigned url, the exact bytes, and the base64 md5 as Content-MD5
    expect(putBytes).toHaveBeenCalledWith(PRESIGNED, zipBytes, 'MD5B64==');

    // items:update carried the derived key + hex checksum + shared createdAt
    const update = sock.calls.find((c) => c.event === 'items:update')!.args[0] as any;
    expect(update.id).toBe('item-uuid');
    expect(update.versions[0].package).toEqual({
      key: 'review/uploads/PFX/blk_9.zip',
      md5_checksum: 'deadbeef',
    });
    expect(update.versions[0].createdAt).toBe('2026-06-24T00:00:00.000Z');

    // yurl:get arg is the encoded query string with our base64 md5
    expect(sock.calls.find((c) => c.event === 'yurl:get')!.args[0]).toContain('md5=MD5B64%3D%3D');
  });

  it('fails fast with the server message on an items:update error ack (no items:upload)', async () => {
    const sock = new FakeSocket((e) => {
      if (e === 'items:create') return { id: 'item-1' };
      if (e === 'yurl:get') return PRESIGNED;
      if (e === 'items:update') return { success: false, error: 'md5 mismatch' };
      return { success: true };
    });
    await expect(
      uploadStorylinePackage({
        socket: sock,
        userId: 'u',
        fileName: 'f.zip',
        zipBytes: new Uint8Array([1]),
        md5Base64: 'b',
        md5Hex: 'h',
        putBytes: async () => {},
      }),
    ).rejects.toThrow(/items:update failed: md5 mismatch/);
    // the error ack STOPS the sequence — items:upload is never emitted
    expect(sock.calls.map((c) => c.event)).toEqual(['items:create', 'yurl:get', 'items:update']);
  });

  it('fails fast on an items:upload error ack', async () => {
    const sock = new FakeSocket((e) => {
      if (e === 'items:create') return { id: 'item-1' };
      if (e === 'yurl:get') return PRESIGNED;
      if (e === 'items:upload') return { success: false, message: 'unzip refused' };
      return { success: true };
    });
    await expect(
      uploadStorylinePackage({
        socket: sock,
        userId: 'u',
        fileName: 'f.zip',
        zipBytes: new Uint8Array([1]),
        md5Base64: 'b',
        md5Hex: 'h',
        putBytes: async () => {},
      }),
    ).rejects.toThrow(/items:upload failed: unzip refused/);
  });

  it('aborts if the S3 PUT fails (no items:update/upload)', async () => {
    const sock = new FakeSocket((e) => (e === 'items:create' ? { id: 'x' } : PRESIGNED));
    const putBytes = vi.fn(async () => {
      throw new Error('S3 403');
    });
    await expect(
      uploadStorylinePackage({
        socket: sock,
        userId: 'u',
        fileName: 'f.zip',
        zipBytes: new Uint8Array(),
        md5Base64: 'b',
        md5Hex: 'h',
        putBytes,
      }),
    ).rejects.toThrow(/S3 403/);
    expect(sock.calls.map((c) => c.event)).toEqual(['items:create', 'yurl:get']);
  });
});
