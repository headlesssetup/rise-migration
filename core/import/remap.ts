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

/**
 * Give a BLOCK's structural client ids fresh values, positionally.
 *
 * Why this exists: `remapIds` only re-mints ids that LOOK like Rise cuids
 * (`looksLikeClientId`). Real courses carry other shapes — Rise's own sample
 * courses number their blocks and items `"1"`, `"2"`, `"3"` and reuse those ids
 * in EVERY lesson (one captured course: 40 blocks, 14 distinct ids). Sending the
 * same block id for five lessons made the server clobber them: blocks landed in
 * the wrong lesson, and on a stack their translation cells vanished with them.
 *
 * A block id is ours to choose, so any id that is not cuid-shaped is replaced
 * with a fresh one. The rewrite is:
 *  - POSITIONAL — only the block's own `id` and the `id` of objects reachable
 *    through `items` arrays. Ids nested elsewhere (`media.storyline.meta.slides[].id`,
 *    bank `questions[].id`) are left alone; a short id like "1" must never be
 *    replaced by string-equality, which would also hit ordinary values.
 *  - PER BLOCK — the map is local to this call, so `"1"` in lesson 2 and `"1"`
 *    in lesson 3 get DIFFERENT new ids (the whole point).
 * `items:<oldId>` ref strings inside the same block are rewritten to match.
 *
 * Blocks whose ids are already cuid-shaped come back untouched (the global
 * `remapIds` pass handles those, keeping cross-block refs consistent).
 */
export function freshClientIds<T extends Json>(block: T, mint: () => string): T {
  const local = new Map<string, string>();
  const claim = (id: unknown): string | undefined => {
    if (typeof id !== 'string' || id === '' || looksLikeClientId(id)) return undefined;
    let next = local.get(id);
    if (!next) {
      next = mint();
      local.set(id, next);
    }
    return next;
  };
  // Pass 1 — collect, walking only the structural id positions.
  const collect = (node: Json): void => {
    if (!isObject(node)) return;
    claim(node.id);
    const items = node.items;
    if (Array.isArray(items)) items.forEach(collect);
  };
  collect(block);
  if (local.size === 0) return block;
  // Pass 2 — clone, substituting ids at those positions and inside ref strings.
  const clone = (node: Json, structural: boolean): Json => {
    if (typeof node === 'string') {
      return node.replace(/items:([^/\s"']+)/g, (m, id: string) => {
        const next = local.get(id);
        return next ? `items:${next}` : m;
      });
    }
    if (Array.isArray(node)) return node.map((v) => clone(v, structural));
    if (!isObject(node)) return node;
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'id' && structural && typeof v === 'string' && local.has(v)) {
        out[k] = local.get(v)!;
      } else if (k === 'items') {
        out[k] = Array.isArray(v) ? v.map((child) => clone(child, true)) : clone(v, false);
      } else {
        out[k] = clone(v, false);
      }
    }
    return out;
  };
  return clone(block, true) as T;
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

// A string value that IS one bare key / usercontent-URL key (no surrounding
// authored text) — blanking such a value empties the whole slot.
const RE_WHOLE_MEDIA_VALUE =
  /^(?:https?:\/\/(?:www\.)?articulateusercontent\.(?:com|eu)\/)?rise\/(?:courses|questionBanks)\/\S+$/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove ONE media reference from a string without destroying authored text
 * around it. A bare key/URL value blanks to `''`; a key embedded in a larger
 * string (rich-text HTML, CSS) loses only its enclosing media construct — the
 * containing tag (`<img …>`, `<source …>`), a `url(…)` construct, or, failing
 * that, the URL/key occurrence itself. Post-condition: `key` no longer appears
 * (a final split/join backstops the invariant over fidelity).
 */
