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
  /** Account-local Rise user id (`_articulate_user_id` cookie) — the valid
   *  principal for folder ownership (differs from `sub` on a cross-plane
   *  session). Target side only. */
  userId?: string | null;
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
  | {
      ok: false;
      reason: string;
      sameAccount: boolean;
      samePlane: boolean;
      /** Which evidence matched — shown to the operator so a same-account
       *  verdict is never a mystery. 'sub' with DIFFERENT display names means a
       *  stale cached identity (an account switch the background hadn't picked
       *  up) far more often than a real same-account write. */
      matchedBy?: 'sub' | 'name';
    };

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
  // Safety-biased: treat as same-account if the sub OR the display name matches.
  // A destructive write guard should over-block (operator can override) rather
  // than under-block — e.g. when the target tab's JWT identity isn't captured
  // yet (target.sub null) but the names plainly match.
  const sameAccount = sameSub || sameName;
  const samePlane =
    !!source.plane && !!target.plane && source.plane === target.plane;

  if (sameAccount && !override) {
    const matchedBy: 'sub' | 'name' = sameSub ? 'sub' : 'name';
    // Names present AND different, yet the JWT sub matched: the cached bearer
    // almost certainly predates an account switch. Say so — the operator would
    // otherwise see two different names above a "same account" verdict.
    const namesDiffer =
      !!source.name && !!target.name && !sameName;
    const detail =
      matchedBy === 'sub'
        ? namesDiffer
          ? `matched by signed-in user id (JWT sub) while the account names differ ("${source.name}" vs "${target.name}") — the captured token may predate an account switch: reload the target Rise COURSE EDITOR tab and re-check before overriding`
          : 'matched by signed-in user id (JWT sub)'
        : `matched by account name ("${target.name}")`;
    return {
      ok: false,
      reason: `Target looks like the SAME account as the source (${detail}). Importing here would write into the source account. Override only if you are certain.`,
      sameAccount: true,
      samePlane,
      matchedBy,
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
