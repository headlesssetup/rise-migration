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
