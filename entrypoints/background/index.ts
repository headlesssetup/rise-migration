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
import { fetchInRiseTab, type InPageResult, type RelaySpec } from './rise-fetch';
import {
  findCourseEditorTab,
  findRiseTab,
  readAccountUserId,
  resolveTarget,
  waitForCreatedTabComplete,
  waitForTabComplete,
  type Plane,
} from './tabs';
import { createReauth } from './reauth';
import {
  handleStorylineExport,
  handleStorylineUpload,
  type StorylineHandlerDeps,
} from './storyline-handlers';
import { risePlaneFromUrl } from '@/shared/messaging';
import { courseEditorUrl, editorCourseIdFromUrl } from '@/shared/rise-editor';
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
  //
  // Registration is try/caught: a host-permission mismatch on the filter must
  // NOT prevent onMessage from registering (that left the panel on Connecting…).
  try {
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
  } catch (e) {
    console.error('webRequest token sniffer failed to register:', e);
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
      return {
        ok: false,
        status: 0,
        error: noTokenForPlaneMessage(plane),
        code: 'AUTH_REQUIRED',
      };
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
    refreshCourseId?: string,
  ): Promise<FetchResult<string>> {
    const r = await relayFetch(spec, pin);
    const authFailure = r.code === 'AUTH_REQUIRED' || r.status === 401 || r.status === 403;

    // An expired bearer reads back as 401 OR 403 (the authoring endpoints answer
    // 403 "Forbidden"); a cold/restarted worker can also have no bearer yet.
    // Re-auth and retry once, but ONLY if the token actually advanced; retrying
    // with the same stale token just fails again. Throttled except when a
    // GET_COURSE supplies its own bounded editor-bootstrap recovery route.
    if (
      authFailure &&
      attempt === 0 &&
      (refreshCourseId !== undefined || reauthAllowed()) &&
      (await reauth(pin, refreshCourseId)).advanced
    ) {
      return rawFetch(spec, pin, 1, refreshCourseId);
    }
    if (authFailure) {
      // F6: the bearer did not advance (or reauth is throttled) — the fix is a
      // course-editor boot on THIS plane's account, not a plain re-login.
      return {
        ok: false,
        status: r.status || undefined,
        code: 'AUTH_REQUIRED',
        error:
          `${r.status ? `Unauthorized (${r.status}) from Rise` : 'No usable Rise bearer was available'} and the bearer did not refresh. ` +
          `Automatic course-editor recovery did not produce a new token. ` +
          `Make sure the Rise session is still logged in, then retry.`,
      };
    }
    if (!r.ok) {
      return {
        ok: false,
        status: r.status || undefined,
        error: r.error ?? `HTTP ${r.status}`,
        code: r.code,
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

  // Token refresh (strategy comment + TODO(refresh) live in ./reauth).
  const { reauthAllowed, reauth, tokenExpiringSoon } = createReauth({
    auth,
    slotFor,
    grabTokenForUrl,
  });


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

  // Closure-backed deps for the extracted Storyline handlers (./storyline-handlers).
  const storylineDeps: StorylineHandlerDeps = {
    tokenFor,
    tokenExpiringSoon,
    reauthAllowed,
    reauth,
    grabTokenForUrl,
    relayWrite,
    startKeepalive,
  };

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
        let editorCourseId: string | null = null;
        try {
          const all = await chrome.tabs.query({ url: RISE_TAB_GLOBS });
          present = all.some((t) => typeof t.id === 'number');
          const writeTab = await findRiseTab();
          const url = writeTab?.url ?? all.find((t) => typeof t.url === 'string')?.url;
          plane = risePlaneFromUrl(url);
          // The course open in the editor: prefer the write tab; else, if the
          // profile has exactly ONE editor tab open, use that (an ambiguous
          // multi-editor setup stays null rather than guessing).
          editorCourseId = editorCourseIdFromUrl(writeTab?.url);
          if (!editorCourseId) {
            const editors = all
              .map((t) => editorCourseIdFromUrl(t.url))
              .filter((id): id is string => id !== null);
            if (editors.length === 1) editorCourseId = editors[0] ?? null;
          }
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
            editorCourseId,
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
          buildSearchRequest({ page: msg.page, pageSize: msg.pageSize, term: msg.term }),
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
        // The course id also gives auth recovery a safe, capture-confirmed
        // editor route. If the short-lived bearer expires and only the dashboard
        // is open, the background can boot this course in an inactive temporary
        // tab, capture the new cookie, close the tab, and retry this same read.
        const r = await rawFetch(buildGetCourseRequest(msg.courseId), pin, 0, msg.courseId);
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
        return handleStorylineExport(msg, pin, storylineDeps);
      }

      case 'STORYLINE_UPLOAD': {
        return handleStorylineUpload(msg, pin, storylineDeps);
      }

      case 'REAUTH': {
        // Force a fresh bearer on demand (panel calls this before each course).
        // Report whether the token actually advanced vs is merely still valid so
        // the panel can log honestly instead of claiming a refresh that no-op'd.
        const { advanced, valid, via } = await reauth(pin, msg.courseId);
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
