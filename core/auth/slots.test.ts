// F0 regression tests (findings-2026-08-04-us-run.md): the cross-plane token
// poisoning loop must stay closed — the sniffer never captures a header we
// attached ourselves, and a known-plane request never borrows the other
// plane's bearer.

import { describe, expect, it } from 'vitest';
import { bearerForPlane, noTokenForPlaneMessage, otherPlane, shouldCaptureBearer } from './slots';

const EU = 'eu-token.jwt.value';
const US = 'us-token.jwt.value';

describe('shouldCaptureBearer (sniffer self-capture guard)', () => {
  it('captures a genuine SPA bearer into an empty slot', () => {
    expect(shouldCaptureBearer('us', US, { us: null, eu: null })).toBe(true);
  });

  it('captures a rotated bearer for the same plane', () => {
    expect(shouldCaptureBearer('us', 'us-token.rotated', { us: US, eu: EU })).toBe(true);
  });

  it('re-observing the plane`s own current token stays capturable (no-op set)', () => {
    expect(shouldCaptureBearer('eu', EU, { us: US, eu: EU })).toBe(true);
  });

  it('NEVER captures the other plane`s held token (the F0 poisoning loop)', () => {
    // The exact live failure: auth.us empty, our relayed US request carried the
    // EU bearer via the old fallback; the sniffer must not store it as US.
    expect(shouldCaptureBearer('us', EU, { us: null, eu: EU })).toBe(false);
    // Same with a stale-but-present own slot.
    expect(shouldCaptureBearer('us', EU, { us: US, eu: EU })).toBe(false);
  });

  it('degenerate: identical token legitimately in BOTH slots is still capturable', () => {
    expect(shouldCaptureBearer('us', US, { us: US, eu: US })).toBe(true);
  });
});

describe('bearerForPlane (no cross-plane fallback)', () => {
  it('returns the plane`s own token', () => {
    expect(bearerForPlane('eu', { us: US, eu: EU }, 'us')).toBe(EU);
  });

  it('returns null for an empty slot even when the other plane has a token', () => {
    expect(bearerForPlane('us', { us: null, eu: EU }, 'eu')).toBeNull();
  });

  it('plane-less callers keep the latest-plane fallback (display paths)', () => {
    expect(bearerForPlane(null, { us: null, eu: EU }, 'eu')).toBe(EU);
    expect(bearerForPlane(null, { us: null, eu: EU }, null)).toBeNull();
  });
});

describe('helpers', () => {
  it('otherPlane flips', () => {
    expect(otherPlane('us')).toBe('eu');
    expect(otherPlane('eu')).toBe('us');
  });

  it('empty-slot message names the plane and the course-editor instruction', () => {
    const msg = noTokenForPlaneMessage('us');
    expect(msg).toContain('US plane');
    expect(msg).toMatch(/course EDITOR/);
    expect(msg).toMatch(/dashboard/);
  });
});
