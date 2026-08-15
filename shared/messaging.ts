// Typed message protocol between the side panel and the background worker.
// The panel orchestrates (pacing + disk writes); the background only captures
// the token and performs the individual cross-origin fetches.

import type { Identity } from '@/core/auth/jwt';
import type { WriteSpec } from '@/core/import/envelopes';
import type { SearchResponse } from '@/shared/types/rise';

export type FetchResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status?: number;
      error: string;
      /** Machine-readable so a paced run can stop instead of failing every
       *  remaining item after one unrecoverable token expiry. */
      code?: 'AUTH_REQUIRED';
    };

/** Rise plane of a tab URL — null for anything that is not a Rise tab (so a tab
 *  navigated away from Rise never silently reads as 'us'). */
export function risePlaneFromUrl(url: string | undefined | null): 'us' | 'eu' | null {
  if (!url) return null;
  if (url.startsWith('https://rise.eu.articulate.com/')) return 'eu';
  if (url.startsWith('https://rise.articulate.com/')) return 'us';
  return null;
}

/**
 * Pin of an import run to ONE resolved target tab. Without it the background
 * re-resolves "the active Rise tab" per request, so focusing the SOURCE tab
 * mid-import would route authoring writes into the source account. The panel
 * resolves the pin once at run start (PIN_RISE_TAB) and passes it on every
 * relayed request of the run; the background then uses exactly that tab and
 * fails LOUDLY (no silent re-resolution) if the tab is gone or has left
 * `expectedPlane`. Requests without a pin keep the active-tab behavior
 * (export paths).
 */
export interface TabPin {
  pinnedTabId: number;
  expectedPlane: 'us' | 'eu';
}

export interface SessionState {
  hasToken: boolean;
  risePresent: boolean;
  identity: Identity | null;
  /** Display name read from the Rise page header (the account on the tab). */
  accountName: string | null;
  /** Which Rise plane the live tab is on, derived from its host. */
  plane: 'us' | 'eu' | null;
  /** The ACCOUNT-LOCAL Rise user id (the `_articulate_user_id` cookie). This is
   *  the valid principal for folder ownership — NOT the token `sub`, which on a
   *  cross-plane session is a different (Okta) id the folders API rejects. */
  userId: string | null;
}

/** Requests the panel sends to the background. EVERY request may carry a `pin`
 *  (see `BackgroundRequest` below) — the background then runs it in exactly that
 *  tab or fails loudly. */
type BackgroundRequestBody =
  | { type: 'GET_SESSION_STATE' }
  // Resolve the Rise tab a whole run should be pinned to (C4). Called ONCE at run
  // start; the returned TabPin is then attached to every request of that run.
  | { type: 'PIN_RISE_TAB' }
  | { type: 'SEARCH_COURSES'; page: number; pageSize?: number; term?: string }
  | { type: 'GET_COURSE'; courseId: string }
  | { type: 'LIST_FOLDERS' }
  | { type: 'LIST_QUESTION_BANKS' }
  | { type: 'GET_QUESTION_BANK'; bankId: string }
  | { type: 'FETCH_BLOCK_TEMPLATES' }
  | { type: 'FETCH_TYPEFACES'; courseId: string }
  // Phase 3 — relay a single WRITE envelope through the live Rise tab. The panel
  // orchestrates the sequence + pacing; the background just performs the fetch
  // (supports POST/PUT/DELETE, JSON or base64 binary bodies, presigned S3 PUT).
  | { type: 'RELAY_WRITE'; spec: WriteSpec }
  // Phase 3 — force a fresh bearer NOW (refresh the id.articulate.com session +
  // re-read the rotated `_articulate_rise_` cookie). The panel calls this before
  // each course so a long, write-quiet import never starts on a stale token (the
  // webRequest observer can't catch a fresh bearer when there's no page traffic).
  | {
      type: 'REAUTH';
      /** A read-only course editor the background may boot temporarily when
       *  only the dashboard is open. Used by long GET_COURSE/Storyline exports. */
      courseId?: string;
    }
  // Phase 4 — trigger a Storyline web/raw export for one course and await its
  // finished zip URL over the ws.eu JSON-RPC socket. Runs in the background
  // because it owns the bearer (the socket `identify` needs it). The panel then
  // downloads + repackages + stores the zip.
  | { type: 'STORYLINE_EXPORT'; courseId: string; title: string }
  // Phase 4 — upload one repackaged storyline zip to the TARGET Review 360 over
  // socket.io (items:create → yurl:get → S3 PUT → items:update → items:upload),
  // then poll items:get for the published contentPrefix. Runs in the background
  // (token + socket + cross-origin PUT). Plane-agnostic: targets the active tab's
  // plane. `zipB64` is the package zip; md5s are precomputed by the panel.
  | {
      type: 'STORYLINE_UPLOAD';
      zipB64: string;
      fileName: string;
      md5Base64: string;
      md5Hex: string;
    };

