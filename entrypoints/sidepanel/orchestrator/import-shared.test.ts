import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { Storage } from '@/core/storage/storage';
import type { BackgroundRequest, BackgroundResponse } from '@/shared/messaging';
import { rpc } from '../rpc';
import {
  fetchTargetTypefaces,
  makePinnedRelay,
  refreshToken,
  relayThroughTab,
  s3PutHeaders,
  setupFolders,
} from './import-shared';
import type { ProgressEvent } from './shared';

// Every message the panel sends crosses this one seam, so mocking it lets each
// test assert exactly which requests carried the run's pin.
vi.mock('../rpc', () => ({ rpc: vi.fn() }));
const rpcMock = vi.mocked(rpc);

const PIN = { pinnedTabId: 7, expectedPlane: 'eu' as const };

const sink = (): { onEvent: (e: ProgressEvent) => void; logs: string[] } => {
  const logs: string[] = [];
  return { logs, onEvent: (e) => void (e.kind === 'log' && logs.push(e.message)) };
};

/** The requests the mocked background received, in order. */
const sent = (): BackgroundRequest[] => rpcMock.mock.calls.map((c) => c[0]);

const SIGNED_FONT_URL =
  'https://360-prod-eu-central-1-213152736482.s3.eu-central-1.amazonaws.com/rise/fonts/xvI6Ny9Vw3jxu9sa.woff' +
  '?Content-Type=font%2Fwoff&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260623T193258Z' +
  '&X-Amz-Expires=1800&X-Amz-Signature=deadbeef&X-Amz-SignedHeaders=host%3Bx-amz-acl&x-amz-acl=public-read';

describe('s3PutHeaders', () => {
  it('adds x-amz-acl when the presigned url signs it (font uploads)', () => {
    expect(s3PutHeaders(SIGNED_FONT_URL, 'font/woff')).toEqual({
      'Content-Type': 'font/woff',
      'x-amz-acl': 'public-read',
    });
  });

  it('does NOT add x-amz-acl when the url does not sign it (image uploads untouched)', () => {
    const url =
      'https://bucket.s3.amazonaws.com/rise/courses/x/img.png' +
      '?X-Amz-Signature=abc&X-Amz-SignedHeaders=host';
    expect(s3PutHeaders(url, 'image/png')).toEqual({ 'Content-Type': 'image/png' });
  });

  it('uses the signed acl value verbatim (not a hardcoded public-read)', () => {
    const url = 'https://b.s3.amazonaws.com/k?X-Amz-SignedHeaders=host%3Bx-amz-acl&x-amz-acl=private';
    expect(s3PutHeaders(url, 'font/woff')['x-amz-acl']).toBe('private');
  });

  it('omits Content-Type when none is given, still honoring the acl', () => {
    expect(s3PutHeaders(SIGNED_FONT_URL)).toEqual({ 'x-amz-acl': 'public-read' });
  });

  it('falls back to Content-Type only for an unparseable url', () => {
    expect(s3PutHeaders('not a url', 'font/woff')).toEqual({ 'Content-Type': 'font/woff' });
  });
})

// --- The panel-direct S3 PUT must not drop caller-supplied headers -------------

describe('relayThroughTab — panel-direct S3 PUT headers', () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('', { status: 200 }));
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const headersOf = (): Record<string, string> =>
    Object.fromEntries(new Headers(fetchMock.mock.calls[0]![1]!.headers).entries());

  it('passes spec.headers through (a Review-360 PUT signs content-md5;host)', async () => {
    // Dropping Content-MD5 here would 403 SignatureDoesNotMatch — the presigned
    // signature covers it, so the header is not optional.
    const res = await relayThroughTab({
      url: 'https://b.s3.amazonaws.com/k?X-Amz-SignedHeaders=content-md5%3Bhost',
      method: 'PUT' as const,
      noAuth: true,
      base64Body: '',
      contentType: 'application/zip',
      headers: { 'Content-MD5': 'zRoZK4uQTHo=' },
      label: 'PUT S3 (review)',
    });
    expect(res.ok).toBe(true);
    expect(headersOf()).toMatchObject({
      'content-type': 'application/zip',
      'content-md5': 'zRoZK4uQTHo=',
    });
    // and it never reached the background (bytes stay out of the message hop)
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('still derives x-amz-acl from the url when the caller supplies no headers', async () => {
    await relayThroughTab({
      url: SIGNED_FONT_URL,
      method: 'PUT' as const,
      noAuth: true,
      base64Body: '',
      contentType: 'font/woff',
      label: 'PUT S3 (font)',
    });
    expect(headersOf()).toMatchObject({ 'x-amz-acl': 'public-read', 'content-type': 'font/woff' });
  });

  it('lets a caller header win over the url-derived default', async () => {
    await relayThroughTab({
      url: SIGNED_FONT_URL,
      method: 'PUT' as const,
      noAuth: true,
      base64Body: '',
      contentType: 'font/woff',
      headers: { 'x-amz-acl': 'private' },
      label: 'PUT S3 (font)',
    });
    expect(headersOf()['x-amz-acl']).toBe('private');
  });
});