export function stripMediaReference(s: string, key: string): string {
  if (!s.includes(key)) return s;
  if (RE_WHOLE_MEDIA_VALUE.test(s.trim())) return '';
  const esc = escapeRegExp(key);
  let out = s.replace(new RegExp(`<[a-zA-Z][^<>]*${esc}[^<>]*>`, 'g'), '');
  out = out.replace(
    new RegExp(`url\\(\\s*(?:['"]|&quot;)?[^()]*${esc}[^()]*(?:['"]|&quot;)?\\s*\\)`, 'g'),
    '',
  );
  out = out.replace(new RegExp(`(?:https?:\\/\\/)?[^\\s"'<>()]*${esc}[^\\s"'<>()]*`, 'g'), '');
  if (out.includes(key)) out = out.split(key).join('');
  return out;
}

/** Blank the given keys out of one string value: bare key/URL → `''`, embedded
 *  keys → surgically stripped (authored text survives). A media-shaped string
 *  whose keys can't be extracted blanks whole — no source key may survive. */
function blankKeysInString(s: string, keys: string[]): string {
  if (keys.length === 0) return '';
  let out = s;
  for (const key of keys) out = stripMediaReference(out, key);
  return out;
}

/** Blank uploaded-media keys (used for the CREATE_BLOCKS payload — the block is
 *  created with empty media, then patched with the real new key after re-upload,
 *  mirroring the capture's create-then-attach order). A bare key value blanks to
 *  `''`; a key embedded in authored HTML is stripped surgically so the text
 *  survives. CDN URLs and embeds are kept verbatim (not uploaded). Storyline
 *  keys are blanked too: Storyline/Mighty blocks are recreated as EMPTY
 *  placeholders (the bundle is added out of band), and a dead source key must
 *  never survive in the target (it would point at the source course + trip the
 *  no-survivors invariant). */
export function blankUploadedMediaKeys<T extends Json>(doc: T): T {
  const transform = (node: Json): Json => {
    if (typeof node === 'string') {
      const kind = classifyString(node);
      if (kind && kind.startsWith('media-')) {
        return blankKeysInString(node, extractUploadedKeys(node));
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
 * A key mapped to `''` is the BLANKING convention (orphaned / oversize /
 * unsupported media): its reference is stripped, never left verbatim — a dead
 * source key must not survive just because it has no replacement.
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
        if (next === undefined) continue;
        s = next === '' ? stripMediaReference(s, key) : s.split(key).join(next);
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

/** Blank uploaded-media keys whose owner is NOT a target owner — keeps
 *  already-remapped (target-owned) keys, blanks leftover SOURCE keys. Used for the
 *  lesson payload after a header/media upload: `remapMediaKeys` swaps the uploaded
 *  key to its new (target) key, then this blanks any media that wasn't uploaded so
 *  a dead source key never survives. Foreign keys embedded in authored HTML are
 *  stripped surgically (the text survives); a bare foreign value blanks to `''`.
 *  CDN/embed strings are left untouched. */
export function blankForeignMediaKeys<T extends Json>(
  doc: T,
  targetOwnerIds: Iterable<string>,
): T {
  const targets = new Set(targetOwnerIds);
  const transform = (node: Json): Json => {
    if (typeof node === 'string') {
      const kind = classifyString(node);
      if (!kind || !kind.startsWith('media-')) return node; // cdn/embed/non-media kept
      const keys = extractUploadedKeys(node);
      if (keys.length === 0) return ''; // media-shaped but unextractable → blank whole
      const foreign = keys.filter((k) => !targets.has(k.split('/')[2] ?? ''));
      if (foreign.length === 0) return node;
      return blankKeysInString(node, foreign);
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
  // Path-aware so storyline media (under `media.storyline.*`) is recognised as
  // such even when the key string itself has no telltale extension.
  const walk = (node: Json, path: string): void => {
    if (typeof node === 'string') {
      const kind = classifyString(node, path);
      // Storyline keys are EXCLUDED: Storyline/Mighty blocks are recreated as
      // empty placeholders (media blanked) and their bundles are added out of
      // band — they're never migrated, so they don't count toward the
      // "no source key survives" invariant (else every Storyline course fails).
      if (kind && kind.startsWith('media-') && kind !== 'media-storyline') {
        for (const key of extractUploadedKeys(node)) {
          const ownerId = key.split('/')[2] ?? '';
          out.push({ key, ownerId });
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (isObject(node)) for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  walk(doc, '');
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
