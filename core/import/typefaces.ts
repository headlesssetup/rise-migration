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
  /** SHARED IN from another tenant (not in the source account's own list; the
   *  export resolved it per course — see core/census/typefaces mergeForeign…).
   *  Someone else's asset: recreated on the target only on operator opt-in. */
  foreign?: boolean;
  /** The course the export resolved a foreign typeface through. */
  sharedVia?: string;
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
    out.set(id, {
      id,
      name,
      isDefault: t.default === true,
      fonts,
      ...(t.foreign === true ? { foreign: true } : {}),
      ...(typeof t.sharedVia === 'string' ? { sharedVia: t.sharedVia } : {}),
    });
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

/** The typeface ids that actually DRIVE the course's fonts. The top-level
 *  heading/body/ui slots are authoritative (envelopes §7); `theme.*TypefaceId`
 *  can be stale leftovers of the theme the course was duplicated from
 *  (mig30oct Führungssparring: two ids that resolve nowhere). The theme copies
 *  count only when the course has no top-level slot at all. */
export function authoritativeTypefaceIds(course: Record<string, unknown>): Set<string> {
  const pick = (src: Record<string, unknown>): string[] =>
    ['headingTypefaceId', 'bodyTypefaceId', 'uiTypefaceId']
      .map((k) => src[k])
      .filter((v): v is string => typeof v === 'string' && v !== '');
  const top = pick(course);
  return new Set(top.length ? top : pick((course.theme ?? {}) as Record<string, unknown>));
}

/** `course.typefaces` — every GET_COURSE carries `{<typefaceId>: <name>}` for
 *  the fonts the course binds, even fonts the account does not own (shared in
 *  from another tenant: mig30oct "DB Head"/"DB Sans"). */
export function courseTypefaceNames(course: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const t = course.typefaces;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    for (const [id, name] of Object.entries(t as Record<string, unknown>)) {
      if (typeof name === 'string' && name.trim()) out.set(id, name.trim());
    }
  }
  return out;
}

/** Whitespace/case-insensitive name key ("DBNeoScreenSans" = "DB Neo Screen Sans"). */
function looseName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '');
}

/** Look a font NAME up on the target: exact (case-folded) first, then
 *  ignoring spacing — the same font is often named both ways. */
export function lookupTargetByName(targetNames: Map<string, string>, name: string): string | undefined {
  const exact = targetNames.get(name.trim().toLowerCase());
  if (exact) return exact;
  const loose = looseName(name);
  for (const [k, id] of targetNames) if (looseName(k) === loose) return id;
  return undefined;
}

/** First word of a font name, splitting camel case ("DBNeoScreenSans" → "db"). */
function firstToken(name: string): string {
  const spaced = name.trim().replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return (spaced.split(/[\s_-]+/)[0] ?? '').toLowerCase();
}

/** Target fonts that LOOK related (same first word, e.g. "DB Head" → "DB Neo
 *  Screen Head") — a hint for the operator, never applied automatically. */
export function similarTargetNames(name: string, target: Map<string, Typeface>): string[] {
  const tok = firstToken(name);
  if (tok.length < 2) return [];
  const out = new Set<string>();
  for (const t of target.values()) {
    if (!t.isDefault && firstToken(t.name) === tok && looseName(t.name) !== looseName(name)) out.add(t.name);
  }
  return [...out].sort();
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
  /** Shared-in (foreign-tenant) typefaces the target lacks, HELD because the
   *  operator did not opt in to re-hosting them → flag, never recreated. */
  foreignHeld: Typeface[];
}

/**
 * Decide, for each used typeface id, whether it maps to an existing target
 * typeface (by name) or must be recreated. Pure — no network.
 */
export function resolveTypefaces(
  usedIds: string[],
  sourceById: Map<string, Typeface>,
  targetNames: Map<string, string>,
  opts: {
    /** Operator opt-in: recreate typefaces shared in from another tenant. A
     *  foreign font is someone else's asset (licensing), so the default is to
     *  HOLD it (flag) — the same reasoning as built-in library assets. */
    rehostForeign?: boolean;
    /** `course.typefaces` id → name: lets an id with no source catalog entry
     *  still match a target font of the same name. */
    courseNames?: Map<string, string>;
  } = {},
): TypefaceResolution {
  const idMap = new Map<string, string>();
  const toRecreate: Typeface[] = [];
  const seenRecreate = new Set<string>();
  const unresolved: string[] = [];
  const foreignHeld: Typeface[] = [];

  for (const id of usedIds) {
    const src = sourceById.get(id);
    if (!src) {
      // No catalog entry (shared in, never resolved) — the course's own name
      // for it can still match a target font that was provisioned by hand.
      const name = opts.courseNames?.get(id);
      const byName = name ? lookupTargetByName(targetNames, name) : undefined;
      if (byName) idMap.set(id, byName);
      else unresolved.push(id);
      continue;
    }
    const targetId = lookupTargetByName(targetNames, src.name);
    if (targetId) {
      idMap.set(id, targetId); // matched by name (built-in or already-uploaded)
      continue;
    }
    // Not on target. Recreatable iff it's a custom font with uploadable files.
    const recreatable = !isBuiltinFont(src) && src.fonts.some((f) => f.key.startsWith('rise/'));
    if (recreatable) {
      if (seenRecreate.has(id)) continue;
      seenRecreate.add(id);
      if (src.foreign && !opts.rehostForeign) foreignHeld.push(src);
      else toRecreate.push(src);
    } else {
      unresolved.push(id);
    }
  }
  return { idMap, toRecreate, unresolved, foreignHeld };
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
