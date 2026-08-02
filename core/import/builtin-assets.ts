// Built-in ("library") assets — Rise's own stock media, as opposed to media the
// account uploaded.
//
// Two shapes occur in a course document:
//   1. A host-RELATIVE library key: `assets/rise/assets/<pack>/<file>` (course
//      cover cells of the sample courses, block defaults). The runtime resolves
//      it against ITS OWN plane's CDN, so the same string means the US asset on
//      a US course and the EU asset on an EU course.
//   2. An ABSOLUTE url: `https://cdn[.eu].articulate.com/assets/…` (theme cover
//      images, block-default thumbnails/posters) — carries an explicit plane.
//
// Neither is re-uploadable: there is no account-owned copy to move, and the
// import must NOT invent one (a library asset missing on the target plane may be
// missing for licensing reasons — that's an operator decision, not ours).
//
// We therefore COPY built-in references verbatim, and we do NOT rewrite hosts on
// faith: whether a plane serves a given library path is unverified (every
// captured built-in url in this repo is EU-plane). The import PROBES the target
// plane for each distinct reference and flags the ones it cannot confirm, so a
// silently-broken image is impossible. See `docs/rise-import-protocol.md`.

/** Host-relative library key: `assets/rise/…` (no scheme, no host). */
export function isLibraryKey(value: unknown): value is string {
  return typeof value === 'string' && /^assets\/rise\//i.test(value);
}

/** Absolute built-in url on a Rise CDN/image host: `…/assets/…`. NOT an
 *  account upload (`rise/courses/<id>/…` lives on usercontent, not here). */
export function isBuiltinUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^https:\/\/(?:cdn|images)(?:\.eu)?\.articulate\.com\/assets\//i.test(value)
  );
}

/** Plane a built-in url points at (`.eu.` → eu, else us). */
export function planeOfBuiltinUrl(url: string): 'us' | 'eu' | null {
  if (!isBuiltinUrl(url)) return null;
  return /\.eu\.articulate\.com/i.test(url) ? 'eu' : 'us';
}

export interface BuiltinRef {
  /** The value exactly as it appears in the document. */
  value: string;
  kind: 'library-key' | 'absolute-url';
  /** Plane the value hard-codes (absolute urls only). */
  plane?: 'us' | 'eu';
  /** JSON path of the first occurrence (diagnostics / operator location). */
  path: string;
}

/**
 * Every DISTINCT built-in reference in a document (generic recursive walk, per
 * the "never a per-block-type walk" convention). Deduped by value; the first
 * path found is kept.
 */
