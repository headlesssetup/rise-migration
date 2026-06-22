// Phase 3 — client-generated ids + the old→new remap map.
//
// Block ids, item ids, question ids and answer ids are CLIENT-generated
// (rise-import-protocol.md §6). Rise's are cuid-style: 25 lowercase
// alphanumeric chars, leading `c` (e.g. `cmqjv8g0g002i3b7oabdf4pav`). We mint
// fresh ids in that shape and record every source→target mapping so internal
// `refs` (`items:<itemId>/…`) stay valid and a resume never double-creates.
//
// Dependency-free (the codebase ships no runtime deps beyond React): a small
// cuid-style generator over a counter + time + randomness, injectable for
// deterministic tests.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function toBase36(n: number): string {
  if (n <= 0) return '0';
  let out = '';
  let v = Math.floor(n);
  while (v > 0) {
    out = ALPHABET[v % 36] + out;
    v = Math.floor(v / 36);
  }
  return out;
}

function randomBlock(rng: () => number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(rng() * 36)];
  }
  return out;
}

/**
 * A cuid-style id factory: `c` + base36(time) + base36(counter) + random,
 * padded/truncated to 25 chars. `now`/`rng` are injectable for tests. The
 * counter guards against collisions when many ids are minted in the same ms.
 */
export function createIdFactory(
  now: () => number = Date.now,
  rng: () => number = Math.random,
): () => string {
  let counter = Math.floor(rng() * 1e6);
  return () => {
    counter = (counter + 1) % 1e9;
    const time = toBase36(now());
    const count = toBase36(counter).padStart(4, '0');
    const body = `${time}${count}${randomBlock(rng, 25)}`.slice(0, 24);
    return `c${body}`;
  };
}

/** A frozen default factory for callers that don't need determinism. */
export const newId = createIdFactory();

/** True for a string shaped like a Rise client id (cuid-style). Loose by
 *  design — used only as a sanity assertion, never to reject real ids. */
export function looksLikeClientId(s: unknown): s is string {
  return typeof s === 'string' && /^[a-z][a-z0-9]{20,30}$/.test(s);
}

/**
 * The old→new id map for one import run. Records every source id we remap
 * (folders, banks, questions/answers, course, lessons, blocks, item ids, asset
 * keys) so refs stay consistent and a resumed run skips already-created things.
 * Serializable to storage (the resumable job log, protocol §6).
 */
export class IdMap {
  private map = new Map<string, string>();

  constructor(
    private readonly mint: () => string = newId,
    entries?: Iterable<[string, string]>,
  ) {
    if (entries) for (const [k, v] of entries) this.map.set(k, v);
  }

  /** Existing target id for a source id, or undefined. */
  get(oldId: string): string | undefined {
    return this.map.get(oldId);
  }

  has(oldId: string): boolean {
    return this.map.has(oldId);
  }

  /** Record an explicit mapping (e.g. a server-assigned course/lesson/bank id). */
  set(oldId: string, newId: string): string {
    this.map.set(oldId, newId);
    return newId;
  }

  /** Get the mapped id, minting + recording a fresh client id on first sight.
   *  Idempotent: the same source id always yields the same target id. */
  remap(oldId: string): string {
    const existing = this.map.get(oldId);
    if (existing !== undefined) return existing;
    return this.set(oldId, this.mint());
  }

  /** Number of recorded mappings. */
  get size(): number {
    return this.map.size;
  }

  /** Plain object for the persisted job log. */
  toJSON(): Record<string, string> {
    return Object.fromEntries(this.map);
  }

  /** Rehydrate from a persisted job log (resume). */
  static fromJSON(
    obj: Record<string, string>,
    mint: () => string = newId,
  ): IdMap {
    return new IdMap(mint, Object.entries(obj));
  }
}
