// mondrian-api request builders — capture-proven 2026-08-31 (`-mondrian.mitm`,
// `-mondrian2.mitm` on EU; `-mondrian3.mitm` plane-parity on US). The host is
// PER PLANE and a null plane is a loud error, never a default (same rule as
// the ws-distributor / Review-360 hosts). Auth: the plane's own bearer +
// first-party credentials, exactly like the ducks API — the specs below ride
// the normal relay (absolute URLs are fetched from the pinned Rise tab, whose
// Origin mondrian-api's CORS allows).

import type { Plane } from '@/core/auth/slots';
import type { WriteSpec } from '@/core/import/envelopes';

/** The plane's mondrian-api origin. Throws on unknown plane (never guess). */
export function mondrianApiBase(plane: Plane | null | undefined): string {
  if (plane !== 'us' && plane !== 'eu') {
    throw new Error(
      'Rise plane unknown — cannot pick the mondrian-api host. Open a logged-in Rise tab (US or EU) and retry.',
    );
  }
  return plane === 'us'
    ? 'https://mondrian-api.articulate.com'
    : 'https://mondrian-api.eu.articulate.com';
}

/** READ one blockument's full graph: GET /api/blockuments/<id>/manifest →
 *  `{blockuments:{<id>:doc}, items:{<itemId>:item}, fonts?}`. 404 body is
 *  `Blockuments <id> not found` (the same lookup whose failure 404s boot). */
export function blockumentManifest(plane: Plane, blockumentId: string): WriteSpec {
  return {
    url: `${mondrianApiBase(plane)}/api/blockuments/${encodeURIComponent(blockumentId)}/manifest`,
    method: 'GET',
    label: `mondrian GET blockument manifest ${blockumentId}`,
  };
}

/** CREATE an empty blockument parented to the course:
 *  POST /api/blockuments/createFromBlank {parentId, parentType:"course"} →
 *  the new graph (one blockument + its root "Canvas" group item). */
export function createBlockumentFromBlank(plane: Plane, courseId: string): WriteSpec {
  return {
    url: `${mondrianApiBase(plane)}/api/blockuments/createFromBlank`,
    method: 'POST',
    body: JSON.stringify({ parentId: courseId, parentType: 'course' }),
    label: 'mondrian POST blockuments/createFromBlank',
  };
}

/** WRITE state: POST /api/blockuments/<id>/transaction — a FULL-STATE upsert
 *  of the touched entities. Body is either `{blockument: <doc>}` or
 *  `{items: {<itemId>: <item>}}` (the editor sends one entity per call; we
 *  mirror that). Response is the plain text `OK`. */
export function blockumentTransaction(
  plane: Plane,
  blockumentId: string,
  body: { blockument: unknown } | { items: Record<string, unknown> },
): WriteSpec {
  const what = 'blockument' in body ? 'doc' : `item ${Object.keys(body.items)[0] ?? '?'}`;
  return {
    url: `${mondrianApiBase(plane)}/api/blockuments/${encodeURIComponent(blockumentId)}/transaction`,
    method: 'POST',
    body: JSON.stringify(body),
    label: `mondrian POST transaction (${what})`,
  };
}

/** Mondrian asset upload, step 1: POST /api/signed-asset-url
 *  {name, blockumentId} → `{asset:{id,path,name,type}, mimeType, url}` where
 *  `url` is a presigned S3 PUT for `mondrian/assets/blockument/<bid>/<assetId>.<ext>`.
 *  (Step 2 is the S3 PUT itself; step 3 is the standard ducks CRUSH_IMAGE
 *  {courseId, original:<path>} — capture-proven for THIS pipeline, unlike the
 *  block-media chain which deliberately skips CRUSH.) */
export function signedAssetUrl(plane: Plane, name: string, blockumentId: string): WriteSpec {
  return {
    url: `${mondrianApiBase(plane)}/api/signed-asset-url`,
    method: 'POST',
    body: JSON.stringify({ name, blockumentId }),
    label: 'mondrian POST signed-asset-url',
  };
}

/** Ducks CRUSH_IMAGE over a mondrian asset path (the editor fires it right
 *  after the asset PUT — mirrored verbatim; response carries a derived
 *  `rise/courses/<courseId>/…` key the item does not reference). */
export function crushMondrianAsset(courseId: string, originalPath: string): WriteSpec {
  return {
    url: '/api/rise-runtime/ducks/rise/uploads/CRUSH_IMAGE',
    method: 'POST',
    body: JSON.stringify({
      type: 'rise/uploads/CRUSH_IMAGE',
      payload: { courseId, original: originalPath },
    }),
    label: 'rise/uploads/CRUSH_IMAGE (mondrian asset)',
  };
}
