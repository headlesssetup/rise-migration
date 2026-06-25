// Background service worker: owns auth + fetch orchestration.
//   - Captures the bearer JWT by observing real Rise requests (webRequest).
//   - Runs API calls INSIDE the Rise tab (first-party cookies) via scripting,
//     because Rise's catalog/manage API is cookie-authenticated and a
//     SameSite cookie is withheld from an extension-origin (cross-site) fetch.
//   - Exposes typed fetch RPCs to the side panel (search, get-course).
//   - Pacing lives in the panel, NOT here.

import { identityFromToken, type Identity } from '@/core/auth/jwt';
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
import { awaitExportLocation, type WsLike } from '@/core/storyline/ws-export-client';
import { planeFromHost } from '@/core/import/guards';
import { RISE_TAB_GLOBS } from '@/shared/hosts';
import type {
  BackgroundRequest,
  BackgroundResponse,
  ContentMessage,
  FetchResult,
  RawKind,
  WriteRelayResult,
} from '@/shared/messaging';

const TOKEN_KEY = 'riseToken';

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
  let token: string | null = null;
  let identity: Identity | null = null;
  let risePresent = false;
  let accountName: string | null = null;

  // Restore a token captured earlier this browser session (session storage is
  // cleared when the browser closes — we never persist credentials to disk).
  browser.storage.session
    .get(TOKEN_KEY)
    .then((r) => {
      const t = r[TOKEN_KEY];
      if (typeof t === 'string') {
        token = t;
        identity = identityFromToken(t);
      }
    })
    .catch(() => {});

  function setToken(next: string): void {
    if (next === token) return;
    token = next;
    identity = identityFromToken(next);
    browser.storage.session.set({ [TOKEN_KEY]: next }).catch(() => {});
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
  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const auth = details.requestHeaders?.find(
        (h) => h.name.toLowerCase() === 'authorization',
      );
      const value = auth?.value;
      if (value && /^Bearer\s+/i.test(value)) {
        setToken(value.replace(/^Bearer\s+/i, '').trim());
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

  // Read the bearer straight from the `_articulate_rise_` cookie — its value IS
  // the access token Rise sends as `Authorization: Bearer`. This needs no course
  // navigation and no page reload: the Cookies API reads it (even httpOnly) for
  // the live tab's plane. Returns true ONLY if a NEW (rotated) JWT was captured —
  // re-reading the same stale cookie is not a refresh and must not read as one.
  async function grabTokenFromCookie(): Promise<boolean> {
    const tab = await findRiseTab();
    const url = tab?.url;
    if (!url) return false;
    try {
      const c = await browser.cookies.get({ url, name: '_articulate_rise_' });
      const value = c?.value?.trim();
      // A JWT has three dot-separated segments; guard against a stray cookie.
      if (value && value.split('.').length === 3) {
        const changed = value !== token;
        setToken(value);
        return changed;
      }
    } catch {
      /* cookies permission/host missing — fall back to the reload path */
    }
    return false;
  }

  // The account-local Rise user id (`_articulate_user_id` cookie) — the valid
  // principal for folder ownership. May be URL-encoded (`auth0%7C…`).
  async function readAccountUserId(): Promise<string | null> {
    const tab = await findRiseTab();
    const url = tab?.url;
    if (!url) return null;
    try {
      const c = await browser.cookies.get({ url, name: '_articulate_user_id' });
      const raw = c?.value?.trim();
      if (!raw) return null;
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }

  // Locate the live Rise tab and run the fetch inside it (first-party cookies).
  async function relayFetch(spec: RelaySpec): Promise<InPageResult> {
    const tab = await findRiseTab();
    if (!tab || typeof tab.id !== 'number') {
      return {
        ok: false,
        status: 0,
        error:
          'No open Rise tab (US rise.articulate.com or EU rise.eu.articulate.com). Open and log into Rise, keep that tab open, then retry.',
      };
    }
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
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
    attempt = 0,
  ): Promise<FetchResult<string>> {
    const r = await relayFetch(spec);

    // An expired bearer reads back as 401 OR 403 (the authoring endpoints answer
    // 403 "Forbidden") — re-auth and retry once, but ONLY if the token actually
    // advanced; retrying with the same stale token just 403s again.
    if ((r.status === 401 || r.status === 403) && attempt === 0 && (await reauth()).advanced) {
      return rawFetch(spec, 1);
    }
    if (r.status === 401 || r.status === 403) {
      return {
        ok: false,
        status: r.status,
        error: `Unauthorized (${r.status}) from Rise. Make sure you are logged into the open Rise tab, then retry.`,
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
  async function relayWrite(spec: WriteSpec): Promise<WriteRelayResult> {
    // Proactive: refresh before the token lapses so a long import never trips a
    // mid-flight 403 (throttled, so a non-rotating token can't spam refresh).
    if (tokenExpiringSoon() && Date.now() - lastReauthMs > 30_000) await reauth();
    let r = await relayFetch(spec);
    // Reactive: Rise returns 401 OR 403 on an expired/invalid bearer — re-auth
    // and retry once, but ONLY if the token actually advanced (a non-rotating
    // refresh would just 403 again on the retry).
    if ((r.status === 401 || r.status === 403) && (await reauth()).advanced) {
      r = await relayFetch(spec);
    }
    return { ok: r.ok, status: r.status, text: r.text ?? '', error: r.error };
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

  // Resolve when a tab finishes loading (or a timeout elapses). Used after a
  // reload so we don't re-read the cookie before the SPA has booted. status is
  // readable without the "tabs" permission for a host we hold permission for.
  function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
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
        .then((t) => {
          if (t.status === 'complete') finish();
        })
        .catch(() => {});
      setTimeout(finish, timeoutMs);
    });
  }

  // Fallback refresh: reload the Rise tab so the SPA runs its OWN (native) Okta
  // silent re-auth on boot and writes a rotated `_articulate_rise_` cookie, then
  // poll the cookie until its `exp` advances. This piggybacks on Rise's own,
  // battle-tested refresh instead of replicating the Okta flow ourselves — far
  // more robust than the injected iframe, at the cost of a visible reload. Safe
  // mid-import: reauth only runs BETWEEN paced writes (proactive heartbeat) or
  // AFTER a write already returned 403, so no write is in flight during reload.
  // IMPORTANT: only a COURSE EDITOR boot rotates the bearer — reloading the
  // dashboard does NOT (operator-confirmed 2026-06-23). So this reload only helps
  // when the active Rise tab is a course editor; if it's the dashboard the poll
  // times out and we report no-advance honestly (the panel then tells the
  // operator to open a course). We reload the active/last-focused Rise tab (the
  // one the operator is looking at and that writes already ride).
  async function reloadRiseTabForToken(): Promise<boolean> {
    const tab = await findRiseTab();
    if (!tab || typeof tab.id !== 'number') return false;
    const before = identity?.expiresAt ?? 0;
    try {
      await chrome.tabs.reload(tab.id);
    } catch {
      return false;
    }
    await waitForTabComplete(tab.id, 20_000);
    // The SPA's auth bootstrap is async after load — poll the cookie for advance.
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      await grabTokenFromCookie();
      if ((identity?.expiresAt ?? 0) > before) return true;
      await new Promise((r) => setTimeout(r, 750));
    }
    return false;
  }

  // Re-establish a fresh bearer mid-import.
  //   1. Re-read the cookie — the editor may have already rotated it (the
  //      operator opened/refreshed a course, or its own token service fired).
  //      During an import there's no page traffic for the webRequest observer to
  //      catch, so we must pull the rotated cookie ourselves.
  //   2. If that didn't advance AND the token actually needs refreshing
  //      (expiring/expired), reload the Rise tab so the SPA refreshes natively
  //      (the only refresh that works in practice — see reloadRiseTabForToken).
  // Reports honestly:
  //   - `advanced`: true ONLY when `exp` actually moved forward (a real
  //     rotation). A "refresh" that doesn't advance `exp` is a no-op, and
  //     retrying a write with it just 403s again.
  //   - `valid`: we currently hold a non-expired token (rotated or not).
  //   - `via`: how the bearer was (re)obtained — for honest logging.
  // Throttled by the callers so a doomed token can't spam the reload.
  let lastReauthMs = 0;
  async function reauth(): Promise<{
    advanced: boolean;
    valid: boolean;
    via: 'tab-reload' | 'cookie' | 'none';
  }> {
    lastReauthMs = Date.now();
    const before = identity?.expiresAt ?? 0;
    const rotatedByCookie = await grabTokenFromCookie();
    let via: 'tab-reload' | 'cookie' | 'none' =
      (identity?.expiresAt ?? 0) > before && rotatedByCookie ? 'cookie' : 'none';

    // Cookie re-read didn't rotate. If the token genuinely needs refreshing, let
    // the Rise SPA do it via a tab reload. When the token is still healthy we
    // skip the reload — no point disrupting the tab.
    if ((identity?.expiresAt ?? 0) <= before && tokenExpiringSoon()) {
      if (await reloadRiseTabForToken()) via = 'tab-reload';
    }

    const after = identity?.expiresAt ?? 0;
    const advanced = after > before;
    const valid = identity?.expiresAt !== undefined && identity.expiresAt > Date.now();
    return { advanced, valid, via };
  }

  // The held bearer is short-lived (~15 min). On a long import it expires
  // mid-run; Rise answers an expired token on the authoring endpoints with 403
  // (not 401) — e.g. GET_YURL "Forbidden" — so we must treat 403 as re-auth too.
  function tokenExpiringSoon(skewMs = 60_000): boolean {
    return identity?.expiresAt !== undefined && identity.expiresAt - skewMs <= Date.now();
  }

  // Fetch a raw JSON resource and wrap it as a RAW_RESULT (shared by the
  // account-level exports: block templates, typefaces, review items).
  async function rawResult(
    kind: RawKind,
    spec: RequestSpec,
    label: string,
  ): Promise<BackgroundResponse> {
    const r = await rawFetch(spec);
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
    switch (msg.type) {
      case 'GET_SESSION_STATE': {
        // Live tab query is authoritative (survives SW restarts; the content
        // script ping only updates the cached flag). Derive the plane from the
        // SAME tab writes target (active/last-focused first, then any Rise tab)
        // so a US-source + EU-target multi-tab setup reports the plane writes
        // actually go to — the Source ≠ Target guard depends on it.
        let present = risePresent;
        let plane: 'us' | 'eu' | null = null;
        try {
          const all = await chrome.tabs.query({ url: RISE_TAB_GLOBS });
          present = all.some((t) => typeof t.id === 'number');
          const writeTab = await findRiseTab();
          const url = writeTab?.url ?? all.find((t) => typeof t.url === 'string')?.url;
          plane = planeFromHost(url);
        } catch {
          /* keep the ping-based value */
        }
        // Opportunistically grab the bearer from the cookie when we don't have
        // one yet — so the panel shows a ready session without the operator
        // clicking "grab token" or opening a course.
        if (!token && present) await grabTokenFromCookie();
        const userId = present ? await readAccountUserId() : null;
        return {
          type: 'SESSION_STATE',
          state: { hasToken: !!token, risePresent: present, identity, accountName, plane, userId },
        };
      }

      case 'SEARCH_COURSES': {
        const r = await rawFetch(
          buildSearchRequest({ page: msg.page, pageSize: msg.pageSize }),
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
        const r = await rawFetch(buildGetCourseRequest(msg.courseId));
        if (!r.ok) return { type: 'COURSE_RESULT', result: r };
        try {
          const parsed = JSON.parse(r.data) as { payload?: unknown };
          // Save the raw body verbatim; the census walks the payload.
          const doc = (parsed.payload ?? parsed) as Record<string, unknown>;
          return {
            type: 'COURSE_RESULT',
            result: { ok: true, status: r.status, data: { raw: r.data, doc } },
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
        const r = await rawFetch(buildListFoldersRequest());
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
        const r = await rawFetch(buildListQuestionBanksRequest());
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
        const r = await rawFetch(buildGetQuestionBankRequest(msg.bankId));
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
        );

      case 'FETCH_TYPEFACES':
        return rawResult(
          'typefaces',
          buildFetchTypefacesRequest(msg.courseId),
          'Typefaces response',
        );

      case 'RELAY_WRITE':
        return { type: 'WRITE_RESULT', result: await relayWrite(msg.spec) };

      case 'STORYLINE_EXPORT': {
        // Trigger the web/raw export and await its zip URL on the ws.eu socket.
        // The socket runs here so the bearer never leaves the background; the
        // build/raw POST is sent only AFTER `identify` so we can't miss the
        // completion notify. One course at a time (the panel paces the loop), so
        // the first package:success is ours.
        if (!token) {
          return {
            type: 'STORYLINE_EXPORT_RESULT',
            result: { ok: false, error: 'No Rise token captured yet.' },
          };
        }
        const sessionId = crypto.randomUUID();
        const { spec } = buildRawExportRequest({
          courseId: msg.courseId,
          title: msg.title,
          websocketSessionId: sessionId,
        });
        try {
          const loc = await awaitExportLocation({
            token,
            sessionId,
            connect: (url) => new WebSocket(url) as unknown as WsLike,
            onIdentified: async () => {
              const r = await relayWrite(spec);
              if (!r.ok) {
                throw new Error(`build/raw HTTP ${r.status}: ${(r.text ?? '').slice(0, 200)}`);
              }
              parseBuildAck(r.text); // assert a jobId came back
            },
          });
          return {
            type: 'STORYLINE_EXPORT_RESULT',
            result: { ok: true, status: 200, data: loc },
          };
        } catch (e) {
          return {
            type: 'STORYLINE_EXPORT_RESULT',
            result: { ok: false, error: (e as Error).message },
          };
        }
      }

      case 'REAUTH': {
        // Force a fresh bearer on demand (panel calls this before each course).
        // Report whether the token actually advanced vs is merely still valid so
        // the panel can log honestly instead of claiming a refresh that no-op'd.
        const { advanced, valid, via } = await reauth();
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
      handle(msg).then(sendResponse);
      return true; // async response
    },
  );
});
