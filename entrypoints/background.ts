// Background service worker: owns auth + cross-origin fetch.
//   - Captures the bearer JWT by observing real Rise requests (webRequest).
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

  // --- Cross-origin fetch with bearer + one-shot 401 refresh ----------------
  async function rawFetch(
    spec: RequestSpec,
    attempt = 0,
  ): Promise<FetchResult<string>> {
    if (!token) {
      return {
        ok: false,
        error:
          'No Rise token captured yet. Open a logged-in rise.articulate.com tab and interact with it.',
      };
    }
    let res: Response;
    try {
      res = await fetch(spec.url, {
        method: spec.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(spec.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: spec.body,
        credentials: 'omit',
      });
    } catch (e) {
      return { ok: false, error: `Network error: ${(e as Error).message}` };
    }

    if (res.status === 401 && attempt === 0 && (await tryRefresh())) {
      return rawFetch(spec, 1);
    }
    if (res.status === 401) {
      return {
        ok: false,
        status: 401,
        error:
          'Unauthorized — token expired. Re-interact with the Rise tab to capture a fresh token, then retry.',
      };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, data: await res.text() };
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
      case 'GET_SESSION_STATE':
        return {
          type: 'SESSION_STATE',
          state: { hasToken: !!token, risePresent, identity },
        };

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
