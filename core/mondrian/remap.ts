// Copy-faithful blockument graph remapping for import: regenerate identities
// (blockument id, item uuids, parent refs, children refs) and asset records,
// keep EVERYTHING else verbatim (settings, states, tiptap text, provenance
// fields like clonedFromId/createdFromTemplateId — boot inlines them without
// resolving, capture-confirmed).

import type { BlockumentDoc, BlockumentGraph, BlockumentItem } from './types';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Exact-value substitution of long high-entropy ids/paths across a subtree —
 *  safe for uuids/asset ids/asset paths, mirrors core/import/remap semantics. */
function substitute<T>(node: T, map: Map<string, string>): T {
  const walk = (n: unknown): unknown => {
    if (typeof n === 'string') return map.get(n) ?? n;
    if (Array.isArray(n)) return n.map(walk);
    if (!isObject(n)) return n;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) out[k] = walk(v);
    return out;
  };
  return walk(node) as T;
}

export interface RemappedBlockument {
  /** The document to write (transaction body `{blockument: doc}`). */
  doc: BlockumentDoc;
  /** Items to write (one transaction per item, editor-order: parents first). */
  items: BlockumentItem[];
  /** old item id → new item id. */
  itemIdMap: Map<string, string>;
  /** The adopted root ("Canvas") item's NEW id. */
  rootItemId: string;
}

/**
 * Remap one archived blockument graph onto a freshly created target blockument.
 *
 * `createFromBlank` returns a new blockument that already OWNS one root canvas
 * item — we ADOPT it (mirror of the onePage shell-lesson adoption): the source
 * root item (the one whose `parentId` is the blockument itself) keeps the
 * created canvas item's id, every other item gets a fresh uuid. Parent/children
 * references follow. Asset ids/paths are NOT touched here — they are remapped
 * by `substitute` maps built after the asset uploads (see applyAssetMap).
 */
export function remapBlockumentGraph(
  graph: BlockumentGraph,
  sourceBlockumentId: string,
  newBlockumentId: string,
  adoptRootItemId: string,
  mintUuid: () => string,
): RemappedBlockument {
  const srcDoc = graph.blockuments?.[sourceBlockumentId];
  if (!srcDoc) {
    throw new Error(`Blockument ${sourceBlockumentId} not present in its archived graph`);
  }
  const items = Object.values(graph.items ?? {}).filter(
    (i) => i.blockumentId === sourceBlockumentId,
  );
  const roots = items.filter((i) => i.parentId === sourceBlockumentId);
  if (roots.length !== 1) {
    throw new Error(
      `Blockument ${sourceBlockumentId}: expected exactly 1 root item, found ${roots.length} — unfamiliar graph shape, aborting (never ship a guessed structure)`,
    );
  }
  const itemIdMap = new Map<string, string>();
  itemIdMap.set(roots[0]!.id, adoptRootItemId);
  for (const item of items) {
    if (!itemIdMap.has(item.id)) itemIdMap.set(item.id, mintUuid());
  }
  // One substitution map covers item ids AND the blockument id itself — item
  // ids are uuids and the exact-value swap also fixes any reference we did not
  // anticipate (triggers were `[]` in every capture; this keeps them valid if
  // a future one references an item).
  const sub = new Map<string, string>(itemIdMap);
  sub.set(sourceBlockumentId, newBlockumentId);

  const doc = substitute(srcDoc, sub);
  // Parents-first order so each transaction upserts an item whose parent the
  // server already knows (root first, then by tree depth).
  const byOld = new Map(items.map((i) => [i.id, i]));
  const depth = (i: BlockumentItem): number => {
    let d = 0;
    let cur: BlockumentItem | undefined = i;
    const seen = new Set<string>();
    while (cur && cur.parentId !== sourceBlockumentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byOld.get(cur.parentId);
      d++;
      if (d > 100) break; // cyclic/corrupt parent chain — order best-effort
    }
    return d;
  };
  const ordered = [...items].sort((a, b) => depth(a) - depth(b));
  return {
    doc,
    items: ordered.map((i) => substitute(i, sub)),
    itemIdMap,
    rootItemId: adoptRootItemId,
  };
}

/**
 * After the asset uploads: swap every OLD asset id and OLD `mondrian/assets/…`
 * path for the new ones, everywhere in the items (the `assets` record maps,
 * `fill.assetId`, and any other reference). Record-map KEYS are asset ids too,
 * so rebuild them explicitly, then run the generic value substitution.
 */
