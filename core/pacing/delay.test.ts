import { describe, expect, it } from 'vitest';
import { DEFAULT_PACING, nextDelayMs } from './delay';

describe('nextDelayMs', () => {
  it('returns base with zero jitter draw (rng=0.5)', () => {
    expect(nextDelayMs(DEFAULT_PACING, () => 0.5)).toBe(1600);
  });

  it('applies negative jitter at rng=0', () => {
    expect(nextDelayMs({ baseMs: 2000, jitterMs: 750 }, () => 0)).toBe(1250);
  });

  it('applies positive jitter at rng=1', () => {
    expect(nextDelayMs({ baseMs: 2000, jitterMs: 750 }, () => 1)).toBe(2750);
  });

  it('never returns a negative delay', () => {
    expect(nextDelayMs({ baseMs: 100, jitterMs: 1000 }, () => 0)).toBe(0);
  });
});
