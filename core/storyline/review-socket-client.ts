// Live runner for stage (C): drive the Review-360 upload sequence over a
// Socket.IO connection. The socket and the S3 byte PUT are both INJECTED so the
// sequence is unit-testable (see test); the default factory uses socket.io-client
// and the PUT is delegated to the background relay (cross-origin presigned PUT).
//
// Sequence (capture-confirmed): items:create → yurl:get → S3 PUT → items:update
// → items:upload. The returned `{itemId}` then resolves to a published
// `review/items/{leaf}` contentPrefix via the REST `/review/items` list (the
// orchestrator's job) or `items:get` polling.

import { io, type Socket } from 'socket.io-client';
import {
  buildItemsCreate,
  buildItemsGetArg,
  buildItemsUpdate,
  buildItemsUpload,
  buildYurlGetArg,
  parseContentPrefix,
  parseYurlAck,
  REVIEW_EVENTS,
} from './review-protocol';

export const REVIEW_SOCKET_BASE = 'https://360-review-sockets.eu.articulate.com';

/** Plane-aware review-sockets host (US drops the `.eu`). An unknown plane is a
 *  LOUD error, not a default: it means we couldn't read the Rise tab's URL, and
 *  silently picking EU would hang the upload against the wrong host. */
export function reviewSocketBaseForPlane(plane: 'us' | 'eu' | null | undefined): string {
  if (plane !== 'us' && plane !== 'eu') {
    throw new Error(
      'Rise plane unknown (no Rise tab URL) — cannot pick the Review-360 sockets host. Open a logged-in Rise tab (US or EU) and retry.',
    );
  }
  return plane === 'us'
    ? 'https://360-review-sockets.articulate.com'
    : 'https://360-review-sockets.eu.articulate.com';
}

/** The slice of a socket.io-client `Socket` we use. */
export interface AckSocket {
  emit(event: string, ...args: unknown[]): void;
  disconnect(): void;
}

/**
 * Default factory: connect to the `/user/{userId}` namespace and authenticate.
 * Auth mirrors the capture (`379dcf38-mitmzip.txt`): the bearer rides the
 * Socket.IO CONNECT packet via `auth:{token}`, and we also emit `auth:login`
 * once connected. Resolves when connected (or rejects on connect_error/timeout).
 *
 * RUNTIME-PENDING: the exact namespace/auth handshake and ack shapes need one
 * live confirmation against a throwaway EU account — the pure runner above is
 * transport-agnostic, so only this factory would change.
 */
export function connectReviewSocket(opts: {
  userId: string;
  token: string;
  base?: string;
  timeoutMs?: number;
}): Promise<Socket> {
  const base = opts.base ?? REVIEW_SOCKET_BASE;
  // The namespace is `/user/{userId}` with the LITERAL user id (e.g.
  // `auth0|5d53…`) — capture-confirmed. Do NOT percent-encode it: an encoded
  // pipe (`auth0%7C…`) yields "Invalid namespace" from the server.
  const socket = io(`${base}/user/${opts.userId}`, {
    transports: ['websocket'],
    auth: { token: opts.token },
    forceNew: true,
    // One-shot upload semantics: each upload connects, runs the handshake, and
    // disconnects. Auto-reconnect would (a) keep the manager retrying Articulate
    // forever from the service worker after a stale-token connect_error, and
    // (b) reconnect UNAUTHENTICATED after a mid-upload transport drop (our
    // `auth:login` only rides the first connect), turning every later emit into
    // a silent ack timeout. So: no reconnection — a dropped socket fails the
    // current upload loudly and the caller retries the whole package.
    reconnection: false,
  });
  return new Promise<Socket>((resolve, reject) => {
    // Settle exactly once, and drop our connect/connect_error listeners so they
    // can never fire again spuriously on the resolved socket.
    const settle = (): void => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
    };
    const timer = setTimeout(() => {
      settle();
      socket.disconnect();
      reject(new Error('Review-360 socket connect timed out'));
    }, opts.timeoutMs ?? 20_000);
    const onConnect = (): void => {
      settle();
      socket.emit('auth:login', opts.token);
      resolve(socket);
    };
    const onConnectError = (err: Error): void => {
      settle();
      // Tear the manager down — never leave it (or a future reconnect attempt)
      // dangling in the service worker after a failed connect.
      socket.disconnect();
      reject(new Error(`Review-360 socket connect_error: ${err.message}`));
    };
    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
  });
}

/** Emit an event with a single ack response + timeout. socket.io appends our
 *  callback as the last emit arg and invokes it with the server's ack. */
