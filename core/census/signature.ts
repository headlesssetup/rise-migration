// Structural shape signature for a block: the full set of recursive key-paths,
// with array indices collapsed to `[]` and id-shaped map keys collapsed to `*`.
// Values are ignored — only structure — so two blocks with the same fields have
// the same signature regardless of content. This is what Tier-2 novelty review
// compares against the block catalog (PRD §8).

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_CUID = /^c[a-z0-9]{24}$/i; // cuid v1 (25 chars)
const RE_HEX = /^[0-9a-f]{24,}$/i;

// Collapse obvious id-shaped object keys (id-keyed maps) so signatures don't
// vary per course. Conservative: only uuid/cuid/long-hex, never normal fields.
function normalizeKey(k: string): string {
  return RE_UUID.test(k) || RE_CUID.test(k) || RE_HEX.test(k) ? '*' : k;
}

/** Sorted, de-duplicated set of recursive key-paths within `value`. */
export function keyPaths(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item, `${path}[]`);
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        const p = path ? `${path}.${normalizeKey(k)}` : normalizeKey(k);
        out.add(p);
        walk(val, p);
      }
    }
  };
  walk(value, '');
  return [...out].sort();
}

export interface BlockShape {
  /** `family/variant` — the catalog key. */
  key: string;
  /** Stable short hash of the structural key-paths. */
  signature: string;
  /** The structural key-paths (sorted). */
  paths: string[];
}

/** FNV-1a 32-bit hash of the key-path set → 8-hex string. Stable across runs. */
export function hashPaths(paths: string[]): string {
  let h = 0x811c9dc5;
  const s = paths.join('\n');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Structural shape of a block node, or null if it isn't a family/variant block. */
export function blockShape(block: Record<string, unknown>): BlockShape | null {
  const { family, variant } = block;
  if (typeof family !== 'string' || typeof variant !== 'string') return null;
  const paths = keyPaths(block);
  return { key: `${family}/${variant}`, signature: hashPaths(paths), paths };
}
