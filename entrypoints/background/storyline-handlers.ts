// The two long-lived Storyline message handlers — split out of index.ts's
// handle() switch (v0.9.0 restructure). Each owns a socket lifecycle plus the
// worker keepalive; the per-plane token/reauth/relay closures stay in index.ts
// and arrive via StorylineHandlerDeps.

import { buildRawExportRequest, parseBuildAck } from '@/core/storyline/build-request';
import { awaitExportLocation, wsExportUrlForPlane, type WsLike } from '@/core/storyline/ws-export-client';
import { s3PutReview } from '@/core/import/envelopes';
import type { WriteSpec } from '@/core/import/envelopes';
import {
  awaitContentPrefix,
  connectReviewSocket,
  reviewSocketBaseForPlane,
  uploadStorylinePackage,
} from '@/core/storyline/review-socket-client';
import { noTokenForPlaneMessage } from '@/core/auth/slots';
import type {
  BackgroundRequest,
  BackgroundResponse,
  TabPin,
  WriteRelayResult,
} from '@/shared/messaging';
import { readAccountUserId, resolveTarget, type Plane } from './tabs';

export interface StorylineHandlerDeps {
  tokenFor(plane: Plane | null): string | null;
  tokenExpiringSoon(plane: Plane | null, skewMs?: number): boolean;
  reauthAllowed(): boolean;
  reauth(
    pin?: TabPin,
    refreshCourseId?: string,
  ): Promise<{
    advanced: boolean;
    valid: boolean;
    via?: 'tab-reload' | 'editor-bootstrap' | 'cookie' | 'none';
  }>;
  grabTokenForUrl(url: string | undefined): Promise<boolean>;
  relayWrite(spec: WriteSpec, pin?: TabPin): Promise<WriteRelayResult>;
  startKeepalive(): () => void;
}

export async function handleStorylineExport(
  msg: Extract<BackgroundRequest, { type: 'STORYLINE_EXPORT' }>,
  pin: TabPin | undefined,
  d: StorylineHandlerDeps,
): Promise<BackgroundResponse> {
  const { tokenFor, tokenExpiringSoon, reauthAllowed, reauth, grabTokenForUrl, startKeepalive, relayWrite } = d;
        // Trigger the web/raw export and await its zip URL on the ws socket. The
        // socket runs here so the bearer never leaves the background; the
        // build/raw POST is sent only AFTER `identify` so we can't miss the
        // completion notify. One course at a time (the panel paces the loop), so
        // the first package:success is ours.
        //
        // The completion socket is PLANE-SPECIFIC: a US export's package:success
        // is pushed to wss://ws.articulate.com, an EU export's to ws.eu. Listen on
        // the plane of the tab the export actually runs in, else we wait forever
        // on the wrong host.
        const resolved = await resolveTarget(pin);
        if (!resolved.ok) {
          return { type: 'STORYLINE_EXPORT_RESULT', result: { ok: false, error: resolved.error } };
        }
        const { plane, url: tabUrl } = resolved.target;
        // Keep the bearer fresh PER COURSE: the ws `identify` is token-authed and
        // fails silently (socket opens, no identify result) on a stale token —
        // the dominant failure on a long run. Re-read the rotated cookie cheaply;
        // reauth (tab reload) only when actually near expiry.
        if (tokenExpiringSoon(plane) && reauthAllowed()) await reauth(pin, msg.courseId);
        else await grabTokenForUrl(tabUrl);
        const token = tokenFor(plane);
        if (!token) {
          return {
            type: 'STORYLINE_EXPORT_RESULT',
            result: { ok: false, error: noTokenForPlaneMessage(plane) },
          };
        }
        const wsUrl = wsExportUrlForPlane(plane);
        const trace: string[] = [`plane=${plane}`, `ws=${wsUrl}`];
        // The waits below are minutes long with no extension-API traffic — keep
        // the worker (and this pending response) alive.
        const stopKeepalive = startKeepalive();
        try {
          const loc = await awaitExportLocation({
            token,
            url: wsUrl,
            connect: (url) => new WebSocket(url) as unknown as WsLike,
            // Fail fast if identify never lands (stale token); allow big-course
            // server builds plenty of time once identified.
            identifyTimeoutMs: 30_000,
            timeoutMs: 240_000,
            onOpen: () => trace.push('open'),
            // The sessionId is SERVER-ASSIGNED: it comes back on the `identify`
            // result and MUST be echoed as build/raw's websocketSessionId, or the
            // server never routes the package:success notify to our socket
            // (capture-confirmed: identify→{sessionId} == build/raw websocketSessionId).
            onIdentified: async (serverSessionId) => {
              trace.push(`identified(${serverSessionId.slice(0, 8)})`);
              const { spec } = buildRawExportRequest({
                courseId: msg.courseId,
                title: msg.title,
                websocketSessionId: serverSessionId,
              });
              const r = await relayWrite(spec, pin);
              trace.push(`build HTTP ${r.status}`);
              if (!r.ok) {
                throw new Error(`build/raw HTTP ${r.status}: ${(r.text ?? '').slice(0, 150)}`);
              }
              trace.push(`jobId ${parseBuildAck(r.text).jobId}`);
            },
          });
          return {
            type: 'STORYLINE_EXPORT_RESULT',
            result: { ok: true, status: 200, data: loc },
          };
        } catch (e) {
          return {
            type: 'STORYLINE_EXPORT_RESULT',
            result: { ok: false, error: `${(e as Error).message} [${trace.join(' → ')}]` },
          };
        } finally {
          stopKeepalive();
        }
}

