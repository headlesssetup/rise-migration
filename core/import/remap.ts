// Phase 3 — copy-faithful block/document remapping.
//
// rise-import-protocol.md §3/§6: a source block round-trips VERBATIM except for
// three things — (a) regenerate client ids (block/item/question/answer) and keep
// internal `refs` consistent, (b) strip server-owned fields the source carried,
// (c) remap uploaded media keys (after re-upload) + cross-refs. This module does
// the generic, per-document transform; it never switches on family/variant.

import { classifyString } from '@/core/census/scan';
import { extractUploadedKeys } from '@/core/assets/keys';
import { IdMap, looksLikeClientId } from './ids';

/** Fields the server assigns/owns — never sent back on a create (the server
 *  re-mints them). Dropped wherever they appear in a block subtree. */
export const SERVER_OWNED_FIELDS = new Set([
  'globalBlockId',
  'createdAt',
  'updatedAt',
  'contentUpdatedAt',
  'lastUpdatedBy',
]);

type Json = unknown;

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Collect every client-style `id` value in a document subtree, pre-registering
 * old→new in the IdMap so that references (which may appear before or after the
 * defining `id`) all resolve to the same new id. Returns the IdMap for chaining.
 */
export function registerClientIds(doc: Json, ids: IdMap): IdMap {
  const walk = (node: Json): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isObject(node)) return;
    const id = node.id;
    if (looksLikeClientId(id)) ids.remap(id);
    for (const v of Object.values(node)) walk(v);
  };
  walk(doc);
  return ids;
}

/** Rewrite any `items:<oldId>` segments inside a ref/uploadId string. */
function remapRefString(s: string, ids: IdMap): string {
  return s.replace(/items:([a-z0-9]+)/gi, (m, id) => {
    const mapped = ids.get(id);
    return mapped ? `items:${mapped}` : m;
  });
}

/**
 * Deep-clone `doc`, regenerating client ids (consistently, via the IdMap),
 * rewriting id-bearing reference fields, and stripping server-owned fields.
 *
 * Generic rules (no per-block-type knowledge):
 *  - an `id` whose value looks like a client id → its mapped new id;
 *  - any string value that is EXACTLY a known old id → its new id (covers
 *    `correct`, `previousBlockId`, `pendingItemId`, …);
 *  - any string containing `items:<oldId>` → remapped (covers `refs`/`uploadId`);
 *  - `corrects: string[]` answer-id arrays are remapped element-wise;
 *  - SERVER_OWNED_FIELDS are removed.
 * Pre-registers all ids first so forward references resolve.
 */
export function remapIds<T extends Json>(doc: T, ids: IdMap): T {
  registerClientIds(doc, ids);

  const transform = (node: Json): Json => {
    if (typeof node === 'string') {
      const exact = ids.get(node);
      if (exact !== undefined) return exact;
      if (node.includes('items:')) return remapRefString(node, ids);
      return node;
    }
    if (Array.isArray(node)) return node.map(transform);
    if (!isObject(node)) return node;

    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(node)) {
      if (SERVER_OWNED_FIELDS.has(k)) continue;
      out[k] = transform(v);
    }
    return out;
  };

  return transform(doc) as T;
}

/** Replace uploaded-media key strings with `""` (used for the CREATE_BLOCKS
 *  payload — the block is created with empty media, then patched with the real
 *  new key after re-upload, mirroring the capture's create-then-attach order).
 *  CDN URLs and embeds are kept verbatim (not uploaded). */
export function blankUploadedMediaKeys<T extends Json>(doc: T): T {
  const transform = (node: Json): Json => {
    if (typeof node === 'string') {
      const kind = classifyString(node);
      if (kind && kind.startsWith('media-') && kind !== 'media-storyline') {
        return '';
      }
      return node;
    }
    if (Array.isArray(node)) return node.map(transform);
    if (!isObject(node)) return node;
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(node)) out[k] = transform(v);
    return out;
  };
  return transform(doc) as T;
}

/**
 * Replace uploaded-media keys per `keyMap` (source key → new target key),
 * applied after re-upload to build the UPDATE_BLOCK_DEBOUNCE patch payload.
 * A string node may be a bare key, a usercontent URL, or HTML embedding keys —
 * each contained source key present in the map is swapped (host preserved).
 */
export function remapMediaKeys<T extends Json>(
  doc: T,
  keyMap: Map<string, string>,
): T {
  const transform = (node: Json): Json => {
    if (typeof node === 'string') {
      const kind = classifyString(node);
      if (!kind || !kind.startsWith('media-')) return node;
      let s = node;
      for (const key of extractUploadedKeys(node)) {
        const next = keyMap.get(key);
        if (next) s = s.split(key).join(next);
      }
      return s;
    }
    if (Array.isArray(node)) return node.map(transform);
    if (!isObject(node)) return node;
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(node)) out[k] = transform(v);
    return out;
  };
  return transform(doc) as T;
}

/** Walk a doc and collect every uploaded media key, keyed by owner id (the 3rd
 *  path segment of `rise/{courses|questionBanks}/<ownerId>/…`). */
function collectUploadedKeysByOwner(doc: Json): { key: string; ownerId: string }[] {
  const out: { key: string; ownerId: string }[] = [];
  const walk = (node: Json): void => {
    if (typeof node === 'string') {
      const kind = classifyString(node);
      if (kind && kind.startsWith('media-')) {
        for (const key of extractUploadedKeys(node)) {
          const ownerId = key.split('/')[2] ?? '';
          out.push({ key, ownerId });
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (isObject(node)) for (const v of Object.values(node)) walk(v);
  };
  walk(doc);
  return out;
}

/**
 * Loud-fail assertion (CLAUDE.md: "no source media keys may survive"). Returns
 * every uploaded key still pointing at the SOURCE owner space
 * (`rise/courses/<sourceId>/…` or `rise/questionBanks/<sourceId>/…`) in the
 * rebuilt document — empty array means the course is self-sufficient on target.
 * `sourceOwnerIds` are the source course/bank ids whose keys must not survive.
 */
export function findSurvivingSourceKeys(
  doc: Json,
  sourceOwnerIds: Iterable<string>,
): string[] {
  const owners = new Set(sourceOwnerIds);
  const survivors = new Set<string>();
  for (const { key, ownerId } of collectUploadedKeysByOwner(doc)) {
    if (ownerId && owners.has(ownerId)) survivors.add(key);
  }
  return [...survivors];
}

/**
 * Stronger invariant: every uploaded key in the rebuilt doc must belong to a
 * TARGET owner (the new course id / new bank ids). Returns any key whose owner
 * is NOT a target owner — i.e. a source/foreign key that wasn't remapped. More
 * robust than an allowlist of known source owners (catches keys copied from
 * other courses/banks too).
 */
export function findForeignMediaKeys(
  doc: Json,
  targetOwnerIds: Iterable<string>,
): string[] {
  const targets = new Set(targetOwnerIds);
  const foreign = new Set<string>();
  for (const { key, ownerId } of collectUploadedKeysByOwner(doc)) {
    if (!ownerId || !targets.has(ownerId)) foreign.add(key);
  }
  return [...foreign];
}
