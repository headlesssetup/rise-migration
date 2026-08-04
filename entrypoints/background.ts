// Background service worker: owns auth + fetch orchestration.
//   - Captures the bearer JWT by observing real Rise requests (webRequest),
//     keyed BY PLANE (a US and an EU session are different bearers).
//   - Runs API calls INSIDE the Rise tab (first-party cookies) via scripting,
//     because Rise's catalog/manage API is cookie-authenticated and a
//     SameSite cookie is withheld from an extension-origin (cross-site) fetch.
//   - Exposes typed fetch RPCs to the side panel (search, get-course).
//   - Pacing lives in the panel, NOT here.
//
// TAB PINNING (see shared/messaging.ts `TabPin`): a request may name the exact
// tab it must run in. Unpinned requests keep the historical behavior (the
// active/last-focused Rise tab); a pinned request runs in THAT tab or fails
// loudly — it is never silently re-routed, because re-resolving "the active tab"
// per request made authoring writes follow window focus (a focused US tab could
// take the writes of an EU import).

import { identityFromToken, type Identity } from '@/core/auth/jwt';
import { bearerForPlane, noTokenForPlaneMessage, shouldCaptureBearer } from '@/core/auth/slots';
import {
  buildFetchBlockTemplatesRequest,
  buildFetchTypefacesRequest,
  buildGetCourseRequest,
  buildGetQuestionBankRequest,
  buildListFoldersRequest,
  buildListQuestionBanksRequest,
  buildSearchRequest,
  type RequestSpec,
} from '@/core/rise-client';
import type { WriteSpec } from '@/core/import/envelopes';
import { buildRawExportRequest, parseBuildAck } from '@/core/storyline/build-request';
import { awaitExportLocation, wsExportUrlForPlane, type WsLike } from '@/core/storyline/ws-export-client';
import { s3PutReview } from '@/core/import/envelopes';
import {
  awaitContentPrefix,
  connectReviewSocket,
  reviewSocketBaseForPlane,
  uploadStorylinePackage,
} from '@/core/storyline/review-socket-client';
import { RISE_TAB_GLOBS } from '@/shared/hosts';
import { risePlaneFromUrl } from '@/shared/messaging';
import type {
  BackgroundRequest,
  BackgroundResponse,
  ContentMessage,
  FetchResult,
  RawKind,
  TabPin,
  WriteRelayResult,
} from '@/shared/messaging';

const TOKEN_KEY = 'riseTokens';

type Plane = 'us' | 'eu';

interface InPageResult {
  ok: boolean;
  status: number;
  text?: string;
  error?: string;
}

/** What relayFetch needs from a spec — RequestSpec (reads) or WriteSpec (writes).
 *  Write-only fields are optional so a read RequestSpec is assignable. */
interface RelaySpec {
  url: string;
  method: string;
  body?: string;
  base64Body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  noAuth?: boolean;
  omitBearer?: boolean;
}