export async function handleStorylineUpload(
  msg: Extract<BackgroundRequest, { type: 'STORYLINE_UPLOAD' }>,
  pin: TabPin | undefined,
  d: StorylineHandlerDeps,
): Promise<BackgroundResponse> {
  const { tokenFor, startKeepalive, relayWrite } = d;
        // Upload one repackaged storyline zip to the TARGET Review 360 over
        // socket.io, then resolve its published contentPrefix. The review-sockets
        // host follows the plane of the tab this runs in (pinned when the caller
        // pinned the run).
        const resolved = await resolveTarget(pin);
        if (!resolved.ok) {
          return { type: 'STORYLINE_UPLOAD_RESULT', result: { ok: false, error: resolved.error } };
        }
        const { plane } = resolved.target;
        const token = tokenFor(plane);
        if (!token) {
          return {
            type: 'STORYLINE_UPLOAD_RESULT',
            result: { ok: false, error: noTokenForPlaneMessage(plane) },
          };
        }
        const userId = await readAccountUserId(pin);
        if (!userId) {
          return {
            type: 'STORYLINE_UPLOAD_RESULT',
            result: { ok: false, error: 'No target account user id (open a logged-in Rise/360 tab).' },
          };
        }
        const base = reviewSocketBaseForPlane(plane);
        const trace: string[] = [`base=${base}`, `user=${userId.slice(0, 12)}`];
        let socket: Awaited<ReturnType<typeof connectReviewSocket>> | null = null;
        // Minutes of socket wait with no extension-API traffic — keep the worker
        // (and this pending response) alive.
        const stopKeepalive = startKeepalive();
        try {
          socket = await connectReviewSocket({ userId, token, base });
          trace.push('connected');
          const zipBytes = Uint8Array.from(atob(msg.zipB64), (c) => c.charCodeAt(0));
          const { itemId, key } = await uploadStorylinePackage({
            socket,
            userId,
            fileName: msg.fileName,
            zipBytes,
            md5Base64: msg.md5Base64,
            md5Hex: msg.md5Hex,
            // Cross-origin presigned PUT with Content-MD5 (reuse the same base64
            // bytes/md5 the panel computed; bytes arg is identical).
            putBytes: async (url) => {
              const r = await relayWrite(
                s3PutReview({ url, base64Body: msg.zipB64, contentMd5Base64: msg.md5Base64 }),
                pin,
              );
              if (!r.ok) throw new Error(`S3 PUT HTTP ${r.status}: ${(r.text ?? '').slice(0, 120)}`);
            },
          });
          trace.push(`item ${itemId.slice(0, 8)}`, `key ${key.split('/').pop()}`);
          const contentPrefix = await awaitContentPrefix(socket, itemId, { timeoutMs: 180_000 });
          trace.push(`prefix ${contentPrefix}`);
          return {
            type: 'STORYLINE_UPLOAD_RESULT',
            result: { ok: true, status: 200, data: { itemId, contentPrefix, key } },
          };
        } catch (e) {
          return {
            type: 'STORYLINE_UPLOAD_RESULT',
            result: { ok: false, error: `${(e as Error).message} [${trace.join(' → ')}]` },
          };
        } finally {
          stopKeepalive();
          try {
            socket?.disconnect();
          } catch {
            /* ignore */
          }
        }
}
