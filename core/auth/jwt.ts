// Decode the bearer JWT (Okta) for identity display only. We never mint or
// persist credentials — this just reads claims from a token captured live.

export interface JwtClaims {
  sub?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  exp?: number;
  iat?: number;
  [k: string]: unknown;
}

export interface Identity {
  sub?: string;
  email?: string;
  name?: string;
  /** Token expiry as ms-epoch (from `exp`). */
  expiresAt?: number;
}

function base64UrlDecode(input: string): string {
  let b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Decode the JWT payload segment. Returns null on any malformed input. */
export function decodeJwt(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1])) as JwtClaims;
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Auth0 tokens often carry email/name only under namespaced custom claims
// (e.g. `https://articulate.com/email`), so scan beyond the standard keys.
function findEmail(c: JwtClaims): string | undefined {
  if (typeof c.email === 'string') return c.email;
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === 'string' && /email$/i.test(k) && EMAIL_RE.test(v)) return v;
  }
  for (const v of Object.values(c)) {
    if (typeof v === 'string' && EMAIL_RE.test(v)) return v;
  }
  return undefined;
}

function findName(c: JwtClaims): string | undefined {
  for (const k of ['name', 'nickname', 'given_name', 'preferred_username']) {
    const v = c[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === 'string' && /\/(name|nickname)$/i.test(k)) return v;
  }
  return undefined;
}

export function identityFromToken(token: string): Identity | null {
  const c = decodeJwt(token);
  if (!c) return null;
  return {
    sub: typeof c.sub === 'string' ? c.sub : undefined,
    email: findEmail(c),
    name: findName(c),
    expiresAt: typeof c.exp === 'number' ? c.exp * 1000 : undefined,
  };
}

export function isExpired(identity: Identity | null, now: number = Date.now()): boolean {
  return identity?.expiresAt !== undefined && identity.expiresAt <= now;
}
