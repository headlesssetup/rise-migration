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
  buildReviewItemsRequest,
  buildSearchRequest,
  REFRESH_URL,
  type RequestSpec,
} from '@/core/rise-client';
import { RISE_TAB_GLOBS } from '@/shared/hosts';
import type {
  BackgroundRequest,
  BackgroundResponse,
  ContentMessage,
  FetchResult,
  RawKind,
} from '@/shared/messaging';

const TOKEN_KEY = 'riseToken';

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

  // Locate the live Rise tab and run the fetch inside it (first-party cookies).
  async function relayFetch(spec: RequestSpec): Promise<InPageResult> {
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
        // script ping only updates the cached flag).
        let present = risePresent;
        try {
          const tabs = await chrome.tabs.query({ url: RISE_TAB_GLOBS });
          present = tabs.some((t) => typeof t.id === 'number');
        } catch {
          /* keep the ping-based value */
        }
        return {
          type: 'SESSION_STATE',
          state: { hasToken: !!token, risePresent: present, identity, accountName },
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

      case 'REVIEW_ITEMS':
        return rawResult(
          'reviewItems',
          buildReviewItemsRequest(),
          'Review items response',
        );
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
