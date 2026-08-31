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
