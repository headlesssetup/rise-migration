// Merge helpers for the two ACCUMULATING archive indexes: `manifest.json`'s
// `courses` list and `_metadata/inventory.json`.
//
// Both are read back by consumers that assume they describe the whole archive —
// the import course picker reads `manifest.courses` (falling back to listSaved()
// only when it is empty), and the import's folder placement reads
// `inventory.json`. Writing only the current run's selection therefore HID
// courses whose JSON was already on disk (export 50 on Monday, 10 on Tuesday →
// the picker showed 10). Successive batches must union instead of overwrite.

/** One entry of `manifest.courses` (extra fields are preserved on merge). */
export interface ManifestCourseEntry {
  id: string;
  title?: string;
  [k: string]: unknown;
}

/** `next` wins field-by-field, but an `undefined` field must not erase a value
 *  already on disk (a re-listing that omits a title keeps the recorded one). */
function overlay<T extends object>(base: T, next: T): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(next)) if (v !== undefined) out[k] = v;
  return out as T;
}

/**
 * Union two id-keyed row lists. Existing rows keep their position, rows for new
 * ids are appended, and a row present in both keeps the newest metadata.
 */
export function mergeById<T extends { id: string }>(
  prev: readonly T[],
  next: readonly T[],
): T[] {
  const byId = new Map<string, T>();
  for (const row of prev) byId.set(row.id, row);
  for (const row of next) {
    const old = byId.get(row.id);
    byId.set(row.id, old ? overlay(old, row) : row);
  }
  return [...byId.values()];
}

function idRows<T extends { id: string }>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is T =>
      !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string',
  );
}

/**
 * Rows from a previously written JSON index (`inventory.json`). Tolerant of a
 * missing/corrupt file and of the `{items:[…]}` wrapper the import side also
 * accepts; anything without a string `id` is dropped. Never throws — a bad
 * index must not block a fresh export from writing a good one.
 */
export function parseIdRows<T extends { id: string }>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return idRows<T>(
      Array.isArray(parsed) ? parsed : (parsed as { items?: unknown } | null)?.items,
    );
  } catch {
    return [];
  }
}

/** The `courses` list recorded in a previously written `manifest.json`. */
export function parseManifestCourses(raw: string | null): ManifestCourseEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { courses?: unknown } | null;
    return idRows<ManifestCourseEntry>(parsed?.courses);
  } catch {
    return [];
  }
}
