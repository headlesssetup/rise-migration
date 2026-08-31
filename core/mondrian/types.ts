// Mondrian ("Custom block") blockuments — the block engine behind
// family/variant `mondrian/mondrian`. Each such Rise block carries a
// `blockumentId` pointing at a DOCUMENT stored in the plane's own
// `mondrian-api.{eu.}articulate.com` service, parented to the course. The
// document never rides the course JSON: preview/publish boot resolves every
// referenced blockument server-side and 404s the whole course when one is
// missing — the root cause of the 2026-08-31 EU import failure (a verbatim
// source `blockumentId` is a dangling cross-account ref).
//
// Shapes below are from the 2026-08-31 captures (`docs/rise-api-reference.md`
// §mondrian): read = GET /api/blockuments/<id>/manifest (also the bulk
// `manifests?blockumentId=` form), create = POST /api/blockuments/
// createFromBlank|createFromTemplate/<tpl>, write = POST
// /api/blockuments/<id>/transaction with FULL-STATE upserts. We keep the
// documents copy-faithful: only identities (blockument id, item ids/uuids,
// parent refs) and asset records (id + `mondrian/assets/…` path) are remapped.

/** One asset record inside an item's `assets` map (capture: image items).
 *  `path` is the downloadable key — served publicly by the plane's
 *  articulateusercontent host, uploaded via POST /api/signed-asset-url. */
export interface MondrianAssetRecord {
  id: string;
  path: string;
  name: string;
  type: string;
  [k: string]: unknown; // width/height/… — copied verbatim
}

/** A blockument item (canvas node): group/text/shape/image. Copy-faithful
 *  except `id`, `blockumentId`, `parentId` and the `assets` records. */
export interface BlockumentItem {
  id: string;
  blockumentId: string;
  parentId: string;
  type?: string;
  assets?: Record<string, MondrianAssetRecord>;
  [k: string]: unknown;
}

/** The blockument document itself. Copy-faithful except `id` and
 *  `children[].id` (which reference item ids). `_v` is the schema version
 *  (47 in every 2026-08-31 capture) — archived verbatim, surfaced in reports. */
export interface BlockumentDoc {
  id: string;
  title?: string;
  children?: { id: string; visualOrder?: number; [k: string]: unknown }[];
  _v?: number;
  [k: string]: unknown;
}

/** One blockument's full graph, as the manifest endpoints return it (and as
 *  the exporter archives it): the doc keyed by its id plus ALL of its items.
 *  `fonts` (present on text-bearing blockuments) holds only CSS theme vars in
 *  every capture — copied verbatim, never remapped. */
export interface BlockumentGraph {
  blockuments: Record<string, BlockumentDoc>;
  items: Record<string, BlockumentItem>;
  fonts?: Record<string, unknown> | null;
}

/** The per-course archive file `blockuments/<courseId>.json`: every blockument
 *  referenced by the course's blocks, keyed by SOURCE blockumentId. */
export interface BlockumentArchive {
  courseId: string;
  generatedAt: string;
  /** sourceBlockumentId → its full graph. */
  blockuments: Record<string, BlockumentGraph>;
}

/** A `blockumentId` reference found in a course document (generic scan). */
export interface BlockumentRef {
  /** The referenced blockument id (UUID). */
  id: string;
  /** JSON path of the carrying field, for loud abort messages. */
  path: string;
}
