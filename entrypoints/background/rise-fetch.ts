// The in-tab fetch function + its wire types — split out of the background
// entrypoint (v0.9.0 restructure). `fetchInRiseTab` is serialized into the
// Rise tab via executeScript({ func }): it MUST stay self-contained /
// closure-free (it may reference only page globals), which is also why it can
// live in any module without behavior change.

export interface InPageResult {
  ok: boolean;
  status: number;
  text?: string;
  error?: string;
  code?: 'AUTH_REQUIRED';
}

/** What relayFetch needs from a spec — RequestSpec (reads) or WriteSpec (writes).
 *  Write-only fields are optional so a read RequestSpec is assignable. */
export interface RelaySpec {
  url: string;
  method: string;
  body?: string;
  base64Body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  noAuth?: boolean;
  omitBearer?: boolean;
}

// Executed INSIDE the Rise tab (isolated world) — a same-origin fetch that
// rides the live session's first-party cookies, plus the bearer if we have it.
// Must be self-contained (no closures): it is serialized by executeScript.
//
// Phase 3 adds write support: PUT/DELETE, a base64 binary body (presigned S3
// upload — the same cross-origin PUT the real editor issues from the Rise page),
// an explicit Content-Type, and `noAuth` (the presigned url carries its own
// signature, so no bearer/cookies on the S3 PUT).
export async function fetchInRiseTab(
  spec: {
    url: string;
    method: string;
    body?: string;
    base64Body?: string;
    contentType?: string;
    headers?: Record<string, string>;
    noAuth?: boolean;
    omitBearer?: boolean;
  },
  token: string | null,
): Promise<InPageResult> {
  try {
    const headers: Record<string, string> = {};
    // noAuth: no bearer + no cookies (presigned S3). omitBearer: no bearer but
    // KEEP cookies (cookie-authed endpoints like build/raw, which 403 on a stale
    // bearer). Default: bearer + cookies.
    if (token && !spec.noAuth && !spec.omitBearer) headers.Authorization = `Bearer ${token}`;

    let body: BodyInit | undefined;
    if (spec.base64Body !== undefined) {
      const bin = atob(spec.base64Body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      body = new Blob([bytes], { type: spec.contentType || 'application/octet-stream' });
      if (spec.contentType) headers['Content-Type'] = spec.contentType;
    } else if (spec.body !== undefined) {
      body = spec.body;
      headers['Content-Type'] = spec.contentType || 'application/json';
    }
    // Explicit per-spec headers (e.g. Content-MD5 on a Review-360 upload PUT)
    // override the defaults above.
    if (spec.headers) Object.assign(headers, spec.headers);

    const res = await fetch(spec.url, {
      method: spec.method,
      headers,
      body,
      // Presigned S3 PUT is cross-origin and must NOT send cookies; rise.* calls
      // need first-party cookies. Gate credentials on noAuth.
      credentials: spec.noAuth ? 'omit' : 'include',
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}