/**
 * A request, optionally PINNED to one resolved Rise tab. `pin` is the whole C4
 * contract: present ⇒ the background uses exactly `pin.pinnedTabId` and verifies
 * it is still on `pin.expectedPlane`, failing loudly otherwise (and using that
 * plane's bearer, never another plane's); absent ⇒ historical behavior (the
 * active/last-focused Rise tab). Import runs pin every message; export paths and
 * one-off panel reads leave it unset.
 */
export type BackgroundRequest = BackgroundRequestBody & { pin?: TabPin };

/** Account-level raw exports that share a {raw, doc} result shape. */
export type RawKind = 'blockTemplates' | 'typefaces';

/** Notifications the content script sends to the background. */
export type ContentMessage =
  | { type: 'RISE_PRESENT' }
  | { type: 'RISE_GONE' }
  | { type: 'RISE_ACCOUNT'; name: string };

/** Responses the background returns. */
export type BackgroundResponse =
  | { type: 'SESSION_STATE'; state: SessionState }
  | { type: 'RISE_TAB_PIN'; result: FetchResult<TabPin & { url: string }> }
  | { type: 'SEARCH_RESULT'; result: FetchResult<SearchResponse> }
  // Only the RAW body: a course document can approach the 64MB message cap, and
  // shipping a parsed copy alongside it doubled the payload for no gain (the
  // panel persists `raw` verbatim and unwraps it locally when it needs the doc).
  | { type: 'COURSE_RESULT'; result: FetchResult<{ raw: string }> }
  | { type: 'FOLDERS_RESULT'; result: FetchResult<{ raw: string; doc: unknown }> }
  | { type: 'BANKS_RESULT'; result: FetchResult<{ raw: string; doc: unknown }> }
  | { type: 'BANK_RESULT'; result: FetchResult<{ raw: string; doc: unknown }> }
  | {
      type: 'RAW_RESULT';
      kind: RawKind;
      result: FetchResult<{ raw: string; doc: unknown }>;
    }
  | { type: 'WRITE_RESULT'; result: WriteRelayResult }
  | {
      type: 'STORYLINE_EXPORT_RESULT';
      result: FetchResult<{ location: string; jobId: string }>;
    }
  | {
      type: 'STORYLINE_UPLOAD_RESULT';
      result: FetchResult<{ itemId: string; contentPrefix: string; key: string }>;
    }
  | {
      type: 'REAUTH_RESULT';
      // `advanced`: the token's `exp` actually moved forward (a real rotation).
      // `valid`: we currently hold a non-expired token (rotated or not).
      advanced: boolean;
      valid: boolean;
      identity: Identity | null;
      // How the bearer was (re)obtained this call — for honest panel logging and
      // runtime diagnosis: 'tab-reload' (Rise SPA native refresh on reload),
      // 'cookie' (already-rotated cookie re-read), or 'none'.
      via?: 'tab-reload' | 'editor-bootstrap' | 'cookie' | 'none';
    }
  // Last-resort answer when a handler throws outside its own try — the panel must
  // always get A response, or it awaits a dead port forever.
  | { type: 'ERROR'; error: string };

/** Raw outcome of a single relayed write (the executor's Relay consumes this). */
export interface WriteRelayResult {
  ok: boolean;
  status: number;
  text: string;
  error?: string;
}
