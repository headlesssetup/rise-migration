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
  /** Relative path (resolved against the active Rise tab's origin), or an
   *  absolute URL for cross-origin account APIs (e.g. api.articulate.com). */
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
 * GET /manage/api/folders — the folder tree for courses (id, name,
 * parentFolderId, folderType…). Needed to preserve folder structure on
 * migration. (Bank folders come inline in the question-banks list.)
 */
export function buildListFoldersRequest(): RequestSpec {
  return { url: '/manage/api/folders', method: 'GET' };
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

/**
 * POST .../ducks/rise/blockTemplates/FETCH_BLOCK_TEMPLATES — the account's saved
 * reusable block templates (team library). Body payload is null.
 */
export function buildFetchBlockTemplatesRequest(): RequestSpec {
  return {
    url: '/api/rise-runtime/ducks/rise/blockTemplates/FETCH_BLOCK_TEMPLATES',
    method: 'POST',
    body: JSON.stringify({
      type: 'rise/blockTemplates/FETCH_BLOCK_TEMPLATES',
      payload: null,
    }),
  };
}

/**
 * POST .../ducks/rise/typefaces/FETCH_TYPEFACES — the account's custom fonts.
 * The payload is a courseId (the calling context); the response lists the
 * subscription-level typefaces regardless, so any saved course id works.
 */
export function buildFetchTypefacesRequest(courseId: string): RequestSpec {
  return {
    url: '/api/rise-runtime/ducks/rise/typefaces/FETCH_TYPEFACES',
    method: 'POST',
    body: JSON.stringify({
      type: 'rise/typefaces/FETCH_TYPEFACES',
      payload: courseId,
    }),
  };
}

/**
 * GET api[.eu].articulate.com/review/items — Review 360 "storyline" items the
 * account can reach (incl. Mighty bundles, flagged `source.mighty_bundle`).
 * Absolute URL (cross-origin, bearer-auth, CORS-enabled); covered by
 * host_permissions. Host follows the plane — the US host 404s/CORS-fails from an
 * EU session, so pass `eu` for the EU plane.
 */
export function buildReviewItemsRequest(eu = false): RequestSpec {
  const host = eu ? 'api.eu.articulate.com' : 'api.articulate.com';
  return {
    url: `https://${host}/review/items?includeStackItems=true&productFilter=storyline`,
    method: 'GET',
  };
}