export function collectBuiltinRefs(doc: unknown): BuiltinRef[] {
  const out = new Map<string, BuiltinRef>();
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (isLibraryKey(node)) {
        if (!out.has(node)) out.set(node, { value: node, kind: 'library-key', path });
      } else if (isBuiltinUrl(node)) {
        if (!out.has(node)) {
          const plane = planeOfBuiltinUrl(node) ?? undefined;
          out.set(node, { value: node, kind: 'absolute-url', ...(plane ? { plane } : {}), path });
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(doc, '$');
  return [...out.values()];
}

/** CDN base for a plane (built-in assets are served from the plane's cdn host). */
export function builtinCdnBase(plane: 'us' | 'eu'): string {
  return plane === 'eu' ? 'https://cdn.eu.articulate.com' : 'https://cdn.articulate.com';
}

/**
 * The url to PROBE on the target plane for a reference:
 *  - a library key resolves against the target plane's cdn;
 *  - an absolute url keeps its path but swaps to the target plane's host (that
 *    is what a rewrite WOULD produce — we only probe it, never ship it unverified).
 * Returns null when the value isn't a built-in reference.
 */
export function builtinProbeUrl(value: string, targetPlane: 'us' | 'eu'): string | null {
  if (isLibraryKey(value)) return `${builtinCdnBase(targetPlane)}/${value}`;
  if (isBuiltinUrl(value)) {
    // Preserve the sub-host (cdn vs images) while swapping the plane segment.
    const m = /^https:\/\/(cdn|images)(?:\.eu)?\.articulate\.com(\/.*)$/i.exec(value);
    if (!m) return null;
    const host =
      targetPlane === 'eu' ? `${m[1]}.eu.articulate.com` : `${m[1]}.articulate.com`;
    return `https://${host}${m[2]}`;
  }
  return null;
}

/** Any account-uploaded key inside a value tree (`rise/courses|questionBanks/…`). */
export function hasUploadedKey(node: unknown): boolean {
  if (typeof node === 'string') return /^rise\/(?:courses|questionBanks)\//.test(node);
  if (Array.isArray(node)) return node.some(hasUploadedKey);
  if (node && typeof node === 'object') {
    return Object.values(node as Record<string, unknown>).some(hasUploadedKey);
  }
  return false;
}

/** Any built-in reference inside a value tree. */
export function hasBuiltinRef(node: unknown): boolean {
  if (typeof node === 'string') return isLibraryKey(node) || isBuiltinUrl(node);
  if (Array.isArray(node)) return node.some(hasBuiltinRef);
  if (node && typeof node === 'object') {
    return Object.values(node as Record<string, unknown>).some(hasBuiltinRef);
  }
  return false;
}

/**
 * How a course-level image object must be treated:
 *  - `uploaded`  — holds account media → upload + remap (existing path);
 *  - `builtin`   — library/CDN reference only → copy VERBATIM (nothing to
 *                  upload), probe the target plane, flag if unverified;
 *  - `none`      — no media at all (absent/empty object) → nothing to do.
 * `uploaded` wins when both are present (the upload path also copies the rest).
 */
export function courseImageKind(img: unknown): 'uploaded' | 'builtin' | 'none' {
  if (hasUploadedKey(img)) return 'uploaded';
  if (hasBuiltinRef(img)) return 'builtin';
  return 'none';
}

export interface BuiltinProbeResult {
  value: string;
  /** true = the TARGET plane serves it; false = it does not; null = inconclusive
   *  (network error / unexpected status). false and null are both "unverified". */
  available: boolean | null;
  probedUrl: string;
  status?: number;
}

/**
 * Probe distinct references against the target plane, deduped and cached.
 * `fetchHead` is injected (the panel does a direct CDN request — a public byte
 * transfer, outside the pacing invariant). Never throws: a failed probe is
 * `available: null`, which callers treat as unverified.
 */
export async function probeBuiltinRefs(
  values: Iterable<string>,
  targetPlane: 'us' | 'eu',
  fetchHead: (url: string) => Promise<{ ok: boolean; status: number }>,
  cache?: Map<string, BuiltinProbeResult>,
): Promise<BuiltinProbeResult[]> {
  const out: BuiltinProbeResult[] = [];
  const seen = new Set<string>();
  // Distinct VALUES can resolve to the same target url (e.g. the same library
  // path expressed as a relative key and as a source-plane absolute url) — one
  // request per url, results reported per value.
  const byUrl = new Map<string, BuiltinProbeResult>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    const cached = cache?.get(value);
    if (cached) {
      out.push(cached);
      continue;
    }
    const probedUrl = builtinProbeUrl(value, targetPlane);
    if (!probedUrl) continue;
    const sameUrl = byUrl.get(probedUrl);
    if (sameUrl) {
      const shared: BuiltinProbeResult = { ...sameUrl, value };
      cache?.set(value, shared);
      out.push(shared);
      continue;
    }
    let result: BuiltinProbeResult;
    try {
      const r = await fetchHead(probedUrl);
      result = {
        value,
        probedUrl,
        status: r.status,
        // Only a 2xx proves availability. A 403/404 proves absence. Anything
        // else (0, 5xx, opaque) is inconclusive → unverified, never "missing".
        available: r.ok ? true : r.status === 403 || r.status === 404 ? false : null,
      };
    } catch {
      result = { value, probedUrl, available: null };
    }
    cache?.set(value, result);
    byUrl.set(probedUrl, result);
    out.push(result);
  }
  return out;
}
