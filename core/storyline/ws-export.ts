// Stage (A) completion channel — the `wss://ws.eu.articulate.com/` JSON-RPC 2.0
// socket that delivers a finished export's download URL.
//
// Sequence (capture-confirmed, `008212ae-mitmzip.txt`):
//   → {"id":0,"jsonrpc":"2.0","method":"identify","params":{"token":"<bearer>"}}
//   ← {"id":0,"jsonrpc":"2.0","result":{"sessionId":"<uuid>"}}        // session bound
//   ← {"jsonrpc":"2.0","method":"notify","params":{"type":"package:success",
//        "sender":"rise-distributor",
//        "payload":{"jobId,"jobName":"package:raw","location":"<zip url>"}}}
//   → {"jsonrpc":"2.0","method":"close"}
//
// The `sessionId` echoed by `identify` is the SAME value we pass as
// `websocketSessionId` in the build/raw request (see `build-request.ts`); that's
// how the server routes the `package:success` notify back to our job.
//
// This module is the PURE protocol (build/parse JSON-RPC frames). The live
// WebSocket plumbing lives in `ws-export-client.ts`, kept thin so this stays
// fully unit-testable.

const JSONRPC = '2.0';

/** Frame the client sends to bind the socket to our bearer + session. */
export function buildIdentify(token: string, id = 0): string {
  return JSON.stringify({ id, jsonrpc: JSONRPC, method: 'identify', params: { token } });
}

/** Frame the client sends to end the session once the notify arrives. */
export function buildClose(): string {
  return JSON.stringify({ jsonrpc: JSONRPC, method: 'close' });
}

/** A parsed inbound frame, classified for the client loop. */
export type WsExportFrame =
  | { kind: 'identified'; id: number | string | null; sessionId: string }
  | { kind: 'package-success'; jobId: string; jobName?: string; location: string }
  | { kind: 'package-error'; jobId?: string; type: string; message?: string }
  | { kind: 'other'; raw: unknown };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Classify one inbound JSON-RPC frame (text). Never throws — an unparseable or
 * unrecognized frame returns `{kind:'other'}` so the client can ignore it
 * (the socket also carries pings/acks we don't care about).
 *
 * Recognizes:
 *  - the `identify` result → `identified` (carries `sessionId`),
 *  - `notify` with `payload.type === "package:success"` → `package-success`
 *    (carries the `location` zip URL),
 *  - `notify` with any other `package:*` type → `package-error` (e.g. a failed
 *    or cancelled build), so the caller fails loudly instead of hanging.
 */
export function parseExportFrame(text: string): WsExportFrame {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { kind: 'other', raw: text };
  }
  if (!isObject(doc)) return { kind: 'other', raw: doc };

  // identify result
  if (isObject(doc.result) && typeof doc.result.sessionId === 'string') {
    return {
      kind: 'identified',
      id: (doc.id as number | string | null) ?? null,
      sessionId: doc.result.sessionId,
    };
  }

  // notify push
  if (doc.method === 'notify' && isObject(doc.params)) {
    const params = doc.params;
    const type = typeof params.type === 'string' ? params.type : '';
    const payload = isObject(params.payload) ? params.payload : {};
    if (type === 'package:success' && typeof payload.location === 'string') {
      return {
        kind: 'package-success',
        jobId: payload.jobId !== undefined ? String(payload.jobId) : '',
        jobName: typeof payload.jobName === 'string' ? payload.jobName : undefined,
        location: payload.location,
      };
    }
    if (type.startsWith('package:')) {
      return {
        kind: 'package-error',
        jobId: payload.jobId !== undefined ? String(payload.jobId) : undefined,
        type,
        message:
          typeof payload.message === 'string'
            ? payload.message
            : typeof payload.error === 'string'
              ? payload.error
              : undefined,
      };
    }
  }

  return { kind: 'other', raw: doc };
}
