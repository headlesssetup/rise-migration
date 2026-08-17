// Phase 3 — safe-import gates (rise-import-protocol.md §11). Import is never the
// default; before any write we must (a) know the live TARGET account/plane and
// (b) guarantee the operator isn't writing back into the SOURCE account. These
// are pure decision functions; the panel wires them to UI confirmations.

/** Identity of an account/plane, on either side of a migration. */
export interface AccountIdentity {
  /** Display name from the Rise header / export manifest. */
  name?: string | null;
  /** JWT `sub` (stable signed-in USER id), when available. It is not a Rise
   *  account/tenant id: one person may use the same `sub` on both planes. */
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
 * same plane) unless explicitly overridden. Two known different planes are
 * different Rise accounts, but a matching signed-in user id still blocks: when
 * the operator expects different people, that match proves the target token is
 * stale or mis-filled. Within one plane, a case-folded name is also evidence.
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

  const sourcePlane = source.plane;
  const targetPlane = target.plane;
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
  const samePlane =
    !!source.plane && !!target.plane && source.plane === target.plane;
  const differentKnownPlanes =
    !!sourcePlane && !!targetPlane && sourcePlane !== targetPlane;
  // A user-id match is suspicious on every plane combination. A display-name
  // match is weaker and only blocks within the same data plane; independent US
  // and EU accounts may legitimately use the same organization name.
  const sameAccount = sameSub || (samePlane && sameName);

  if (sameAccount && !override) {
    const matchedBy: 'sub' | 'name' = sameSub ? 'sub' : 'name';
    // Names present AND different, yet the JWT sub matched: the cached bearer
    // almost certainly predates an account switch. Say so — the operator would
    // otherwise see two different names above a "same account" verdict.
    const namesDiffer = !!source.name && !!target.name && !sameName;
    const detail =
      matchedBy === 'sub'
        ? namesDiffer || differentKnownPlanes
          ? `the target token carries the source signed-in user id (JWT sub)` +
            `${namesDiffer ? ` while the displayed names differ ("${source.name}" vs "${target.name}")` : ''}` +
            `${differentKnownPlanes ? ` across different planes (${sourcePlane!.toUpperCase()} → ${targetPlane!.toUpperCase()})` : ''}` +
            ' — the target token is stale or mis-filled if these are different people: reload the target Rise COURSE EDITOR tab and re-check; do not override'
          : // A sub match with matching/absent names is either a genuine
            // same-account write OR a target token slot holding the SOURCE
            // account's bearer (stale, or — pre-F0 — cross-plane-poisoned).
            // Either way the run would write with the source's credentials, so
            // the remedy is the same: refresh the target slot, don't override.
            'matched by signed-in user id (JWT sub) — if the target tab really is a different account, its token slot is stale or mis-filled: reload the target Rise COURSE EDITOR tab and re-check before overriding'
        : `matched by account name ("${target.name}")`;
    return {
      ok: false,
      reason: `Target authentication is not safely distinct from the source (${detail}). Importing now could use the wrong identity.`,
      sameAccount: true,
      samePlane,
      matchedBy,
    };
  }
  if (sameAccount && override) {
    return { ok: true, reason: 'Source/target identity match explicitly overridden by operator.' };
  }
  if (differentKnownPlanes) {
    return {
      ok: true,
      reason:
        `Target "${target.name ?? 'unknown'}" differs from source — ` +
        `different Rise planes (${sourcePlane.toUpperCase()} → ${targetPlane.toUpperCase()}).`,
    };
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
