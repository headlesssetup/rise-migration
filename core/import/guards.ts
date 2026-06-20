// Phase 3 — safe-import gates (rise-import-protocol.md §11). Import is never the
// default; before any write we must (a) know the live TARGET account/plane and
// (b) guarantee the operator isn't writing back into the SOURCE account. These
// are pure decision functions; the panel wires them to UI confirmations.

/** Identity of an account/plane, on either side of a migration. */
export interface AccountIdentity {
  /** Display name from the Rise header / export manifest. */
  name?: string | null;
  /** JWT `sub` (stable user id), when available. */
  sub?: string | null;
  /** Email, when available. */
  email?: string | null;
  /** 'us' | 'eu' — derived from the Rise tab host. */
  plane?: 'us' | 'eu' | null;
}

/** Source identity recorded in the archive's `manifest.json` (export side). */
export interface SourceManifestIdentity {
  sourceAccount?: AccountIdentity;
}

/** Derive the plane from a Rise tab URL/host (us vs eu). */
export function planeFromHost(host: string | undefined | null): 'us' | 'eu' | null {
  if (!host) return null;
  return /(^|\.)rise\.eu\.|\.eu\.articulate\.com/i.test(host) ? 'eu' : 'us';
}

export type GuardVerdict =
  | { ok: true; reason: string }
  | { ok: false; reason: string; sameAccount: boolean; samePlane: boolean };

/**
 * Source ≠ Target guard. Refuses to write into the same account (and warns on
 * same plane) unless explicitly overridden. Matching is by `sub` when both
 * sides expose it (strongest), else by case-folded name.
 */
export function checkSourceNotTarget(
  source: AccountIdentity | undefined,
  target: AccountIdentity | undefined,
  override = false,
): GuardVerdict {
  if (!target) {
    return {
      ok: false,
      reason: 'No live target account detected — open and log into the target Rise tab.',
      sameAccount: false,
      samePlane: false,
    };
  }
  if (!source) {
    // No recorded source identity (older archive): allow but the UI should warn.
    return {
      ok: true,
      reason: 'Source identity not recorded in manifest — verify the target manually.',
    };
  }

  const sameSub =
    !!source.sub && !!target.sub && source.sub === target.sub;
  const sameName =
    !!source.name &&
    !!target.name &&
    source.name.trim().toLowerCase() === target.name.trim().toLowerCase();
  const sameAccount = sameSub || (!source.sub && !target.sub && sameName);
  const samePlane =
    !!source.plane && !!target.plane && source.plane === target.plane;

  if (sameAccount && !override) {
    return {
      ok: false,
      reason:
        'Target is the SAME account as the source. Importing here would write into the source account. Override only if you are certain.',
      sameAccount: true,
      samePlane,
    };
  }
  if (sameAccount && override) {
    return { ok: true, reason: 'Same-account write explicitly overridden by operator.' };
  }
  return {
    ok: true,
    reason: samePlane
      ? `Target "${target.name ?? 'unknown'}" differs from source — same plane (${target.plane}).`
      : `Target "${target.name ?? 'unknown'}" differs from source.`,
  };
}

/** A short, human confirmation line shown on the target-account gate before any
 *  write ("write into THIS account?"). */
export function describeTarget(target: AccountIdentity | undefined): string {
  if (!target) return 'No target account detected.';
  const plane = target.plane ? target.plane.toUpperCase() : 'unknown plane';
  return `${target.name ?? target.email ?? 'unknown account'} — ${plane}`;
}
