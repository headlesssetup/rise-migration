// Typed message protocol between the side panel and the background worker.
// The panel orchestrates (pacing + disk writes); the background only captures
// the token and performs the individual cross-origin fetches.

import type { Identity } from '@/core/auth/jwt';
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
}

/** Requests the panel sends to the background. */
export type BackgroundRequest =
  | { type: 'GET_SESSION_STATE' }
  | { type: 'SEARCH_COURSES'; page: number; pageSize?: number }
  | { type: 'GET_COURSE'; courseId: string }
  | { type: 'LIST_FOLDERS' }
  | { type: 'LIST_QUESTION_BANKS' }
  | { type: 'GET_QUESTION_BANK'; bankId: string };

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
  | { type: 'BANK_RESULT'; result: FetchResult<{ raw: string; doc: unknown }> };
