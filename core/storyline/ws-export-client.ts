// Live runner for the ws.eu export-completion socket. Connects, identifies with
// the bearer + our session id, and resolves with the finished zip's download URL
// when the `package:success` notify arrives.
//
// The socket is INJECTED (`connect`) so the sequence is unit-testable with a fake
// (see `ws-export-client.test.ts`); the default factory is a plain `WebSocket`.
//
// RUNTIME CAVEAT: a `WebSocket` opened from the extension origin sends
// `Origin: chrome-extension://…`. The captured client connected from the rise.eu
// origin. If ws.eu rejects our origin, this must instead be opened INSIDE the
// Rise tab (inject a page-context opener that relays frames back). We keep the
// pure sequence here regardless so only the transport would change.

import { buildClose, buildIdentify, parseExportFrame } from './ws-export';

export const WS_EXPORT_URL = 'wss://ws.eu.articulate.com/';

/** The slice of `WebSocket` we use — a real `WebSocket` satisfies it (via the
 *  cast in the default factory). One non-overloaded signature so fakes and the
 *  runner both typecheck cleanly. */
export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    cb: (ev?: { data?: unknown }) => void,
  ): void;
}

export type WsConnect = (url: string) => WsLike;

const defaultConnect: WsConnect = (url) => new WebSocket(url) as unknown as WsLike;

export interface AwaitExportOpts {
  token: string;
  /** Informational only — the session is SERVER-assigned (returned by `identify`
   *  and surfaced via `onIdentified`). Not used to drive the wait. */
  sessionId?: string;
  /** Resolve only on the notify for this job id (recommended). If omitted, the
   *  first `package:success` wins — fine for a single in-flight build. */
  jobId?: string;
  connect?: WsConnect;
  url?: string;
  timeoutMs?: number;
  /** Fired once the `identify` result arrives (server has bound our session).
   *  The caller triggers the `build/raw` request here — sending it only after the
   *  socket is listening guarantees we never miss the `package:success` notify.
   *  A throw rejects the whole wait. */
  onIdentified?: (sessionId: string) => void | Promise<void>;
}

export interface ExportLocation {
  location: string;
  jobId: string;
}

/**
 * Open the ws.eu socket, `identify`, and resolve with the `package:success`
 * download `location`. Sends `close` and tears down on success. Rejects on a
 * `package:*` error frame, socket error/close-before-success, or timeout.
 */
export function awaitExportLocation(opts: AwaitExportOpts): Promise<ExportLocation> {
  const connect = opts.connect ?? defaultConnect;
  const timeoutMs = opts.timeoutMs ?? 180_000;

  return new Promise<ExportLocation>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ws: WsLike;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      try {
        ws.send(buildClose());
      } catch {
        /* socket may already be gone */
      }
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    try {
      ws = connect(opts.url ?? WS_EXPORT_URL);
    } catch (e) {
      reject(new Error(`ws.eu connect failed: ${(e as Error).message}`));
      return;
    }

    timer = setTimeout(
      () => done(() => reject(new Error(`ws.eu export timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );

    ws.addEventListener('open', () => {
      try {
        ws.send(buildIdentify(opts.token));
      } catch (e) {
        done(() => reject(new Error(`ws.eu identify send failed: ${(e as Error).message}`)));
      }
    });

    ws.addEventListener('message', (ev) => {
      const data = ev?.data;
      const text = typeof data === 'string' ? data : String(data ?? '');
      const frame = parseExportFrame(text);
      if (frame.kind === 'identified') {
        if (opts.onIdentified) {
          Promise.resolve(opts.onIdentified(frame.sessionId)).catch((e) =>
            done(() => reject(new Error(`build trigger failed: ${(e as Error).message}`))),
          );
        }
      } else if (frame.kind === 'package-success') {
        if (opts.jobId && frame.jobId && frame.jobId !== opts.jobId) return; // not our job
        done(() => resolve({ location: frame.location, jobId: frame.jobId }));
      } else if (frame.kind === 'package-error') {
        if (opts.jobId && frame.jobId && frame.jobId !== opts.jobId) return;
        done(() =>
          reject(new Error(`ws.eu package error (${frame.type})${frame.message ? `: ${frame.message}` : ''}`)),
        );
      }
      // 'identified' / 'other' — keep waiting.
    });

    ws.addEventListener('error', () => {
      done(() => reject(new Error('ws.eu socket error')));
    });
    ws.addEventListener('close', () => {
      done(() => reject(new Error('ws.eu socket closed before package:success')));
    });
  });
}
