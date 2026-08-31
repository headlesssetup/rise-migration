// Generic discovery of mondrian cross-refs and assets — a recursive scan of
// the whole document (per the project convention: never a per-block-type walk).

import type { BlockumentGraph, BlockumentRef, MondrianAssetRecord } from './types';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Every `blockumentId` field in a document subtree (course doc, lesson, block),
 * with its JSON path. The field NAME is the contract (like the storyline
 * cross-ref detection in core/census/scan.ts) — any string-valued
 * `blockumentId` is a cross-account reference that must be remapped or the
 * course aborted, never shipped verbatim.
 */
export function collectBlockumentRefs(doc: unknown): BlockumentRef[] {
  const out: BlockumentRef[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (!isObject(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'blockumentId' && typeof v === 'string' && v !== '') {
        out.push({ id: v, path: `${path}.${k}`.replace(/^\./, '') });
      }
      walk(v, `${path}.${k}`);
    }
  };
  walk(doc, '');
  return out;
}

/** Distinct blockument ids referenced by a document. */
export function collectBlockumentIds(doc: unknown): string[] {
  return [...new Set(collectBlockumentRefs(doc).map((r) => r.id))];
}

/**
 * Replace every `blockumentId` field value per `map` (source id → new id) in a
 * deep clone. Returns the clone plus any referenced ids the map does NOT cover
 * (the caller aborts on those — a dangling id must never ship).
 */
export function remapBlockumentRefs<T>(
  doc: T,
  map: ReadonlyMap<string, string>,
): { doc: T; unmapped: BlockumentRef[] } {
  const unmapped: BlockumentRef[] = [];
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`));
    if (!isObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'blockumentId' && typeof v === 'string' && v !== '') {
        const next = map.get(v);
        if (next === undefined) {
          unmapped.push({ id: v, path: `${path}.${k}`.replace(/^\./, '') });
          out[k] = v;
        } else {
          out[k] = next;
        }
      } else {
        out[k] = walk(v, `${path}.${k}`);
      }
    }
    return out;
  };
  return { doc: walk(doc, '') as T, unmapped };
}

/** Every asset record in a blockument graph (deduped by asset id). These carry
 *  the downloadable `mondrian/assets/blockument/<bid>/<assetId>.<ext>` keys. */
export function collectGraphAssets(graph: BlockumentGraph): MondrianAssetRecord[] {
  const byId = new Map<string, MondrianAssetRecord>();
  for (const item of Object.values(graph.items ?? {})) {
    for (const rec of Object.values(item.assets ?? {})) {
      if (rec && typeof rec.id === 'string' && typeof rec.path === 'string') {
        byId.set(rec.id, rec);
      }
    }
  }
  return [...byId.values()];
}
