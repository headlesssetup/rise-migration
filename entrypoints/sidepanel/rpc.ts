// Thin typed wrapper over runtime messaging to the background worker.
//
// Every call is bounded: a reaped service worker (or any lost port) leaves
// `sendMessage` pending forever, which froze whole runs with no log line. The
// deadline is generous — pacing means a legitimate round-trip is seconds — and
// the storyline sockets legitimately wait minutes, hence the per-type deadlines.

import type { BackgroundRequest, BackgroundResponse } from '@/shared/messaging';

/** Default deadline for a relayed read/write round-trip. */
export const RPC_TIMEOUT_MS = 120_000;

// Message types whose background handler legitimately blocks on a long socket
// wait; their deadline must clear the handler's own internal timeouts (export:
// 30s identify + 240s build; upload: the bytes PUT + a 180s contentPrefix poll)
// or the panel would abandon a still-healthy job.
const TIMEOUT_BY_TYPE: Partial<Record<BackgroundRequest['type'], number>> = {
  // Status poll must fail fast — a 120s hang left the panel on "Connecting…"
  // with no error while the service worker was dead / not answering.
  GET_SESSION_STATE: 5_000,
  STORYLINE_EXPORT: 300_000,
  STORYLINE_UPLOAD: 600_000,
};

export function rpcTimeoutFor(type: BackgroundRequest['type']): number {
  return TIMEOUT_BY_TYPE[type] ?? RPC_TIMEOUT_MS;
}

export async function rpc(
  req: BackgroundRequest,
  opts?: { timeoutMs?: number },
): Promise<BackgroundResponse> {
  const timeoutMs = opts?.timeoutMs ?? rpcTimeoutFor(req.type);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      browser.runtime.sendMessage(req) as Promise<BackgroundResponse>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Background did not answer ${req.type} within ${Math.round(timeoutMs / 1000)}s ` +
                  '(the extension service worker may have been restarted) — retry the step.',
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
