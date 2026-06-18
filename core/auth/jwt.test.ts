import { describe, expect, it } from 'vitest';
import { decodeJwt, identityFromToken, isExpired } from './jwt';

// Build a fake JWT: header.payload.signature (base64url, unsigned — decode only).
function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}

describe('jwt', () => {
  it('decodes payload claims', () => {
    const token = makeJwt({ sub: 'u1', email: 'a@b.com', exp: 1700000000 });
    expect(decodeJwt(token)).toMatchObject({ sub: 'u1', email: 'a@b.com' });
  });

  it('returns null on malformed input', () => {
    expect(decodeJwt('not-a-jwt')).toBeNull();
    expect(decodeJwt('')).toBeNull();
  });

  it('maps claims to an Identity with ms-epoch expiry', () => {
    const token = makeJwt({ sub: 'u1', name: 'Jo', exp: 1700000000 });
    const id = identityFromToken(token);
    expect(id).toEqual({
      sub: 'u1',
      email: undefined,
      name: 'Jo',
      expiresAt: 1700000000 * 1000,
    });
  });

  it('detects expiry', () => {
    const id = identityFromToken(makeJwt({ exp: 1000 }));
    expect(isExpired(id, 2000 * 1000)).toBe(true);
    expect(isExpired(id, 0)).toBe(false);
    expect(isExpired(null)).toBe(false);
  });
});
