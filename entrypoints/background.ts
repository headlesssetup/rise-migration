// Background service worker: owns auth + fetch orchestration.
//   - Captures the bearer JWT by observing real Rise requests (webRequest).
//   - Runs API calls INSIDE the Rise tab (first-party cookies) via scripting,
//     because Rise's catalog/manage API is cookie-authenticated and a
//     SameSite cookie is withheld from an extension-origin (cross-site) fetch.
//   - Exposes typed fetch RPCs to the side panel (search, get-course).
//   - Pacing lives in the panel, NOT here.

import { identityFromToken, type Identity } from '@/core/auth/jwt';
import {
  buildGetCourseRequest,
  buildSearchRequest,
  REFRESH_URL,
  type RequestSpec,
} from '@/core/rise-client';
import type {
  BackgroundRequest,
  BackgroundResponse,
  ContentMessage,
  FetchResult,
} from '@/shared/messaging';

const TOKEN_KEY = 'riseToken';
const RISE_TAB_GLOB = 'https://rise.articulate.com/*';

interface InPageResult {
  ok: boolean;
  status: number;
  text?: string;
  error?: string;
}

// Executed INSIDE the Rise tab (isolated world) — a same-origin fetch that
// rides the live session's first-party cookies, plus the bearer if we have it.
// Must be self-contained (no closures): it is serialized by executeScript.
async function fetchInRiseTab(
  spec: { url: string; method: string; body?: string },
  token: string | null,
): Promise<InPageResult> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (spec.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(spec.url, {
      method: spec.method,
      headers,
      body: spec.body,
      credentials: 'include',
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
    { urls: ['https://rise.articulate.com/*'] },
    ['requestHeaders', 'extraHeaders'],
  );

  // Locate the live Rise tab and run the fetch inside it (first-party cookies).
  async function relayFetch(spec: RequestSpec): Promise<InPageResult> {
    const tabs = await chrome.tabs.query({ url: RISE_TAB_GLOB });
    const tab = tabs.find((t) => typeof t.id === 'number');
    if (!tab || typeof tab.id !== 'number') {
      return {
        ok: false,
        status: 0,
        error:
          'No open rise.articulate.com tab. Open and log into Rise, keep that tab open, then retry.',
      };
    }
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: fetchInRiseTab,
        args: [{ url: spec.url, method: spec.method, body: spec.body }, token],
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

  // --- In-page fetch with one-shot 401 refresh ------------------------------
  async function rawFetch(
    spec: RequestSpec,
    attempt = 0,
  ): Promise<FetchResult<string>> {
    const r = await relayFetch(spec);

    if (r.status === 401 && attempt === 0 && (await tryRefresh())) {
      return rawFetch(spec, 1);
    }
    if (r.status === 401) {
      return {
        ok: false,
        status: 401,
        error:
          'Unauthorized (401) from Rise. Make sure you are logged into the open Rise tab, then retry.',
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

  // Best-effort refresh (rides the id.articulate.com session cookie). The fresh
  // bearer is re-captured by the webRequest observer from subsequent page
  // traffic; this just nudges the session. Mechanics confirmed at runtime.
  async function tryRefresh(): Promise<boolean> {
    try {
      const res = await fetch(REFRESH_URL, {
        method: 'POST',
        credentials: 'include',
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function handle(
    msg: BackgroundRequest,
  ): Promise<BackgroundResponse> {
    switch (msg.type) {
      case 'GET_SESSION_STATE': {
        // Live tab query is authoritative (survives SW restarts; the content
        // script ping only updates the cached flag).
        let present = risePresent;
        try {
          const tabs = await chrome.tabs.query({ url: RISE_TAB_GLOB });
          present = tabs.some((t) => typeof t.id === 'number');
        } catch {
          /* keep the ping-based value */
        }
        return {
          type: 'SESSION_STATE',
          state: { hasToken: !!token, risePresent: present, identity },
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
      handle(msg).then(sendResponse);
      return true; // async response
    },
  );
});
