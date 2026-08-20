// Phase 3 — safe-import gates (rise-import-protocol.md §11). Import is never the
// default; before any write we must (a) know the live TARGET account/plane and
// (b) guarantee the operator isn't writing back into the SOURCE account. These
// are pure decision functions; the panel wires them to UI confirmations.

/** Identity of an account/plane, on either side of a migration. */
export interface AccountIdentity {
  /** Display name from the Rise header / export manifest. */
  name?: string | null;
  /** JWT `sub`: the signed-in LOGIN's Articulate ID (`aid|<uuid>`), when
   *  available. Plane-STABLE for that person (operator-confirmed 2026-08-20)
   *  and never account/tenant-scoped: one login with seats in two accounts
   *  carries the SAME sub into both, so a sub match alone cannot distinguish
   *  "same account" from "same person, different account". */
  sub?: string | null;
  /** Account-local Rise user id (`_articulate_user_id` cookie) — the valid
   *  principal for folder ownership, and ACCOUNT-scoped (differs per account
   *  even for one login), so it is the strongest same-account evidence.
   *  Recorded in export manifests since v0.9.0; older archives lack it. */
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
       *  verdict is never a mystery. 'userId' is account-scoped (the strongest
       *  evidence: this IS the source account). 'sub' is the login's
       *  plane-stable Articulate ID — with DIFFERENT account-local user ids it
       *  means either one login holding seats in both accounts (override-able)
       *  or the previous login's SSO-drift token (dangerous); with different
       *  display names it usually means a stale cached identity. */
      matchedBy?: 'userId' | 'sub' | 'name';
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
  // Account-local user ids are the strongest evidence: they are ACCOUNT-scoped,
  // so a match proves the target IS the source account, and a mismatch proves
  // it is not — even when the same login (same sub) is behind both.
  const bothUserIds = !!source.userId && !!target.userId;
  const sameUserId = bothUserIds && source.userId === target.userId;
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
  const sameAccount = sameUserId || sameSub || (samePlane && sameName);

  if (sameAccount && !override) {
    const matchedBy: 'userId' | 'sub' | 'name' = sameUserId
      ? 'userId'
      : sameSub
        ? 'sub'
        : 'name';
    // Names present AND different, yet the JWT sub matched: the cached bearer
    // almost certainly predates an account switch. Say so — the operator would
    // otherwise see two different names above a "same account" verdict.
    const namesDiffer = !!source.name && !!target.name && !sameName;
    const detail =
      matchedBy === 'userId'
        ? `the target's account-local user id matches the id recorded at export — this IS the source account`
        : matchedBy === 'sub'
          ? bothUserIds
            ? // Same LOGIN, provably different ACCOUNTS (the account-local ids
              // differ). Two readings, one of them dangerous, and they are
              // indistinguishable at a single instant — so this stays a block,
              // but the operator gets the real choice instead of a mystery.
              `the target token belongs to the same Articulate LOGIN that made this export (the JWT sub is the login's plane-stable aid| id) while the account-local user ids differ — ` +
              `either this login deliberately holds seats in BOTH accounts (tick Override to proceed; writes stay pinned to the target tab), ` +
              `or the target origin silently carries the previous login's SSO session (the shared id.articulate.com SSO survives a site logout): sign into the target origin explicitly and re-check`
            : namesDiffer || differentKnownPlanes
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
