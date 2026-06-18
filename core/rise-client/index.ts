// Typed request builders for the Rise endpoints used in Phase 0. Pure: these
// produce request specs; the background service worker executes them with the
// captured bearer attached. Endpoints come straight from
// docs/rise-api-reference.md §3 — never inferred.

export const RISE_ORIGIN = 'https://rise.articulate.com';

/** id.articulate.com session refresh (best-effort on 401 — see API ref §2/§10). */
export const REFRESH_URL =
  'https://id.articulate.com/api/v1/sessions/me/lifecycle/refresh';

export interface RequestSpec {
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
 * GET /manage/api/content/search — enumerate courses (API ref §3.1).
 * Defaults mirror the captured request: pageSize=16, RECENTLY_UPDATED,
 * type=COURSE & type=MICROLEARNING.
 */
export function buildSearchRequest(p: SearchParams): RequestSpec {
  const qs = new URLSearchParams();
  qs.set('page', String(p.page));
  qs.set('pageSize', String(p.pageSize ?? 16));
  qs.set('sort', p.sort ?? 'RECENTLY_UPDATED');
  for (const t of p.types ?? ['COURSE', 'MICROLEARNING']) qs.append('type', t);
  return {
    url: `${RISE_ORIGIN}/manage/api/content/search?${qs.toString()}`,
    method: 'GET',
  };
}

/**
 * POST .../ducks/rise/courses/GET_COURSE — full course document (API ref §3.2).
 */
export function buildGetCourseRequest(courseId: string): RequestSpec {
  return {
    url: `${RISE_ORIGIN}/api/rise-runtime/ducks/rise/courses/GET_COURSE`,
    method: 'POST',
    body: JSON.stringify({
      type: 'rise/courses/GET_COURSE',
      payload: { courseId },
    }),
  };
}