export function emitAck<T = unknown>(
  socket: AckSocket,
  event: string,
  args: unknown[],
  timeoutMs = 30_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`Review-360 ${event} ack timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.emit(event, ...args, (response: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Fail fast on an error ack. The server acks `{success:false, …}` (or an
 * `error` string) when it REFUSES a step — treating that as success used to
 * surface only 180s later as a misleading "item not ready" poll timeout. A
 * primitive or error-less ack passes (those shapes carry no failure signal).
 * @throws with the server's own message.
 */
export function assertAckOk(event: string, ack: unknown): void {
  if (!isObject(ack)) return;
  const failed =
    ack.success === false || ack.ok === false || (typeof ack.error === 'string' && ack.error !== '');
  if (!failed) return;
  const detail = [ack.error, ack.message, ack.reason].find(
    (v): v is string => typeof v === 'string' && v !== '',
  );
  throw new Error(
    `Review-360 ${event} failed: ${detail ?? JSON.stringify(ack).slice(0, 200)}`,
  );
}

/** Pull the new item id out of the `items:create` ack (shape not captured —
 *  accept `id`, `{item:{id}}`, `{data:{id}}`, or `_id`). @throws if none. */
export function parseItemId(ack: unknown): string {
  if (typeof ack === 'string') return ack;
  if (isObject(ack)) {
    const node = isObject(ack.item) ? ack.item : isObject(ack.data) ? ack.data : ack;
    for (const k of ['id', '_id', 'itemId'] as const) {
      if (typeof node[k] === 'string') return node[k] as string;
    }
  }
  throw new Error(`items:create ack had no item id: ${JSON.stringify(ack).slice(0, 200)}`);
}

export type PutBytes = (
  url: string,
  bytes: Uint8Array,
  contentMd5Base64: string,
) => Promise<void>;

export interface UploadStorylineOpts {
  socket: AckSocket;
  userId: string;
  /** Upload filename, e.g. `blk_9.zip`. Title/projectId default to it. */
  fileName: string;
  title?: string;
  /** ISO timestamp shared by items:create + items:update. Default: now. */
  createdAt?: string;
  zipBytes: Uint8Array;
  md5Base64: string;
  md5Hex: string;
  /** Cross-origin presigned S3 PUT (delegated to the background relay). */
  putBytes: PutBytes;
  ackTimeoutMs?: number;
}

export interface UploadStorylineResult {
  /** The Review-360 item id (UUID) — resolve its contentPrefix via /review/items. */
  itemId: string;
  /** The S3 key the bytes were PUT to. */
  key: string;
}

/**
 * Run the full upload handshake. Returns the new item id + uploaded key. Does
 * NOT resolve the published contentPrefix (that's a separate readiness poll /
 * REST list, since the server unzips asynchronously after items:upload).
 */
export async function uploadStorylinePackage(
  opts: UploadStorylineOpts,
): Promise<UploadStorylineResult> {
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const title = opts.title ?? opts.fileName;
  const t = opts.ackTimeoutMs;

  // 1. create the item (uploading state) → item id
  const createAck = await emitAck(
    opts.socket,
    REVIEW_EVENTS.create,
    [buildItemsCreate({ title, userId: opts.userId, createdAt })],
    t,
  );
  assertAckOk(REVIEW_EVENTS.create, createAck);
  const itemId = parseItemId(createAck);

  // 2. presigned upload url for the package zip
  const yurlAck = await emitAck(
    opts.socket,
    REVIEW_EVENTS.yurlGet,
    [buildYurlGetArg({ fileName: opts.fileName, md5Base64: opts.md5Base64 })],
    t,
  );
  assertAckOk(REVIEW_EVENTS.yurlGet, yurlAck);
  const { url, key } = parseYurlAck(yurlAck);

  // 3. S3 PUT the bytes (Content-MD5 = the same base64 md5). Byte transfer —
  //    outside the human-pacing invariant.
  await opts.putBytes(url, opts.zipBytes, opts.md5Base64);

  // 4. record the uploaded package on the item version. The ack IS inspected:
  //    an error ack here used to read as success and only surface 180s later as
  //    a misleading poll timeout.
  const updateAck = await emitAck(
    opts.socket,
    REVIEW_EVENTS.update,
    [buildItemsUpdate({ id: itemId, key, md5Hex: opts.md5Hex, userId: opts.userId, createdAt })],
    t,
  );
  assertAckOk(REVIEW_EVENTS.update, updateAck);

  // 5. trigger server-side unzip/transcode/publish
  const uploadAck = await emitAck(
    opts.socket,
    REVIEW_EVENTS.upload,
    [buildItemsUpload({ id: itemId })],
    t,
  );
  assertAckOk(REVIEW_EVENTS.upload, uploadAck);

  return { itemId, key };
}

/**
 * Poll `items:get` until the item reports a published `contentPrefix`
 * (`review/items/{leaf}`) — the value the import attach feeds to
 * `copy_review_item`. Server-side unzip/transcode is async, so we poll. Throws
 * on timeout. `sleep` is injectable for tests.
 */
export async function awaitContentPrefix(
  socket: AckSocket,
  itemId: string,
  opts: {
    pollMs?: number;
    timeoutMs?: number;
    ackTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<string> {
  const pollMs = opts.pollMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const start = now();
  for (;;) {
    const { id, opts: getOpts } = buildItemsGetArg(itemId);
    const ack = await emitAck(socket, REVIEW_EVENTS.get, [id, getOpts], opts.ackTimeoutMs);
    // An error ack means the server REFUSED the read (it acked `{success:true,…}`
    // in the capture) — fail with its message now, not a poll timeout later.
    assertAckOk(REVIEW_EVENTS.get, ack);
    const cp = parseContentPrefix(ack);
    if (cp) return cp;
    if (now() - start > timeoutMs) {
      throw new Error(`Review-360 item ${itemId} not ready after ${timeoutMs}ms`);
    }
    await sleep(pollMs);
  }
}
