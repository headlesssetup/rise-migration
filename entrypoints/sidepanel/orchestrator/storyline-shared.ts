// Cross-stage helpers for the Storyline pipeline — split out of storyline.ts
// (v0.9.0 restructure). isAuthError is used by BOTH the export and the upload
// stages; storyline.ts re-exports it, so './storyline' imports are unchanged.
// defaultRefresh is the shared REAUTH hop both stages inject by default.

/**
 * A build/upload failure that's about auth/session freshness affects EVERY
 * course, so we abort the whole run rather than grind through all of them.
 * Matches SPECIFIC auth signals only. The old bare `token`/`session` substrings
 * aborted whole runs on incidental matches (any per-course message mentioning a
 * websocket session or a design token), while the upload pass's REAL stale-token
 * symptoms — the review socket's connect refused, or an unauthenticated socket
 * hanging its first ack (`auth:login` is fire-and-forget, so a stale bearer
 * surfaces as `items:create` never acking) — didn't match at all.
 * Exported for tests.
 */
export function isAuthError(msg: string): boolean {
  return (
    // HTTP auth statuses + explicit auth wording (incl. server error acks
    // surfaced by assertAckOk, e.g. "Review-360 items:update failed: unauthorized")
    /\b40[13]\b|forbidden|unauthoriz|unauthenticated|not authori/i.test(msg) ||
    // Explicit token/session-freshness verdicts (ws identify fail-fast, refresh)
    /token (?:likely )?stale|stale session|token expired|expired token|jwt expired|identify not received|identify refused/i.test(msg) ||
    // Background preconditions that fail every course identically
    /no rise token captured|no target account user id/i.test(msg) ||
    // Upload pass: review-socket connect refused/failed, or the first ack of an
    // unauthenticated socket timing out
    /review-360 socket connect_error|review-360 socket connect timed out|items:create ack timed out|websocket error/i.test(msg)
  );
}

import type { TabPin } from '@/shared/messaging';
import { pinnedRpc } from './import-shared';

/** Refresh the bearer/cookie once before a run. `courseId` lets the background
 *  boot a temporary editor when only the dashboard is open. */
export const defaultRefresh = async (
  pin?: TabPin,
  courseId?: string,
): Promise<{ advanced: boolean; valid: boolean; via?: string } | void> => {
  const r = await pinnedRpc(pin)({ type: 'REAUTH', courseId });
  return r.type === 'REAUTH_RESULT' ? { advanced: r.advanced, valid: r.valid, via: r.via } : undefined;
};