export function applyAssetMap(
  items: BlockumentItem[],
  assetMap: Map<string, { id: string; path: string }>,
): BlockumentItem[] {
  const sub = new Map<string, string>();
  for (const [oldId, next] of assetMap) sub.set(oldId, next.id);
  // Pass 1 — learn every old path → new path across ALL items first (an asset
  // could be referenced by path from an item other than the record's owner).
  for (const item of items) {
    for (const [oldId, rec] of Object.entries(item.assets ?? {})) {
      const next = assetMap.get(oldId);
      if (next && isObject(rec) && typeof rec.path === 'string') sub.set(rec.path, next.path);
    }
  }
  // Pass 2 — rebuild the record maps (their KEYS are asset ids) + substitute.
  return items.map((item) => {
    let out = item;
    if (item.assets && isObject(item.assets)) {
      const rebuilt: Record<string, unknown> = {};
      for (const [oldId, rec] of Object.entries(item.assets)) {
        const next = assetMap.get(oldId);
        if (next && isObject(rec)) {
          rebuilt[next.id] = { ...rec, id: next.id, path: next.path };
        } else {
          rebuilt[oldId] = rec;
        }
      }
      out = { ...item, assets: rebuilt as BlockumentItem['assets'] };
    }
    return substitute(out, sub);
  });
}

/**
 * Known schema migrations, applied ONLY when adopting a target `_v` that is
 * newer than the archived one. Each entry is capture/server-derived, never a
 * guess: the server's own 400 names the field and its enum, and an archived
 * graph already at the newer version shows the value every migrated instance
 * carries.
 *
 *  51 → 52 — `states.default.shapeDef.orient` became REQUIRED on every item
 *  that has a `shapeDef` (live EU 2026-10-19: `invalid_value … values:
 *  ["normal","cw","half","ccw","flip","flip-cw","flip-half","flip-ccw"]
 *  … path ["items",<id>,"states","default","shapeDef","orient"]`). v51 had no
 *  orientation concept, so every v51 shape renders unrotated = `"normal"` —
 *  the value on all 15 shapes of the one v52 graph the DFO export captured.
 */
const SHAPE_ORIENT_DEFAULT = 'normal';

function migrate51to52(item: BlockumentItem): { item: BlockumentItem; touched: number } {
  let touched = 0;
  const walk = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(walk);
    if (!isObject(n)) return n;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === 'shapeDef' && isObject(v) && !('orient' in v)) {
        out[k] = { ...v, orient: SHAPE_ORIENT_DEFAULT };
        touched++;
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  };
  return { item: walk(item) as BlockumentItem, touched };
}

/** Migration steps keyed by the version they START from. A gap (an archived
 *  or target version with no step) is NOT bridged — fields ship verbatim and
 *  the server's validator is the loud tripwire. */
const MIGRATIONS: Record<number, (item: BlockumentItem) => { item: BlockumentItem; touched: number }> = {
  51: migrate51to52,
};

/**
 * Stamp the TARGET's blockument schema version onto a remapped graph, applying
 * the known field migrations between the archived and the target version.
 *
 * The mondrian transaction validator checks `_v` against the service's CURRENT
 * schema (live 2026-10-19, EU: `{"code":"invalid_value","values":[52],"path":
 * ["blockument","_v"],"message":"Invalid input: expected 52"}` for an archive
 * captured at 51). The archived number is the SOURCE plane's version at export
 * time; the only authoritative value for the target is what its own
 * `createFromBlank` just returned, so adopt that on the doc and every item.
 * Then walk MIGRATIONS from the archived version up to the target; versions
 * without a known step leave fields verbatim (a rejected item 400s loudly and
 * the course stays `partial`). `targetV` undefined (dry-run, or a response
 * without `_v`) → unchanged.
 */
export function adoptSchemaVersion(
  remapped: RemappedBlockument,
  targetV: number | undefined,
): {
  remapped: RemappedBlockument;
  archivedV: number | undefined;
  changed: boolean;
  /** Migration steps applied, e.g. ["51→52 shapeDef.orient on 12 item(s)"]. */
  migrations: string[];
  /** Versions between archived and target with NO known migration step. */
  unbridged: number[];
} {
  const archivedV = remapped.doc._v;
  if (typeof targetV !== 'number' || !Number.isFinite(targetV)) {
    return { remapped, archivedV, changed: false, migrations: [], unbridged: [] };
  }
  const changed =
    archivedV !== targetV || remapped.items.some((i) => i._v !== undefined && i._v !== targetV);
  if (!changed) return { remapped, archivedV, changed: false, migrations: [], unbridged: [] };

  let items = remapped.items;
  const migrations: string[] = [];
  const unbridged: number[] = [];
  if (typeof archivedV === 'number' && archivedV < targetV) {
    for (let v = archivedV; v < targetV; v++) {
      const step = MIGRATIONS[v];
      if (!step) {
        unbridged.push(v);
        continue;
      }
      let touched = 0;
      items = items.map((i) => {
        const r = step(i);
        touched += r.touched;
        return r.item;
      });
      migrations.push(`${v}→${v + 1}${v === 51 ? ' shapeDef.orient' : ''} on ${touched} item(s)`);
    }
  }
  return {
    remapped: {
      ...remapped,
      doc: { ...remapped.doc, _v: targetV },
      items: items.map((i) => (i._v === undefined ? i : { ...i, _v: targetV })),
    },
    archivedV,
    changed: true,
    migrations,
    unbridged,
  };
}
