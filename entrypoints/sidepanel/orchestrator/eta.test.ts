import { describe, expect, it } from 'vitest';
import { etaStatus } from './shared';

describe('etaStatus', () => {
  it('returns null ETA until there is signal (>2% done AND >3s elapsed)', () => {
    // too early (only 1% done) → estimating
    expect(etaStatus({ label: 'x', doneFraction: 0.01, runStartMs: 0, nowMs: 10_000 }).etaSeconds).toBeNull();
    // enough done but <3s elapsed → estimating
    expect(etaStatus({ label: 'x', doneFraction: 0.5, runStartMs: 0, nowMs: 2_000 }).etaSeconds).toBeNull();
  });

  it('projects remaining seconds from elapsed and fraction', () => {
    // 25% done in 10s → ~30s remaining
    const e = etaStatus({ label: 'Importing 1/4', doneFraction: 0.25, runStartMs: 0, nowMs: 10_000 });
    expect(e).toMatchObject({ kind: 'import-status', label: 'Importing 1/4', done: false });
    expect(e.etaSeconds).toBe(30);
  });

  it('clamps the fraction to [0,1]', () => {
    expect(etaStatus({ label: 'x', doneFraction: 1.5, runStartMs: 0, nowMs: 10_000 }).etaSeconds).toBe(0);
  });
});
