import { risePlaneFromUrl } from './messaging';

/**
 * Build the course-editor route that Rise itself opens from the dashboard.
 *
 * The route is capture-confirmed (`/authoring/{courseId}`). Keeping this in one
 * small helper prevents the auth recovery path from hand-building or guessing
 * account origins. A non-Rise URL is rejected rather than navigated.
 */
export function courseEditorUrl(tabUrl: string, courseId: string): string | null {
  if (!risePlaneFromUrl(tabUrl) || !courseId.trim()) return null;
  try {
    const url = new URL(tabUrl);
    url.pathname = `/authoring/${encodeURIComponent(courseId)}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Inverse of `courseEditorUrl`: the course id of a Rise EDITOR tab URL.
 * Only `/authoring/<courseId>` routes carry a course id — the dashboard,
 * preview, and Review 360 pages do not, and return null rather than a guess.
 */
export function editorCourseIdFromUrl(
  tabUrl: string | undefined | null,
): string | null {
  if (!tabUrl || !risePlaneFromUrl(tabUrl)) return null;
  try {
    const m = /^\/authoring\/([^/?#]+)/.exec(new URL(tabUrl).pathname);
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}