// Executed INSIDE the Rise tab (isolated world) — a same-origin fetch that
// rides the live session's first-party cookies, plus the bearer if we have it.
// Must be self-contained (no closures): it is serialized by executeScript.
//
// Phase 3 adds write support: PUT/DELETE, a base64 binary body (presigned S3
// upload — the same cross-origin PUT the real editor issues from the Rise page),
// an explicit Content-Type, and `noAuth` (the presigned url carries its own
// signature, so no bearer/cookies on the S3 PUT).
async function fetchInRiseTab(
  spec: {
    url: string;
    method: string;
    body?: string;
    base64Body?: string;
    contentType?: string;
    headers?: Record<string, string>;
    noAuth?: boolean;
    omitBearer?: boolean;
  },
  token: string | null,
): Promise<InPageResult> {
  try {
    const headers: Record<string, string> = {};
    // noAuth: no bearer + no cookies (presigned S3). omitBearer: no bearer but
    // KEEP cookies (cookie-authed endpoints like build/raw, which 403 on a stale
    // bearer). Default: bearer + cookies.
    if (token && !spec.noAuth && !spec.omitBearer) headers.Authorization = `Bearer ${token}`;

    let body: BodyInit | undefined;
    if (spec.base64Body !== undefined) {
      const bin = atob(spec.base64Body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      body = new Blob([bytes], { type: spec.contentType || 'application/octet-stream' });
      if (spec.contentType) headers['Content-Type'] = spec.contentType;
    } else if (spec.body !== undefined) {
      body = spec.body;
      headers['Content-Type'] = spec.contentType || 'application/json';
    }
    // Explicit per-spec headers (e.g. Content-MD5 on a Review-360 upload PUT)
    // override the defaults above.
    if (spec.headers) Object.assign(headers, spec.headers);

    const res = await fetch(spec.url, {
      method: spec.method,
      headers,
      body,
      // Presigned S3 PUT is cross-origin and must NOT send cookies; rise.* calls
      // need first-party cookies. Gate credentials on noAuth.
      credentials: spec.noAuth ? 'omit' : 'include',
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, error: String(e) };
  }
}

export default defineBackground(() => {
  interface PlaneAuth {
    token: string | null;
    identity: Identity | null;
  }

  // Bearers are PER PLANE. With a single global slot, a background session
  // refresh in the SOURCE tab overwrote the TARGET bearer mid-import (both planes
  // feed the same webRequest observer), and every write after it rode the wrong
  // account's token.
  const auth: Record<Plane, PlaneAuth> = {
    us: { token: null, identity: null },
    eu: { token: null, identity: null },
  };
  // Plane of the most recently captured bearer — the fallback for an UNPINNED
  // request whose own plane holds no token yet (pre-pinning behavior).
  let latestPlane: Plane | null = null;
  let risePresent = false;
  let accountName: string | null = null;

  // Restore tokens captured earlier this browser session (session storage is
  // cleared when the browser closes — we never persist credentials to disk).
  // MEMOIZED: `handle()` awaits it, so a message arriving right after a
  // service-worker restart can never run against a still-empty token slot.
  const restored: Promise<void> = browser.storage.session
    .get(TOKEN_KEY)
    .then((r) => {
      const saved = r[TOKEN_KEY] as Partial<Record<Plane, string>> | undefined;
      if (!saved || typeof saved !== 'object') return;
      for (const plane of ['us', 'eu'] as Plane[]) {
        const t = saved[plane];
        if (typeof t === 'string' && t) {
          auth[plane].token = t;
          auth[plane].identity = identityFromToken(t);
          latestPlane ??= plane;
        }
      }
    })
    .catch(() => {});

  function setToken(plane: Plane, next: string): void {
    latestPlane = plane;
    const slot = auth[plane];
    if (next === slot.token) return;
    slot.token = next;
    slot.identity = identityFromToken(next);
    browser.storage.session
      .set({ [TOKEN_KEY]: { us: auth.us.token, eu: auth.eu.token } })
      .catch(() => {});
  }

  /** The auth slot a request should use: the named plane's, else the most
   *  recently captured one (unpinned callers with no resolvable plane). */
  function slotFor(plane: Plane | null): PlaneAuth | null {
    if (plane) return auth[plane];
    return latestPlane ? auth[latestPlane] : null;
  }

  /** The bearer for a plane. A known plane uses its OWN slot or nothing — the
   *  cross-plane fallback is GONE (F0): borrowing the other plane's token is
   *  what poisoned the US slot on the first live cross-plane run (the sniffer
   *  captured our own borrowed header back into the slot). Only a plane-less
   *  caller (no Rise tab resolvable — status/display paths) may fall back to
   *  the most recently captured slot. */
  function tokenFor(plane: Plane | null): string | null {
    return bearerForPlane(
      plane,
      { us: auth.us.token, eu: auth.eu.token },
      latestPlane,
    );
  }

  // Open the side panel when the toolbar icon is clicked.
  try {
    chrome.sidePanel
      ?.setPanelBehavior?.({ openPanelOnActionClick: true })
      .catch(() => {});
  } catch {
    /* sidePanel unavailable in some contexts — ignore */
  }

  // --- Token capture: read Authorization off genuine Rise requests ----------
  // Keyed by the REQUEST's plane so a US and an EU session coexist.
  // F0 GUARD: the sniffer also sees requests WE relay into the tab — it must
  // never capture a header the extension itself attached. A value already held
  // in the OTHER plane's slot cannot be a genuine SPA bearer for this plane
  // (the SPA never sends one plane's token to the other plane's host); storing
  // it would poison this slot with the other account's credentials — exactly
  // the self-sniffing loop of the first live cross-plane run.
  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const plane = risePlaneFromUrl(details.url);
      if (!plane) return;
      const header = details.requestHeaders?.find(
        (h) => h.name.toLowerCase() === 'authorization',
      );
      const value = header?.value;
      if (value && /^Bearer\s+/i.test(value)) {
        const token = value.replace(/^Bearer\s+/i, '').trim();
        if (!shouldCaptureBearer(plane, token, { us: auth.us.token, eu: auth.eu.token })) {
          return;
        }
        setToken(plane, token);
      }
    },
    { urls: RISE_TAB_GLOBS },
    ['requestHeaders', 'extraHeaders'],
  );

  // Find the Rise tab to operate in — prefer the active/last-focused one (the
  // plane the operator is looking at), else any open Rise tab (US or EU).
  async function findRiseTab(): Promise<chrome.tabs.Tab | undefined> {
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

  interface ResolvedTarget {
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
  async function resolveTarget(
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
  async function findCourseEditorTab(plane?: Plane | null): Promise<chrome.tabs.Tab | undefined> {
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

  // Read the bearer straight from the `_articulate_rise_` cookie — its value IS
  // the access token Rise sends as `Authorization: Bearer`. This needs no course
  // navigation and no page reload: the Cookies API reads it (even httpOnly) for
  // the given URL's plane. Returns true ONLY if a NEW (rotated) JWT was captured —
  // re-reading the same stale cookie is not a refresh and must not read as one.
  // Takes ONE specific tab's URL: the cookie is per-plane, so reading it for the
  // wrong tab stores the wrong account's bearer under the wrong slot.
  async function grabTokenForUrl(url: string | undefined): Promise<boolean> {
    const plane = risePlaneFromUrl(url);
    if (!url || !plane) return false;
    try {
      const c = await browser.cookies.get({ url, name: '_articulate_rise_' });
      const value = c?.value?.trim();
      // A JWT has three dot-separated segments; guard against a stray cookie.
      if (value && value.split('.').length === 3) {
        const changed = value !== auth[plane].token;
        setToken(plane, value);
        return changed;
      }
    } catch {
      /* cookies permission/host missing — fall back to the reload path */
    }
    return false;
  }

  async function grabTokenFromCookie(pin?: TabPin): Promise<boolean> {
    const r = await resolveTarget(pin);
    return r.ok ? grabTokenForUrl(r.target.url) : false;
  }

  // The account-local Rise user id (`_articulate_user_id` cookie) — the valid
  // principal for folder ownership. May be URL-encoded (`auth0%7C…`). Read from
  // the pinned/active target tab, so it is the TARGET account's principal.
  async function readAccountUserId(pin?: TabPin): Promise<string | null> {
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

  // Locate the Rise tab (pinned or active) and run the fetch inside it —
  // first-party cookies plus THAT plane's bearer.
  async function relayFetch(spec: RelaySpec, pin?: TabPin): Promise<InPageResult> {
    const resolved = await resolveTarget(pin);
    if (!resolved.ok) return { ok: false, status: 0, error: resolved.error };
    const { tabId, plane } = resolved.target;
    // F0: a bearer-carrying request with an EMPTY slot for its own plane BLOCKS
    // loudly — it must never proceed bare (the server's 403 would trigger a
    // reauth loop with a misleading message) and must never borrow the other
    // plane's token. Presigned/cookie-only specs (noAuth/omitBearer) proceed:
    // they don't use the bearer at all.
    const token = tokenFor(plane);
    if (!token && !spec.noAuth && !spec.omitBearer) {
      return { ok: false, status: 0, error: noTokenForPlaneMessage(plane) };
    }
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: fetchInRiseTab,
        args: [
          {
            url: spec.url,
            method: spec.method,
            body: spec.body,
            base64Body: spec.base64Body,
            contentType: spec.contentType,
            headers: spec.headers,
            noAuth: spec.noAuth,
            omitBearer: spec.omitBearer,
          },
          token,
        ],
      });
      return (
        (injection?.result as InPageResult | undefined) ?? {
          ok: false,
          status: 0,
          error: 'No result returned from the Rise tab.',
        }
      );
    } catch (e) {
      return {
        ok: false,
        status: 0,
        error: `Could not run in the Rise tab (try reloading it): ${(e as Error).message}`,
      };
    }
  }

  // --- In-page fetch with one-shot 401/403 re-auth --------------------------
  async function rawFetch(
    spec: RequestSpec,
    pin?: TabPin,
    attempt = 0,
  ): Promise<FetchResult<string>> {
    const r = await relayFetch(spec, pin);

    // An expired bearer reads back as 401 OR 403 (the authoring endpoints answer
    // 403 "Forbidden") — re-auth and retry once, but ONLY if the token actually
    // advanced; retrying with the same stale token just 403s again. Throttled:
    // a dead SSO session would otherwise reload the tab on EVERY paced request.
    if (
      (r.status === 401 || r.status === 403) &&
      attempt === 0 &&
      reauthAllowed() &&
      (await reauth(pin)).advanced
    ) {
      return rawFetch(spec, pin, 1);
    }
    if (r.status === 401 || r.status === 403) {
      // F6: the bearer did not advance (or reauth is throttled) — the fix is a
      // course-editor boot on THIS plane's account, not a plain re-login.
      return {
        ok: false,
        status: r.status,
        error:
          `Unauthorized (${r.status}) from Rise and the bearer did not refresh. ` +
          `Open a course EDITOR tab on the account this run targets (the dashboard does not ` +
          `rotate the token), make sure you are logged in there, then retry.`,
      };
    }
    if (!r.ok) {
      return {
        ok: false,
        status: r.status || undefined,
        error: r.error ?? `HTTP ${r.status}`,
      };
    }
    return { ok: true, status: r.status, data: r.text ?? '' };
  }

  // Relay one WRITE envelope through the live Rise tab. Unlike rawFetch, it
  // returns the raw body even on non-2xx so the importer can loud-fail with the
  // server's message (protocol §12). One-shot 401 refresh + retry.
  async function relayWrite(spec: WriteSpec, pin?: TabPin): Promise<WriteRelayResult> {
    // Proactive: refresh before the token lapses so a long import never trips a
    // mid-flight 403 (throttled, so a non-rotating token can't spam refresh).
    const resolved = await resolveTarget(pin);
    const plane = resolved.ok ? resolved.target.plane : null;
    if (tokenExpiringSoon(plane) && reauthAllowed()) await reauth(pin);
    let r = await relayFetch(spec, pin);
    // Reactive: Rise returns 401 OR 403 on an expired/invalid bearer — re-auth
    // and retry once, but ONLY if the token actually advanced (a non-rotating
    // refresh would just 403 again on the retry). Throttled like the proactive
    // branch so a doomed session can't reload the tab once per paced write.
    if ((r.status === 401 || r.status === 403) && reauthAllowed() && (await reauth(pin)).advanced) {
      r = await relayFetch(spec, pin);
    }
    // F6: a still-unauthorized write after the refresh attempt gets the
    // actionable instruction attached (the executor surfaces `error` verbatim).
    const authHint =
      r.status === 401 || r.status === 403
        ? `Unauthorized (${r.status}) and the bearer did not refresh — open a course EDITOR tab on the TARGET account (the dashboard does not rotate the token), then retry.`
        : undefined;
    return { ok: r.ok, status: r.status, text: r.text ?? '', error: r.error ?? authHint };
  }

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

  // Resolve when a tab finishes loading a NEW document (or a timeout elapses).
  // Used after a reload so we don't re-read the cookie before the SPA has booted.
  // Only a 'complete' that FOLLOWS this reload's 'loading' counts: the tab is
  // already 'complete' when the reload is issued, so accepting the first
  // 'complete' resolved immediately and we then read the PRE-reload cookie. If no
  // 'loading' arrives within the grace window (the reload landed before the
  // listener attached), an already-'complete' tab is accepted.
  function waitForTabComplete(tabId: number, timeoutMs: number, graceMs = 1_500): Promise<void> {
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

  // Fallback refresh: reload a Rise COURSE EDITOR tab so the SPA runs its OWN
  // (native) Okta silent re-auth on boot and writes a rotated `_articulate_rise_`
  // cookie, then poll THAT TAB's cookie until its `exp` advances. This piggybacks
  // on Rise's own, battle-tested refresh instead of replicating the Okta flow
  // ourselves — far more robust than the injected iframe, at the cost of a visible
  // reload. Safe mid-import: reauth only runs BETWEEN paced writes (proactive
  // heartbeat) or AFTER a write already returned 403, so no write is in flight.
  // IMPORTANT: only a COURSE EDITOR boot rotates the bearer — reloading the
  // dashboard does NOT (operator-confirmed 2026-06-23). If no editor tab is open
  // the poll times out and we report no-advance honestly (the panel then tells the
  // operator to open a course).
  async function reloadRiseTabForToken(plane: Plane | null): Promise<boolean> {
    // ONLY reload a course-editor tab — reloading the dashboard/project list is
    // useless (it never rotates the bearer) and disruptive, so we never do it.
    const tab = await findCourseEditorTab(plane);
    if (!tab || typeof tab.id !== 'number') return false;
    const tabId = tab.id;
    // Poll the RELOADED TAB's own plane/cookie — never the active tab's, which may
    // belong to a different account entirely.
    const tabPlane = risePlaneFromUrl(tab.url);
    if (!tabPlane) return false;
    const before = auth[tabPlane].identity?.expiresAt ?? 0;
    // Listen BEFORE reloading so the reload's own 'loading' can't be missed.
    const loaded = waitForTabComplete(tabId, 20_000);
    try {
      await chrome.tabs.reload(tabId);
    } catch {
      return false;
    }
    await loaded;
    // The SPA's auth bootstrap is async after load — poll the cookie for advance.
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const live = await chrome.tabs.get(tabId).catch(() => undefined);
      await grabTokenForUrl(live?.url ?? tab.url);
      if ((auth[tabPlane].identity?.expiresAt ?? 0) > before) return true;
      await new Promise((r) => setTimeout(r, 750));
    }
    return false;
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

  async function reauth(pin?: TabPin): Promise<{
    advanced: boolean;
    valid: boolean;
    via: 'tab-reload' | 'cookie' | 'none';
  }> {
    lastReauthMs = Date.now();
    const resolved = await resolveTarget(pin);
    const plane = resolved.ok ? resolved.target.plane : null;
    const before = slotFor(plane)?.identity?.expiresAt ?? 0;
    const expiryNow = (): number => slotFor(plane)?.identity?.expiresAt ?? 0;

    const rotatedByCookie = resolved.ok ? await grabTokenForUrl(resolved.target.url) : false;
    let via: 'tab-reload' | 'cookie' | 'none' =
      expiryNow() > before && rotatedByCookie ? 'cookie' : 'none';

    // Cookie re-read didn't rotate. If the token genuinely needs refreshing, let
    // the Rise SPA do it via a tab reload. When the token is still healthy we
    // skip the reload — no point disrupting the tab.
    if (expiryNow() <= before && tokenExpiringSoon(plane)) {
      if (await reloadRiseTabForToken(plane)) via = 'tab-reload';
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

  // MV3 reaps an idle service worker after ~30s of quiet — which kills a pending
  // sendResponse. The storyline sockets wait minutes with no extension-API
  // traffic of their own, so poke a trivial API on an interval to reset the idle
  // timer for the duration of the wait.
  function startKeepalive(): () => void {
    const id = setInterval(() => {
      try {
        chrome.runtime.getPlatformInfo(() => {});
      } catch {
        /* best-effort poke — ignore */
      }
    }, 20_000);
    return () => clearInterval(id);
  }

  // Fetch a raw JSON resource and wrap it as a RAW_RESULT (shared by the
  // account-level exports: block templates, typefaces, review items).
  async function rawResult(
    kind: RawKind,
    spec: RequestSpec,
    label: string,
    pin?: TabPin,
  ): Promise<BackgroundResponse> {
    const r = await rawFetch(spec, pin);
    if (!r.ok) return { type: 'RAW_RESULT', kind, result: r };
    try {
      return {
        type: 'RAW_RESULT',
        kind,
        result: {
          ok: true,
          status: r.status,
          data: { raw: r.data, doc: JSON.parse(r.data) },
        },
      };
    } catch {
      return {
        type: 'RAW_RESULT',
        kind,
        result: { ok: false, status: r.status, error: `${label} was not valid JSON.` },
      };
    }
  }

  async function handle(
    msg: BackgroundRequest,
  ): Promise<BackgroundResponse> {
    // Never run against a half-restored token slot after a worker restart.
    await restored;
    const pin = msg.pin;
    switch (msg.type) {
      case 'GET_SESSION_STATE': {
        // Live tab query is authoritative (survives SW restarts; the content
        // script ping only updates the cached flag). Derive the plane from the
        // SAME tab writes target (active/last-focused first, then any Rise tab)
        // so a US-source + EU-target multi-tab setup reports the plane writes
        // actually go to — the Source ≠ Target guard depends on it.
        let present = risePresent;
        let plane: Plane | null = null;
        try {
          const all = await chrome.tabs.query({ url: RISE_TAB_GLOBS });
          present = all.some((t) => typeof t.id === 'number');
          const writeTab = await findRiseTab();
          const url = writeTab?.url ?? all.find((t) => typeof t.url === 'string')?.url;
          plane = risePlaneFromUrl(url);
        } catch {
          /* keep the ping-based value */
        }
        // RECONCILE the cached bearer with the live cookie on every session poll
        // (a local cookie read, no network). Doing this only when the slot was
        // EMPTY meant that after the operator switched Rise accounts we kept the
        // PREVIOUS account's token — and therefore its JWT identity — while the
        // header-derived `accountName` updated to the new account. That mismatch
        // (a) made the Source≠Target guard compare a stale `sub` and cry
        // "same account" for two plainly different accounts, and (b) would have
        // attached the OLD account's bearer to writes aimed at the new one.
        // Safe to do unconditionally: cookies are per-ORIGIN, so a plane has
        // exactly one live Rise session in a profile — the cookie IS the truth
        // for that plane, and `setToken` no-ops when the value is unchanged.
        if (present) await grabTokenFromCookie();
        const userId = present ? await readAccountUserId() : null;
        return {
          type: 'SESSION_STATE',
          state: {
            hasToken: !!tokenFor(plane),
            risePresent: present,
            identity: slotFor(plane)?.identity ?? null,
            accountName,
            plane,
            userId,
          },
        };
      }

      case 'PIN_RISE_TAB': {
        // Resolve, ONCE and up front, the tab a whole run is pinned to. Every
        // later request of that run carries the pin, so focusing another Rise tab
        // mid-run can no longer redirect its reads or writes.
        const resolved = await resolveTarget();
        if (!resolved.ok) {
          return { type: 'RISE_TAB_PIN', result: { ok: false, error: resolved.error } };
        }
        const { tabId, plane, url } = resolved.target;
        return {
          type: 'RISE_TAB_PIN',
          result: { ok: true, status: 200, data: { pinnedTabId: tabId, expectedPlane: plane, url } },
        };
      }

      case 'SEARCH_COURSES': {
        const r = await rawFetch(
          buildSearchRequest({ page: msg.page, pageSize: msg.pageSize }),
          pin,
        );
        if (!r.ok) return { type: 'SEARCH_RESULT', result: r };
        try {
          return {
            type: 'SEARCH_RESULT',
            result: { ok: true, status: r.status, data: JSON.parse(r.data) },
          };
        } catch {
          return {
            type: 'SEARCH_RESULT',
            result: {
              ok: false,
              status: r.status,
              error: 'Search response was not valid JSON.',
            },
          };
        }
      }

      case 'GET_COURSE': {
        const r = await rawFetch(buildGetCourseRequest(msg.courseId), pin);
        if (!r.ok) return { type: 'COURSE_RESULT', result: r };
        try {
          // Parse to VALIDATE only. A full course document can approach the 64MB
          // message cap, so it crosses the port ONCE as the raw body — the panel
          // persists that verbatim and unwraps it locally when it needs the doc.
          JSON.parse(r.data);
          return {
            type: 'COURSE_RESULT',
            result: { ok: true, status: r.status, data: { raw: r.data } },
          };
        } catch {
          return {
            type: 'COURSE_RESULT',
            result: {
              ok: false,
              status: r.status,
              error: 'GET_COURSE response was not valid JSON.',
            },
          };
        }
      }

      case 'LIST_FOLDERS': {
        const r = await rawFetch(buildListFoldersRequest(), pin);
        if (!r.ok) return { type: 'FOLDERS_RESULT', result: r };
        try {
          return {
            type: 'FOLDERS_RESULT',
            result: {
              ok: true,
              status: r.status,
              data: { raw: r.data, doc: JSON.parse(r.data) },
            },
          };
        } catch {
          return {
            type: 'FOLDERS_RESULT',
            result: {
              ok: false,
              status: r.status,
              error: 'Folders list was not valid JSON.',
            },
          };
        }
      }

      case 'LIST_QUESTION_BANKS': {
        const r = await rawFetch(buildListQuestionBanksRequest(), pin);
        if (!r.ok) return { type: 'BANKS_RESULT', result: r };
        try {
          return {
            type: 'BANKS_RESULT',
            result: {
              ok: true,
              status: r.status,
              data: { raw: r.data, doc: JSON.parse(r.data) },
            },
          };
        } catch {
          return {
            type: 'BANKS_RESULT',
            result: {
              ok: false,
              status: r.status,
              error: 'Question-banks list was not valid JSON.',
            },
          };
        }
      }

      case 'GET_QUESTION_BANK': {
        const r = await rawFetch(buildGetQuestionBankRequest(msg.bankId), pin);
        if (!r.ok) return { type: 'BANK_RESULT', result: r };
        try {
          return {
            type: 'BANK_RESULT',
            result: {
              ok: true,
              status: r.status,
              data: { raw: r.data, doc: JSON.parse(r.data) },
            },
          };
        } catch {
          return {
            type: 'BANK_RESULT',
            result: {
              ok: false,
              status: r.status,
              error: 'Question-bank response was not valid JSON.',
            },
          };
        }
      }

      case 'FETCH_BLOCK_TEMPLATES':
        return rawResult(
          'blockTemplates',
          buildFetchBlockTemplatesRequest(),
          'Block templates response',
          pin,
        );

      case 'FETCH_TYPEFACES':
        return rawResult(
          'typefaces',
          buildFetchTypefacesRequest(msg.courseId),
          'Typefaces response',
          pin,
        );

      case 'RELAY_WRITE':
        return { type: 'WRITE_RESULT', result: await relayWrite(msg.spec, pin) };

      case 'STORYLINE_EXPORT': {
        // Trigger the web/raw export and await its zip URL on the ws socket. The
        // socket runs here so the bearer never leaves the background; the
        // build/raw POST is sent only AFTER `identify` so we can't miss the
        // completion notify. One course at a time (the panel paces the loop), so
        // the first package:success is ours.
        //
        // The completion socket is PLANE-SPECIFIC: a US export's package:success
        // is pushed to wss://ws.articulate.com, an EU export's to ws.eu. Listen on
        // the plane of the tab the export actually runs in, else we wait forever
        // on the wrong host.
        const resolved = await resolveTarget(pin);
        if (!resolved.ok) {
          return { type: 'STORYLINE_EXPORT_RESULT', result: { ok: false, error: resolved.error } };
        }
        const { plane, url: tabUrl } = resolved.target;
        // Keep the bearer fresh PER COURSE: the ws `identify` is token-authed and
        // fails silently (socket opens, no identify result) on a stale token —
        // the dominant failure on a long run. Re-read the rotated cookie cheaply;
        // reauth (tab reload) only when actually near expiry.
        if (tokenExpiringSoon(plane) && reauthAllowed()) await reauth(pin);
        else await grabTokenForUrl(tabUrl);
        const token = tokenFor(plane);
        if (!token) {
          return {
            type: 'STORYLINE_EXPORT_RESULT',
            result: { ok: false, error: noTokenForPlaneMessage(plane) },
          };
        }
        const wsUrl = wsExportUrlForPlane(plane);
        const trace: string[] = [`plane=${plane}`, `ws=${wsUrl}`];
        // The waits below are minutes long with no extension-API traffic — keep
        // the worker (and this pending response) alive.
        const stopKeepalive = startKeepalive();
        try {
          const loc = await awaitExportLocation({
            token,
            url: wsUrl,
            connect: (url) => new WebSocket(url) as unknown as WsLike,
            // Fail fast if identify never lands (stale token); allow big-course
            // server builds plenty of time once identified.
            identifyTimeoutMs: 30_000,
            timeoutMs: 240_000,
            onOpen: () => trace.push('open'),
            // The sessionId is SERVER-ASSIGNED: it comes back on the `identify`
            // result and MUST be echoed as build/raw's websocketSessionId, or the
            // server never routes the package:success notify to our socket
            // (capture-confirmed: identify→{sessionId} == build/raw websocketSessionId).
            onIdentified: async (serverSessionId) => {
              trace.push(`identified(${serverSessionId.slice(0, 8)})`);
              const { spec } = buildRawExportRequest({
                courseId: msg.courseId,
                title: msg.title,
                websocketSessionId: serverSessionId,
              });
              const r = await relayWrite(spec, pin);
              trace.push(`build HTTP ${r.status}`);
              if (!r.ok) {
                throw new Error(`build/raw HTTP ${r.status}: ${(r.text ?? '').slice(0, 150)}`);
              }
              trace.push(`jobId ${parseBuildAck(r.text).jobId}`);
            },
          });
          return {
            type: 'STORYLINE_EXPORT_RESULT',
            result: { ok: true, status: 200, data: loc },
          };
        } catch (e) {
          return {
            type: 'STORYLINE_EXPORT_RESULT',
            result: { ok: false, error: `${(e as Error).message} [${trace.join(' → ')}]` },
          };
        } finally {
          stopKeepalive();
        }
      }

      case 'STORYLINE_UPLOAD': {
        // Upload one repackaged storyline zip to the TARGET Review 360 over
        // socket.io, then resolve its published contentPrefix. The review-sockets
        // host follows the plane of the tab this runs in (pinned when the caller
        // pinned the run).
        const resolved = await resolveTarget(pin);
        if (!resolved.ok) {
          return { type: 'STORYLINE_UPLOAD_RESULT', result: { ok: false, error: resolved.error } };
        }
        const { plane } = resolved.target;
        const token = tokenFor(plane);
        if (!token) {
          return {
            type: 'STORYLINE_UPLOAD_RESULT',
            result: { ok: false, error: noTokenForPlaneMessage(plane) },
          };
        }
        const userId = await readAccountUserId(pin);
        if (!userId) {
          return {
            type: 'STORYLINE_UPLOAD_RESULT',
            result: { ok: false, error: 'No target account user id (open a logged-in Rise/360 tab).' },
          };
        }
        const base = reviewSocketBaseForPlane(plane);
        const trace: string[] = [`base=${base}`, `user=${userId.slice(0, 12)}`];
        let socket: Awaited<ReturnType<typeof connectReviewSocket>> | null = null;
        // Minutes of socket wait with no extension-API traffic — keep the worker
        // (and this pending response) alive.
        const stopKeepalive = startKeepalive();
        try {
          socket = await connectReviewSocket({ userId, token, base });
          trace.push('connected');
          const zipBytes = Uint8Array.from(atob(msg.zipB64), (c) => c.charCodeAt(0));
          const { itemId, key } = await uploadStorylinePackage({
            socket,
            userId,
            fileName: msg.fileName,
            zipBytes,
            md5Base64: msg.md5Base64,
            md5Hex: msg.md5Hex,
            // Cross-origin presigned PUT with Content-MD5 (reuse the same base64
            // bytes/md5 the panel computed; bytes arg is identical).
            putBytes: async (url) => {
              const r = await relayWrite(
                s3PutReview({ url, base64Body: msg.zipB64, contentMd5Base64: msg.md5Base64 }),
                pin,
              );
              if (!r.ok) throw new Error(`S3 PUT HTTP ${r.status}: ${(r.text ?? '').slice(0, 120)}`);
            },
          });
          trace.push(`item ${itemId.slice(0, 8)}`, `key ${key.split('/').pop()}`);
          const contentPrefix = await awaitContentPrefix(socket, itemId, { timeoutMs: 180_000 });
          trace.push(`prefix ${contentPrefix}`);
          return {
            type: 'STORYLINE_UPLOAD_RESULT',
            result: { ok: true, status: 200, data: { itemId, contentPrefix, key } },
          };
        } catch (e) {
          return {
            type: 'STORYLINE_UPLOAD_RESULT',
            result: { ok: false, error: `${(e as Error).message} [${trace.join(' → ')}]` },
          };
        } finally {
          stopKeepalive();
          try {
            socket?.disconnect();
          } catch {
            /* ignore */
          }
        }
      }

      case 'REAUTH': {
        // Force a fresh bearer on demand (panel calls this before each course).
        // Report whether the token actually advanced vs is merely still valid so
        // the panel can log honestly instead of claiming a refresh that no-op'd.
        const { advanced, valid, via } = await reauth(pin);
        const resolved = await resolveTarget(pin);
        const identity = slotFor(resolved.ok ? resolved.target.plane : null)?.identity ?? null;
        return { type: 'REAUTH_RESULT', advanced, valid, via, identity };
      }
    }
  }

  browser.runtime.onMessage.addListener(
    (
      msg: BackgroundRequest | ContentMessage,
      _sender,
      sendResponse: (r: BackgroundResponse) => void,
    ) => {
      // Content-script presence pings — no response needed.
      if (msg.type === 'RISE_PRESENT') {
        risePresent = true;
        return false;
      }
      if (msg.type === 'RISE_GONE') {
        risePresent = false;
        return false;
      }
      if (msg.type === 'RISE_ACCOUNT') {
        accountName = msg.name;
        return false;
      }
      // ALWAYS answer: a throw anywhere outside a per-case try would otherwise
      // leave the panel awaiting a response that never arrives.
      handle(msg).then(sendResponse, (e: unknown) =>
        sendResponse({ type: 'ERROR', error: `Background error: ${String(e)}` }),
      );
      return true; // async response
    },
  );
});
