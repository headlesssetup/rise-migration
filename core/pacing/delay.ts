// Human-paced delay helper. CLAUDE.md invariant: never look like a scraper —
// ~2s base between every request (course fetch OR list page) with randomized
// jitter so the cadence isn't robotic. One shared helper, fully configurable.

export interface PacingConfig {
  /** Base delay between sequential requests, in ms. */
  baseMs: number;
  /** Symmetric jitter: actual delay is baseMs ± up to jitterMs. */
  jitterMs: number;
}

export const DEFAULT_PACING: PacingConfig = { baseMs: 2000, jitterMs: 750 };

/** Compute the next delay (pure; inject `rng` for deterministic tests). */
export function nextDelayMs(
  cfg: PacingConfig = DEFAULT_PACING,
  rng: () => number = Math.random,
): number {
  const jitter = (rng() * 2 - 1) * cfg.jitterMs;
  return Math.max(0, Math.round(cfg.baseMs + jitter));
}

/** Await a single human-paced gap. */
export function pacedDelay(
  cfg: PacingConfig = DEFAULT_PACING,
  rng: () => number = Math.random,
): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, nextDelayMs(cfg, rng)));
}
