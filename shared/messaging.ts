// Typed message protocol between the side panel and the background worker.
// The panel orchestrates (pacing + disk writes); the background only captures
// the token and performs the individual cross-origin fetches.

import type { Identity } from '@/core/auth/jwt';
import type { WriteSpec } from '@/core/import/envelopes';
import type { GetCourseDocument, SearchResponse } from '@/shared/types/rise';

export type FetchResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status?: number; error: string };

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

/** Requests the panel sends to the background. */
export type BackgroundRequest =
  | { type: 'GET_SESSION_STATE' }
  | { type: 'SEARCH_COURSES'; page: number; pageSize?: number }
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
  | { type: 'REAUTH' };

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
  | { type: 'SEARCH_RESULT'; result: FetchResult<SearchResponse> }
  | {
      type: 'COURSE_RESULT';
      result: FetchResult<{ raw: string; doc: GetCourseDocument }>;
    }
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
      type: 'REAUTH_RESULT';
      // `advanced`: the token's `exp` actually moved forward (a real rotation).
      // `valid`: we currently hold a non-expired token (rotated or not).
      advanced: boolean;
      valid: boolean;
      identity: Identity | null;
    };

/** Raw outcome of a single relayed write (the executor's Relay consumes this). */
export interface WriteRelayResult {
  ok: boolean;
  status: number;
  text: string;
  error?: string;
}
