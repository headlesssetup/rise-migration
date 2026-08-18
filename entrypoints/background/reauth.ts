// Bearer refresh for the background — split out of index.ts (v0.9.0
// restructure). The factory closes over the SAME auth record/slot accessors
// index.ts owns, so the verbatim bodies below keep their exact semantics.

import { risePlaneFromUrl } from '@/shared/messaging';
import type { TabPin } from '@/shared/messaging';
import { courseEditorUrl } from '@/shared/rise-editor';
import {
  findCourseEditorTab,
  resolveTarget,
  waitForCreatedTabComplete,
  waitForTabComplete,
  type Plane,
} from './tabs';

/** The slice of index.ts's per-plane auth state the refresh logic reads. */
interface AuthSlot {
  token: string | null;
  identity: { expiresAt?: number } | null;
}

export function createReauth(a: {
  auth: Record<Plane, AuthSlot>;
  slotFor(plane: Plane | null): AuthSlot | null | undefined;
  grabTokenForUrl(url: string | undefined): Promise<boolean>;
}) {
  const { auth, slotFor, grabTokenForUrl } = a;

  // Token refresh strategy — reload the Rise tab and let the SPA do it.
  //
  // We tried replicating Rise's own Okta silent re-auth headlessly (a hidden
  // `/authorize?prompt=none` iframe + `okta_post_message`, capture-confirmed in
  // docs §2). It never rotated the bearer at runtime — the injected iframe path
  // fails silently (third-party SSO cookie / postMessage / CSP) where the SPA's
  // own first-party flow succeeds. Rather than reverse-engineer that further, we
  // piggyback on Rise's battle-tested refresh: reload the tab, the SPA boots and
  // writes a rotated `_articulate_rise_` cookie, and we re-read it.
  //
  // TODO(refresh): revisit a silent (no-reload) refresh for a smoother operator
  // experience — a working in-tab Okta silent re-auth, or driving the SPA's own
  // token service. A reload is robust but visibly disruptive on a long import.



  async function waitForTokenAdvance(
    tabId: number,
    fallbackUrl: string | undefined,
    plane: Plane,
    before: number,
  ): Promise<boolean> {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const live = await chrome.tabs.get(tabId).catch(() => undefined);
      await grabTokenForUrl(live?.url ?? fallbackUrl);
      if ((auth[plane].identity?.expiresAt ?? 0) > before) return true;
      await new Promise((r) => setTimeout(r, 750));
    }
    return false;
  }

  // Fallback refresh: reload a Rise COURSE EDITOR tab so the SPA runs its OWN
  // (native) Okta silent re-auth on boot and writes a rotated `_articulate_rise_`
  // cookie, then poll THAT TAB's cookie until its `exp` advances. This piggybacks
  // on Rise's own, battle-tested refresh instead of replicating the Okta flow
  // ourselves — far more robust than the injected iframe, at the cost of a visible
  // reload. Safe mid-import: reauth only runs BETWEEN paced writes (proactive
  // heartbeat) or AFTER a write already returned 403, so no write is in flight.
  // IMPORTANT: only a COURSE EDITOR boot rotates the bearer — reloading the
  // dashboard does NOT (operator-confirmed 2026-06-23). For a GET_COURSE export,
  // we already have a capture-confirmed course id: if no editor is open, boot that
  // course in a temporary inactive tab, capture the rotated cookie, then close it.
  // This is the automated equivalent of the manual dashboard click that used to
  // be required every ~15 minutes during a long export.
  async function refreshRiseEditorToken(
    plane: Plane | null,
    bootstrap?: { courseId: string; targetUrl: string },
  ): Promise<'tab-reload' | 'editor-bootstrap' | 'none'> {
    // ONLY reload a course-editor tab — reloading the dashboard/project list is
    // useless (it never rotates the bearer) and disruptive, so we never do it.
    const tab = await findCourseEditorTab(plane);
    if (tab && typeof tab.id === 'number') {
      const tabId = tab.id;
      // Poll the RELOADED TAB's own plane/cookie — never the active tab's, which
      // may belong to a different account entirely.
      const tabPlane = risePlaneFromUrl(tab.url);
      if (!tabPlane) return 'none';
      const before = auth[tabPlane].identity?.expiresAt ?? 0;
      // Listen BEFORE reloading so the reload's own 'loading' can't be missed.
      const loaded = waitForTabComplete(tabId, 20_000);
      try {
        await chrome.tabs.reload(tabId);
      } catch {
        return 'none';
      }
      await loaded;
      return (await waitForTokenAdvance(tabId, tab.url, tabPlane, before))
        ? 'tab-reload'
        : 'none';
    }

    if (!plane || !bootstrap) return 'none';
    const url = courseEditorUrl(bootstrap.targetUrl, bootstrap.courseId);
    if (!url || risePlaneFromUrl(url) !== plane) return 'none';
    const before = auth[plane].identity?.expiresAt ?? 0;
    let created: chrome.tabs.Tab | undefined;
    try {
      created = await chrome.tabs.create({ url, active: false });
      if (typeof created.id !== 'number') return 'none';
      await waitForCreatedTabComplete(created.id, 20_000);
      return (await waitForTokenAdvance(created.id, url, plane, before))
        ? 'editor-bootstrap'
        : 'none';
    } catch {
      return 'none';
    } finally {
      if (typeof created?.id === 'number') {
        await chrome.tabs.remove(created.id).catch(() => {});
      }
    }
  }

  // Re-establish a fresh bearer mid-import.
  //   1. Re-read the cookie of the pinned/active tab — the editor may have already
  //      rotated it (the operator opened/refreshed a course, or its own token
  //      service fired). During an import there's no page traffic for the
  //      webRequest observer to catch, so we must pull the rotated cookie.
  //   2. If that didn't advance AND the token actually needs refreshing
  //      (expiring/expired), reload a course-editor tab ON THAT PLANE so the Rise
  //      SPA refreshes natively (the only refresh that works in practice).
  // Reports honestly:
  //   - `advanced`: true ONLY when `exp` actually moved forward (a real
  //     rotation). A "refresh" that doesn't advance `exp` is a no-op, and
  //     retrying a write with it just 403s again.
  //   - `valid`: we currently hold a non-expired token (rotated or not).
  //   - `via`: how the bearer was (re)obtained — for honest logging.
  // The automatic callers gate on reauthAllowed() so a doomed session can't spam
  // tab reloads; an explicit REAUTH message is operator/run-driven and bypasses it.
  let lastReauthMs = 0;
  const REAUTH_THROTTLE_MS = 30_000;
  function reauthAllowed(): boolean {
    return Date.now() - lastReauthMs > REAUTH_THROTTLE_MS;
  }

  async function reauth(pin?: TabPin, refreshCourseId?: string): Promise<{
    advanced: boolean;
    valid: boolean;
    via: 'tab-reload' | 'editor-bootstrap' | 'cookie' | 'none';
  }> {
    lastReauthMs = Date.now();
    const resolved = await resolveTarget(pin);
    const plane = resolved.ok ? resolved.target.plane : null;
    const before = slotFor(plane)?.identity?.expiresAt ?? 0;
    const expiryNow = (): number => slotFor(plane)?.identity?.expiresAt ?? 0;

    const rotatedByCookie = resolved.ok ? await grabTokenForUrl(resolved.target.url) : false;
    let via: 'tab-reload' | 'editor-bootstrap' | 'cookie' | 'none' =
      expiryNow() > before && rotatedByCookie ? 'cookie' : 'none';

    // Cookie re-read didn't rotate. If the token genuinely needs refreshing, let
    // the Rise SPA do it via a tab reload. When the token is still healthy we
    // skip the reload — no point disrupting the tab.
    // A reactive GET_COURSE authorization failure is itself authoritative even
    // if the JWT's local `exp` still looks healthy (server revocation/clock skew).
    if (expiryNow() <= before && (tokenExpiringSoon(plane) || !!refreshCourseId)) {
      via = await refreshRiseEditorToken(
        plane,
        resolved.ok && refreshCourseId
          ? { courseId: refreshCourseId, targetUrl: resolved.target.url }
          : undefined,
      );
    }

    const after = expiryNow();
    return { advanced: after > before, valid: after > Date.now(), via };
  }

  // The held bearer is short-lived (~15 min). On a long import it expires
  // mid-run; Rise answers an expired token on the authoring endpoints with 403
  // (not 401) — e.g. GET_YURL "Forbidden" — so we must treat 403 as re-auth too.
  // Holding NO token counts as expiring, or the proactive bootstrap before the
  // first write of a cold service worker never fires.
  function tokenExpiringSoon(plane: Plane | null, skewMs = 60_000): boolean {
    const slot = slotFor(plane);
    if (!slot?.token || slot.identity?.expiresAt === undefined) return true;
    return slot.identity.expiresAt - skewMs <= Date.now();
  }

  return { reauthAllowed, reauth, tokenExpiringSoon };
}
