// Stateless chrome.tabs helpers for the background entrypoint — split out of
// index.ts (v0.9.0 restructure). Everything here derives from live tab state +
// cookies; per-plane TOKEN state stays in index.ts.

import { RISE_TAB_GLOBS } from '@/shared/hosts';
import { risePlaneFromUrl } from '@/shared/messaging';
import type { TabPin } from '@/shared/messaging';

export type Plane = 'us' | 'eu';

// Find the Rise tab to operate in — prefer the active/last-focused one (the
// plane the operator is looking at), else any open Rise tab (US or EU).
export async function findRiseTab(): Promise<chrome.tabs.Tab | undefined> {
  const active = await chrome.tabs.query({
    url: RISE_TAB_GLOBS,
    active: true,
    lastFocusedWindow: true,
  });
  const hit = active.find((t) => typeof t.id === 'number');
  if (hit) return hit;
  const any = await chrome.tabs.query({ url: RISE_TAB_GLOBS });
  return any.find((t) => typeof t.id === 'number');
}

export interface ResolvedTarget {
  tabId: number;
  plane: Plane;
  url: string;
  /** Pinned targets never fall back to another plane's bearer. */
  pinned: boolean;
}

/**
 * Resolve the tab a request runs in. With a pin: exactly that tab, and only
 * while it is still on the expected plane — otherwise a LOUD error (never a
 * silent re-resolution). Without a pin: the active/last-focused Rise tab.
 */
export async function resolveTarget(
  pin?: TabPin,
): Promise<{ ok: true; target: ResolvedTarget } | { ok: false; error: string }> {
  if (pin) {
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(pin.pinnedTabId);
    } catch {
      tab = undefined;
    }
    const want = pin.expectedPlane.toUpperCase();
    if (!tab || typeof tab.id !== 'number') {
      return {
        ok: false,
        error: `Pinned target Rise tab (id ${pin.pinnedTabId}, ${want}) is gone — this run is pinned to that tab so its writes can never land in another account. Reopen the target Rise tab, then start the run again.`,
      };
    }
    const plane = risePlaneFromUrl(tab.url);
    if (plane !== pin.expectedPlane) {
      return {
        ok: false,
        error: `Pinned target Rise tab (id ${pin.pinnedTabId}) is no longer on the ${want} plane (now ${plane ? plane.toUpperCase() : (tab.url ?? 'a non-Rise page')}) — refusing to write into a different account. Point that tab back at the target Rise account, then start the run again.`,
      };
    }
    return { ok: true, target: { tabId: tab.id, plane, url: tab.url ?? '', pinned: true } };
  }
  const tab = await findRiseTab();
  const plane = risePlaneFromUrl(tab?.url);
  if (!tab || typeof tab.id !== 'number' || !plane) {
    return {
      ok: false,
      error:
        'No open Rise tab (US rise.articulate.com or EU rise.eu.articulate.com). Open and log into Rise, keep that tab open, then retry.',
    };
  }
  return { ok: true, target: { tabId: tab.id, plane, url: tab.url ?? '', pinned: false } };
}

// A Rise COURSE EDITOR tab — URL path `/authoring/{id}`. Operator-confirmed:
// ONLY a course-editor boot rotates the bearer; reloading the dashboard /
// project list (`/manage`, `/`) does NOT. So token refresh must target one of
// these, never the dashboard. Prefer the active/last-focused editor, and — when
// a plane is known (a pinned run) — only an editor ON THAT PLANE: reloading the
// source editor rotates the source bearer and leaves the target's stale.
export async function findCourseEditorTab(plane?: Plane | null): Promise<chrome.tabs.Tab | undefined> {
  const isEditor = (t: chrome.tabs.Tab): boolean =>
    typeof t.id === 'number' &&
    /\/authoring\/[^/]+/.test(t.url ?? '') &&
    (!plane || risePlaneFromUrl(t.url) === plane);
  const active = await chrome.tabs.query({ url: RISE_TAB_GLOBS, active: true, lastFocusedWindow: true });
  const hit = active.find(isEditor);
  if (hit) return hit;
  const any = await chrome.tabs.query({ url: RISE_TAB_GLOBS });
  return any.find(isEditor);
}

// The account-local Rise user id (`_articulate_user_id` cookie) — the valid
// principal for folder ownership. May be URL-encoded (`auth0%7C…`). Read from
// the pinned/active target tab, so it is the TARGET account's principal.
export async function readAccountUserId(pin?: TabPin): Promise<string | null> {
  const r = await resolveTarget(pin);
  if (!r.ok) return null;
  try {
    const c = await browser.cookies.get({ url: r.target.url, name: '_articulate_user_id' });
    const raw = c?.value?.trim();
    if (!raw) return null;
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

// Resolve when a tab finishes loading a NEW document (or a timeout elapses).
// Used after a reload so we don't re-read the cookie before the SPA has booted.
// Only a 'complete' that FOLLOWS this reload's 'loading' counts: the tab is
// already 'complete' when the reload is issued, so accepting the first
// 'complete' resolved immediately and we then read the PRE-reload cookie. If no
// 'loading' arrives within the grace window (the reload landed before the
// listener attached), an already-'complete' tab is accepted.
export function waitForTabComplete(tabId: number, timeoutMs: number, graceMs = 1_500): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let sawLoading = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch {
        /* ignore */
      }
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo): void => {
      if (id !== tabId) return;
      if (info.status === 'loading') {
        sawLoading = true;
        return;
      }
      if (info.status === 'complete' && sawLoading) finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      if (settled || sawLoading) return;
      chrome.tabs
        .get(tabId)
        .then((t) => {
          if (!sawLoading && t.status === 'complete') finish();
        })
        .catch(() => {});
    }, graceMs);
    setTimeout(finish, timeoutMs);
  });
}

/** A newly-created tab may already be in `loading` before its id is returned,
 *  so unlike the reload waiter, any later `complete` is sufficient. */
export function waitForCreatedTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch {
        /* ignore */
      }
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.OnUpdatedInfo): void => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((tab) => void (tab.status === 'complete' && finish()))
      .catch(() => finish());
    setTimeout(finish, timeoutMs);
  });
}

