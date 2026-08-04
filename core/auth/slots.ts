// Per-plane bearer-slot decisions (F0, findings-2026-08-04-us-run.md).
//
// The background keeps ONE token slot per plane, filled by a webRequest sniffer
// that reads the Authorization header off Rise requests. The first live
// cross-plane run proved that combination can poison itself: an unpinned
// request with an empty target-plane slot BORROWED the other plane's bearer,
// the sniffer keyed that request by its URL's plane, and our own borrowed
// header was captured into the target slot — after which even strict/pinned
// calls got the source account's token "legitimately". Two rules close the
// loop, both pure so they can be regression-tested:
//
//   1. `shouldCaptureBearer` — never capture a header the extension itself
//      attached (a value already held in ANOTHER plane's slot cannot be a
//      genuine SPA-issued bearer for this plane).
//   2. `bearerForPlane` — a request whose plane is known uses THAT plane's
//      slot or nothing. No cross-plane fallback, ever: an empty slot must
//      surface as a loud "open a course editor on the target account" error
//      (see `noTokenForPlaneMessage`), never as a borrowed token.

export type Plane = 'us' | 'eu';

export function otherPlane(plane: Plane): Plane {
  return plane === 'us' ? 'eu' : 'us';
}

/**
 * Should the webRequest sniffer store `token` into `plane`'s slot?
 *
 * False exactly when the value is already held in the OTHER plane's slot and
 * is NOT this plane's own current value — the only way that happens is that we
 * attached it ourselves (the Rise SPA never sends one plane's bearer to the
 * other plane's host). Re-observing this plane's own token stays capturable
 * (it is a no-op in the store) so a genuine same-value refresh is unaffected.
 */
export function shouldCaptureBearer(
  plane: Plane,
  token: string,
  held: Record<Plane, string | null>,
): boolean {
  return !(token === held[otherPlane(plane)] && token !== held[plane]);
}

/**
 * The bearer a request may use. A known plane gets its OWN slot's token or
 * null — never another plane's (F0). Only a plane-less caller (no Rise tab
 * resolvable — display/status paths, never authoring writes) falls back to
 * the most recently captured slot.
 */
export function bearerForPlane(
  plane: Plane | null,
  held: Record<Plane, string | null>,
  latestPlane: Plane | null,
): string | null {
  if (plane) return held[plane];
  return latestPlane ? held[latestPlane] : null;
}

/** The loud, actionable error for an empty plane slot (F0/F6): only a course
 *  EDITOR boot rotates the bearer, so that is the instruction. */
export function noTokenForPlaneMessage(plane: Plane): string {
  return (
    `No Rise token captured for the ${plane.toUpperCase()} plane yet — this run refuses to ` +
    `borrow another plane's credentials. Open a course EDITOR tab on the ${plane.toUpperCase()} ` +
    `target account (the dashboard alone does not issue a bearer), wait for it to load, then retry.`
  );
}
