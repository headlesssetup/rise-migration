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
