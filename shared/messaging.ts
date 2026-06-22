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
  | { type: 'REVIEW_ITEMS' }
  // Phase 3 — relay a single WRITE envelope through the live Rise tab. The panel
  // orchestrates the sequence + pacing; the background just performs the fetch
  // (supports POST/PUT/DELETE, JSON or base64 binary bodies, presigned S3 PUT).
  | { type: 'RELAY_WRITE'; spec: WriteSpec };

/** Account-level raw exports that share a {raw, doc} result shape. */
export type RawKind = 'blockTemplates' | 'typefaces' | 'reviewItems';

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
  | { type: 'WRITE_RESULT'; result: WriteRelayResult };

/** Raw outcome of a single relayed write (the executor's Relay consumes this). */
export interface WriteRelayResult {
  ok: boolean;
  status: number;
  text: string;
  error?: string;
}
