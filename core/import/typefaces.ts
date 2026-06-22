// Phase 4 — typography migration (pure logic).
//
// Typeface ids are ACCOUNT-SPECIFIC (even built-ins: each account has its own id
// for "Lato"). A course's theme references heading/body/ui typeface ids that
// won't resolve on the target — the cause of "wrong font face" after import. The
// fix: match typefaces by NAME against the target account's FETCH_TYPEFACES
// (dedups built-ins AND brand fonts already uploaded), and RECREATE any custom
// font the target lacks (upload its .woff files → CREATE_TYPEFACE). This module
// is the pure decision layer; the executor performs the uploads/creates.
//
// Shapes from the captures:
//   FETCH_TYPEFACES → {typefaces:[{id,name,default,deleted,fonts:[{key,style,original}]}]}
//   built-in fonts:  default:true, key `assets/rise/fonts/…` (shared, never recreated)
//   custom fonts:    key `rise/fonts/…`, `original` filename present

export interface SourceFont {
  key: string;
  style: string;
  original: string | null;
}
export interface Typeface {
  id: string;
  name: string;
  isDefault: boolean;
  fonts: SourceFont[];
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    const t = (v as Record<string, unknown>).typefaces;
    if (Array.isArray(t)) return t;
    const p = (v as Record<string, unknown>).payload;
    if (p) return asArray(p);
  }
  return [];
}

/** Parse a FETCH_TYPEFACES doc (or its `payload`) into typefaces by id. */
export function parseTypefaces(doc: unknown): Map<string, Typeface> {
  const out = new Map<string, Typeface>();
  for (const raw of asArray(doc)) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    const id = typeof t.id === 'string' ? t.id : '';
    const name = typeof t.name === 'string' ? t.name : '';
    if (!id || !name || t.deleted === true) continue;
    const fonts: SourceFont[] = Array.isArray(t.fonts)
      ? (t.fonts as Record<string, unknown>[])
          .filter((f) => f && typeof f.key === 'string')
          .map((f) => ({
            key: f.key as string,
            style: typeof f.style === 'string' ? f.style : 'regular',
            original: typeof f.original === 'string' ? f.original : null,
          }))
      : [];
    out.set(id, { id, name, isDefault: t.default === true, fonts });
  }
  return out;
}

/** A built-in/default font lives under the shared `assets/rise/...` namespace and
 *  exists on every account — never recreated, only matched by name. */
export function isBuiltinFont(tf: Typeface): boolean {
  return tf.isDefault || tf.fonts.every((f) => f.key.startsWith('assets/'));
}

/** Map target typeface name (case-folded) → target id. */
export function targetByName(target: Map<string, Typeface>): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of target.values()) m.set(t.name.trim().toLowerCase(), t.id);
  return m;
}

/** The distinct typeface ids a course actually uses (top-level course fields +
 *  the theme's own copies). */
export function usedTypefaceIds(course: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const theme = (course.theme ?? {}) as Record<string, unknown>;
  for (const src of [course, theme]) {
    for (const k of ['headingTypefaceId', 'bodyTypefaceId', 'uiTypefaceId']) {
      const v = src[k];
      if (typeof v === 'string' && v) ids.add(v);
    }
  }
  return [...ids];
}

export interface TypefaceResolution {
  /** source typeface id → target typeface id (only the already-resolvable ones:
   *  matched by name on the target). Recreated fonts are added by the executor. */
  idMap: Map<string, string>;
  /** Custom typefaces missing on the target → recreate (upload + CREATE_TYPEFACE). */
  toRecreate: Typeface[];
  /** Used ids we couldn't resolve (no source catalog entry, no name match, no
   *  recreatable fonts) → flag for manual handling. */
  unresolved: string[];
}

/**
 * Decide, for each used typeface id, whether it maps to an existing target
 * typeface (by name) or must be recreated. Pure — no network.
 */
export function resolveTypefaces(
  usedIds: string[],
  sourceById: Map<string, Typeface>,
  targetNames: Map<string, string>,
): TypefaceResolution {
  const idMap = new Map<string, string>();
  const toRecreate: Typeface[] = [];
  const seenRecreate = new Set<string>();
  const unresolved: string[] = [];

  for (const id of usedIds) {
    const src = sourceById.get(id);
    if (!src) {
      unresolved.push(id);
      continue;
    }
    const targetId = targetNames.get(src.name.trim().toLowerCase());
    if (targetId) {
      idMap.set(id, targetId); // matched by name (built-in or already-uploaded)
      continue;
    }
    // Not on target. Recreatable iff it's a custom font with uploadable files.
    const recreatable = !isBuiltinFont(src) && src.fonts.some((f) => f.key.startsWith('rise/'));
    if (recreatable) {
      if (!seenRecreate.has(id)) {
        seenRecreate.add(id);
        toRecreate.push(src);
      }
    } else {
      unresolved.push(id);
    }
  }
  return { idMap, toRecreate, unresolved };
}

/** Build the `CREATE_TYPEFACE` `fonts` object from a source typeface and the
 *  per-source-key upload results (new key/url/type from GET_YURL). Keyed by
 *  `typeface-<style>`, mirroring the captured request shape. */
export function buildCreateTypefaceFonts(
  tf: Typeface,
  uploaded: Map<string, { key: string; url: string; type: string; filename: string }>,
): Record<string, unknown> {
  const fonts: Record<string, unknown> = {};
  for (const f of tf.fonts) {
    const up = uploaded.get(f.key);
    if (!up) continue; // a font file that failed to upload is skipped
    const slot = `typeface-${f.style}`;
    fonts[slot] = {
      id: slot,
      status: 'complete',
      progress: 100,
      key: up.key,
      type: up.type,
      filename: up.filename,
      url: up.url,
      original: f.original ?? up.filename,
      style: f.style,
    };
  }
  return fonts;
}

/** Apply the resolved id map to a course's theme + return the top-level typeface
 *  ids to send on UPDATE_COURSE. Unmapped ids are left as-is (best effort). */
export function applyTypefaceIds(
  course: Record<string, unknown>,
  theme: Record<string, unknown>,
  idMap: Map<string, string>,
): {
  theme: Record<string, unknown>;
  headingTypefaceId?: string;
  bodyTypefaceId?: string;
  uiTypefaceId?: string;
} {
  const map = (v: unknown): string | undefined =>
    typeof v === 'string' ? idMap.get(v) ?? v : undefined;
  const nextTheme = { ...theme };
  for (const k of ['headingTypefaceId', 'bodyTypefaceId', 'uiTypefaceId']) {
    if (typeof theme[k] === 'string') nextTheme[k] = idMap.get(theme[k] as string) ?? theme[k];
  }
  return {
    theme: nextTheme,
    headingTypefaceId: map(course.headingTypefaceId ?? theme.headingTypefaceId),
    bodyTypefaceId: map(course.bodyTypefaceId ?? theme.bodyTypefaceId),
    uiTypefaceId: map(course.uiTypefaceId ?? theme.uiTypefaceId),
  };
}
