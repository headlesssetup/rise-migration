// Typed request builders for the Rise endpoints used in Phase 0. Pure: these
// produce request specs; the background runs them INSIDE the active Rise tab.
//
// URLs are RELATIVE (path + query, no origin) so they resolve against whichever
// Rise plane the tab is on — rise.articulate.com (US) or rise.eu.articulate.com
// (EU) — with no per-host code. Endpoints come from docs/rise-api-reference.md
// §3 — never inferred.

/** id.articulate.com session refresh (best-effort on 401 — see API ref §2/§10).
 *  Note: the EU plane may use a different auth host; refresh is best-effort and
 *  secondary now that calls ride the tab's first-party cookies. */
export const REFRESH_URL =
  'https://id.articulate.com/api/v1/sessions/me/lifecycle/refresh';

export interface RequestSpec {
  /** Relative path (resolved against the active Rise tab's origin). */
  url: string;
  method: 'GET' | 'POST';
  /** JSON body string for POSTs. */
  body?: string;
}

export interface SearchParams {
  page: number;
  pageSize?: number;
  sort?: string;
  types?: string[];
}

/**
 * GET /manage/api/content/search — enumerate content (API ref §3.1).
 * The `type` filter is OPTIONAL and omitted by default so we get everything the
 * "All Content" view shows (an over-eager `type=COURSE&type=MICROLEARNING`
 * filter returned zero against a live library). Pass `types` to narrow.
 */
export function buildSearchRequest(p: SearchParams): RequestSpec {
  const qs = new URLSearchParams();
  qs.set('page', String(p.page));
  qs.set('pageSize', String(p.pageSize ?? 16));
  qs.set('sort', p.sort ?? 'RECENTLY_UPDATED');
  for (const t of p.types ?? []) qs.append('type', t);
  return {
    url: `/manage/api/content/search?${qs.toString()}`,
    method: 'GET',
  };
}

/**
 * POST .../ducks/rise/courses/GET_COURSE — full course document (API ref §3.2).
 */
export function buildGetCourseRequest(courseId: string): RequestSpec {
  return {
    url: '/api/rise-runtime/ducks/rise/courses/GET_COURSE',
    method: 'POST',
    body: JSON.stringify({
      type: 'rise/courses/GET_COURSE',
      payload: { courseId },
    }),
  };
}

/**
 * GET /api/rise-authoring/question_banks — list reusable question banks
 * (API ref §9). These are separate from course content; draw-from-bank blocks
 * reference a bank id. Needed for migration of draw-from-bank blocks.
 */
export function buildListQuestionBanksRequest(): RequestSpec {
  return { url: '/api/rise-authoring/question_banks', method: 'GET' };
}

/**
 * GET /api/rise-authoring/question_banks/{id} — one bank with its questions
 * (API ref §9). A question = {id, type, title, answers:[{id,title,correct}],
 * feedback, …}.
 */
export function buildGetQuestionBankRequest(bankId: string): RequestSpec {
  return {
    url: `/api/rise-authoring/question_banks/${encodeURIComponent(bankId)}`,
    method: 'GET',
  };
}