// --- C4: the run's pin reaches every shared write/read ------------------------

describe('the run pin (C4) on the shared helpers', () => {
  // Braces matter: `() => rpcMock.mockReset()` would RETURN the mock, and vitest
  // calls a hook's return value as a cleanup hook (i.e. invokes rpc with no args).
  beforeEach(() => {
    rpcMock.mockReset();
  });

  const TARGET_FOLDERS = JSON.stringify([
    { id: 'tRoot', name: 'Shared', isRoot: true, folderType: 'shared' },
  ]);
  const SOURCE_FOLDERS = JSON.stringify([
    { id: 'sRoot', name: 'Shared', isRoot: true, folderType: 'shared' },
    { id: 'sf1', name: 'Marketing', parentFolderId: 'sRoot', folderType: 'shared' },
  ]);
  const storageWithFolders = { readFolders: async () => SOURCE_FOLDERS } as unknown as Storage;
  const noPacing = { baseMs: 0, jitterMs: 0 };

  /** Background stub: answers the folder GET with the target tree and any POST
   *  with a new id. */
  function mockFolderBackground(): void {
    rpcMock.mockImplementation(async (req: BackgroundRequest): Promise<BackgroundResponse> => {
      if (req.type !== 'RELAY_WRITE') throw new Error(`unexpected ${req.type}`);
      const text = req.spec.method === 'GET' ? TARGET_FOLDERS : '{"id":"newF1"}';
      return { type: 'WRITE_RESULT', result: { ok: true, status: 200, text } };
    });
  }

  it('setupFolders pins BOTH the target-folder read and the create write', async () => {
    mockFolderBackground();
    const { onEvent } = sink();
    const map = await setupFolders(
      storageWithFolders,
      { userId: 'u1', plane: 'eu' },
      false,
      noPacing,
      onEvent,
      PIN,
    );
    expect(map.get('sf1')).toBe('newF1');
    const reqs = sent();
    expect(reqs).toHaveLength(3); // folder read + create + read-back re-list
    for (const r of reqs) expect(r.pin).toEqual(PIN);
    // the create is the write that used to be able to land in the SOURCE account
    const create = reqs.find((r) => r.type === 'RELAY_WRITE' && r.spec.method === 'POST');
    expect(create).toBeDefined();
    expect(create!.pin).toEqual(PIN);
  });

  it('setupFolders sends NO pin when called unpinned (export/back-compat path)', async () => {
    mockFolderBackground();
    const { onEvent } = sink();
    await setupFolders(storageWithFolders, { userId: 'u1' }, false, noPacing, onEvent);
    expect(sent()).toHaveLength(3); // read + create + read-back re-list
    for (const r of sent()) expect(r.pin).toBeUndefined();
  });

  it('setupFolders scoped to seed folder ids creates ONLY those chains', async () => {
    mockFolderBackground();
    const src = JSON.stringify([
      { id: 'sRoot', name: 'Shared', isRoot: true, folderType: 'shared' },
      { id: 'sf1', name: 'Marketing', parentFolderId: 'sRoot', folderType: 'shared' },
      { id: 'sf2', name: 'Sales', parentFolderId: 'sRoot', folderType: 'shared' },
    ]);
    const st = { readFolders: async () => src } as unknown as Storage;
    const { onEvent } = sink();
    const map = await setupFolders(st, { userId: 'u1' }, false, noPacing, onEvent, undefined, [
      'sf1',
    ]);
    expect(map.get('sf1')).toBe('newF1');
    expect(map.has('sf2')).toBe(false); // Sales holds no selected course → untouched
    const creates = sent().filter((r) => r.type === 'RELAY_WRITE' && r.spec.method === 'POST');
    expect(creates).toHaveLength(1);
  });

  it('setupFolders with an all-root/unknown scope creates nothing and skips the target read', async () => {
    mockFolderBackground();
    const { onEvent } = sink();
    const map = await setupFolders(storageWithFolders, { userId: 'u1' }, false, noPacing, onEvent, undefined, [
      'sRoot',
    ]);
    expect(map.size).toBe(0);
    expect(sent()).toHaveLength(0); // early-out before any relay traffic
  });

  it('fetchTargetTypefaces pins the course probe AND the typeface read', async () => {
    rpcMock.mockImplementation(async (req: BackgroundRequest): Promise<BackgroundResponse> => {
      if (req.type === 'SEARCH_COURSES') {
        return {
          type: 'SEARCH_RESULT',
          result: { ok: true, status: 200, data: { items: [{ id: 'live1', title: 'x' }] } as never },
        };
      }
      return {
        type: 'RAW_RESULT',
        kind: 'typefaces',
        result: {
          ok: true,
          status: 200,
          data: { raw: '[]', doc: [{ id: 'tf1', name: 'Inter', fonts: [] }] },
        },
      };
    });
    const { onEvent } = sink();
    const map = await fetchTargetTypefaces(onEvent, PIN);
    expect(map.size).toBe(1);
    // an UNPINNED probe could read a course id from the SOURCE library and then
    // ask the source account for its fonts
    expect(sent().map((r) => r.type)).toEqual(['SEARCH_COURSES', 'FETCH_TYPEFACES']);
    for (const r of sent()) expect(r.pin).toEqual(PIN);
  });

  it('refreshToken pins REAUTH so the pinned plane is the one refreshed', async () => {
    rpcMock.mockResolvedValue({
      type: 'REAUTH_RESULT',
      advanced: true,
      valid: true,
      via: 'tab-reload',
      identity: null,
    });
    const { onEvent, logs } = sink();
    await refreshToken(onEvent, 'run start', PIN);
    expect(sent()).toEqual([{ type: 'REAUTH', pin: PIN }]);
    expect(logs[0]).toMatch(/Token refreshed \(run start\) \(via Rise tab reload\)/);
  });

  it('refreshToken stays unpinned (and works) for the export-side callers', async () => {
    rpcMock.mockResolvedValue({
      type: 'REAUTH_RESULT',
      advanced: false,
      valid: true,
      identity: null,
    });
    const { onEvent, logs } = sink();
    await refreshToken(onEvent, 'run start');
    expect(sent()).toEqual([{ type: 'REAUTH' }]);
    expect(logs[0]).toMatch(/Token still valid/);
  });

  it('makePinnedRelay returns the plain relay when there is no pin, and pins otherwise', async () => {
    rpcMock.mockResolvedValue({
      type: 'WRITE_RESULT',
      result: { ok: true, status: 200, text: '{}' },
    });
    expect(makePinnedRelay(undefined)).toBe(relayThroughTab);
    const spec = { url: '/x', method: 'POST' as const, body: '{}', label: 'POST /x' };
    await makePinnedRelay(PIN)(spec);
    expect(sent()).toEqual([{ type: 'RELAY_WRITE', spec, pin: PIN }]);
  });

  it('surfaces a pinned relay error instead of swallowing it (loud failure)', async () => {
    rpcMock.mockResolvedValue({ type: 'ERROR', error: 'Pinned target Rise tab is gone' });
    const r = await makePinnedRelay(PIN)({ url: '/x', method: 'POST' as const, label: 'POST /x' });
    expect(r).toMatchObject({ ok: false, status: 0, error: 'Pinned target Rise tab is gone' });
  });
});
