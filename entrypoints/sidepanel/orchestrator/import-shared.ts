// Phase 3 — shared import plumbing used by all three import operations
// (A: account settings, B: question banks, C: course import). Split out of the
// old monolithic import.ts so each operation file stays focused and readable.
// Holds the bearer refresh, the panel/background Relay, base64 ⇄ bytes helpers,
// archive readers shared across operations, folder recreation, and the cross-step
// id maps persisted under `_import/` (A → B → C).

import {
  parseTypefaces,
  parseFolders,
  rootIdsByType,
  orderForCreation,
  ownerPermissions,
  createFolder,
  fetchFolders,
  type AccountIdentity,
  type Typeface,
  type Relay,
  type RelayResponse,
  type WriteSpec,
} from '@/core/import';
import { pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import { rpc } from '../rpc';
import { extractItems, type ProgressEvent } from './shared';

/**
 * Force a fresh bearer before a (possibly long) stretch of writes. The held
 * token is ~15 min and an import is write-quiet, so the webRequest observer
 * never sees a fresh bearer to capture — we must pull a rotated one ourselves.
 * Non-mutating (a session refresh + cookie re-read), so it's safe in dry-run too
 * and makes the dry-run preview reads (FETCH_TYPEFACES) accurate. Best-effort:
 * on failure we still proceed and let the reactive 401/403 retry catch up.
 */
export async function refreshToken(
  onEvent: (e: ProgressEvent) => void,
  label?: string,
): Promise<void> {
  const tag = label ? ` (${label})` : '';
  try {
    const resp = await rpc({ type: 'REAUTH' });
    if (resp.type === 'REAUTH_RESULT') {
      const exp = resp.identity?.expiresAt
        ? new Date(resp.identity.expiresAt).toLocaleTimeString()
        : 'unknown';
      if (resp.advanced) {
        const how = resp.via === 'tab-reload' ? ' (via Rise tab reload)' : '';
        onEvent({ kind: 'log', message: `Token refreshed${tag}${how} — valid until ${exp}` });
      } else if (resp.valid) {
        // The cookie didn't rotate but the token we hold is still good — no need.
        onEvent({ kind: 'log', message: `Token still valid${tag} — valid until ${exp}` });
      } else {
        onEvent({
          kind: 'log',
          message: `WARN token refresh failed${tag} — keep a Rise COURSE (editor) tab open, not just the dashboard; that's what refreshes the session. Then retry.`,
        });
      }
    } else {
      onEvent({ kind: 'log', message: `WARN token refresh failed${tag} — using current session cookie` });
    }
  } catch {
    onEvent({ kind: 'log', message: `WARN token refresh errored${tag} — using current session cookie` });
  }
}

/** Decode a base64 body to a Blob (a valid fetch BodyInit) for the S3 PUT. */
function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * S3 upload PUT (presigned, noAuth) — executed DIRECT from the side panel so the
 * bytes don't cross the 64MB chrome.runtime message hops (panel→background→tab).
 * host_permissions for the S3 buckets exempt this cross-origin fetch from CORS;
 * the presigned URL carries its own signature, so no cookies/bearer. Lifts the old
 * 64MB cap — the only ceiling is now memory (see MAX_UPLOAD_BASE64).
 */
async function panelS3Put(spec: WriteSpec): Promise<RelayResponse> {
  try {
    const body = base64ToBlob(spec.base64Body ?? '', spec.contentType || 'application/octet-stream');
    const res = await fetch(spec.url, {
      method: 'PUT',
      headers: spec.contentType ? { 'Content-Type': spec.contentType } : {},
      body,
      credentials: 'omit',
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String(e) };
  }
}

/** The Relay the executor uses. S3 upload PUTs go direct from the panel (no 64MB
 *  message cap); everything else rides one RELAY_WRITE round-trip to the background
 *  (which needs the bearer + first-party cookies in the Rise tab). */
export const relayThroughTab: Relay = async (spec) => {
  if (spec.method === 'PUT' && spec.noAuth && spec.base64Body !== undefined) {
    return panelS3Put(spec);
  }
  const resp = await rpc({ type: 'RELAY_WRITE', spec });
  if (resp.type !== 'WRITE_RESULT') {
    return { ok: false, status: 0, text: '', error: 'unexpected background response' };
  }
  return resp.result;
};

/** Base64-encode bytes in chunks (avoids the call-stack limit of a single
 *  String.fromCharCode spread on large media). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Read the source account identity recorded in the archive manifest (for the
 *  Source ≠ Target guard). Older archives may not carry it. */
export async function readSourceIdentity(
  storage: Storage,
): Promise<AccountIdentity | undefined> {
  const raw = await storage.readManifest();
  if (!raw) return undefined;
  try {
    const m = JSON.parse(raw) as { sourceAccount?: AccountIdentity };
    return m.sourceAccount;
  } catch {
    return undefined;
  }
}

/** Fetch the TARGET account's typefaces once, via FETCH_TYPEFACES on a *live
 *  existing* course (page-0 of the live library). The brand-new course can't be
 *  used as context — it 404s until it settles — so we ask an existing one. A
 *  read, so it runs in dry-run too (accurate preview). Empty map on any failure
 *  (the executor then treats all source brand fonts as custom → recreate). */
export async function fetchTargetTypefaces(
  onEvent: (e: ProgressEvent) => void,
): Promise<Map<string, Typeface>> {
  let courseId: string | undefined;
  try {
    const resp = await rpc({ type: 'SEARCH_COURSES', page: 0, pageSize: 1 });
    if (resp.type === 'SEARCH_RESULT' && resp.result.ok) {
      courseId = extractItems(resp.result.data)[0]?.id;
    }
  } catch {
    /* fall through to empty */
  }
  if (!courseId) {
    onEvent({
      kind: 'log',
      message: 'No live target course to read fonts from — custom fonts will be recreated',
    });
    return new Map();
  }
  const resp = await rpc({ type: 'FETCH_TYPEFACES', courseId });
  if (resp.type !== 'RAW_RESULT' || !resp.result.ok) {
    onEvent({ kind: 'log', message: 'Could not read target fonts — custom fonts will be recreated' });
    return new Map();
  }
  const target = parseTypefaces(resp.result.data.doc);
  onEvent({ kind: 'log', message: `Target account has ${target.size} typefaces (font matching enabled)` });
  return target;
}

export function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Recreate the source folder tree on the target (parent-first), deduped by
 * name+parent against the target's existing folders so re-runs don't spawn
 * duplicates. Returns source folderId → target folderId.
 */
// Folders are created WITH an owner ACL in the create call (the importing admin
// as owner). A folder with NO owner 500s the dashboard's content query — and the
// repair PATCH .../permissions ALSO 500s on an already-broken folder, so we must
// never create one owner-less. The owner principal is the account-local Rise user
// id (`_articulate_user_id`); the token `sub` is rejected "Invalid users" on a
// cross-plane session. Sharing with other team members stays manual.
// See docs/rise-import-protocol.md §10b.
export async function setupFolders(
  storage: Storage,
  target: AccountIdentity | undefined,
  dryRun: boolean,
  pacing: PacingConfig,
  onEvent: (e: ProgressEvent) => void,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const raw = await storage.readFolders();
  if (!raw) return map;
  const source = parseFolders(safeJson(raw));
  const toCreate = orderForCreation(source);
  if (!toCreate.length) return map;

  const owner = ownerPermissions(target ?? {});
  if (owner.length === 0 && !dryRun) {
    onEvent({
      kind: 'log',
      message: 'Folders skipped: no account-local user id to own them (open a logged-in Rise tab).',
    });
    return map;
  }

  // Target roots + an existing-folder index (parent|name → id) for dedup.
  let roots: { shared?: string; private?: string } = { shared: 'dry-shared', private: 'dry-private' };
  const existing = new Map<string, string>();
  if (!dryRun) {
    const resp = await relayThroughTab(fetchFolders());
    if (!resp.ok) {
      onEvent({ kind: 'log', message: `Folders skipped: could not read target folders (${resp.status})` });
      return map;
    }
    const targetFolders = parseFolders(safeJson(resp.text));
    roots = rootIdsByType(targetFolders);
    for (const f of targetFolders.values()) {
      if (!f.isRoot && f.parentFolderId) existing.set(`${f.parentFolderId}|${f.name.toLowerCase()}`, f.id);
    }
  }

  let created = 0;
  let reused = 0;
  const total = toCreate.length;
  for (const [i, f] of toCreate.entries()) {
    const pfx = `[${i + 1}/${total} folders]`;
    const parentTarget =
      (f.parentFolderId && map.get(f.parentFolderId)) ||
      (f.folderType === 'private' ? roots.private : roots.shared) ||
      roots.shared ||
      roots.private;
    if (!parentTarget) {
      onEvent({ kind: 'log', message: `${pfx} skipped "${f.name}": no target root` });
      continue;
    }
    const dedupKey = `${parentTarget}|${f.name.toLowerCase()}`;
    let newId = existing.get(dedupKey);
    if (newId) {
      reused += 1;
      onEvent({ kind: 'log', message: `${pfx} reused "${f.name}"` });
    } else if (dryRun) {
      newId = `dry-folder-${f.id}`;
      onEvent({ kind: 'log', message: `${pfx} DRY  would create "${f.name}"` });
    } else {
      await pacedDelay(pacing);
      // Create WITH the owner ACL — never leave a folder owner-less.
      const r = await relayThroughTab(
        createFolder({ name: f.name, parentFolderId: parentTarget, permissions: owner }),
      );
      if (!r.ok) {
        const reason = (r.text || r.error || '').toString().slice(0, 200);
        onEvent({
          kind: 'log',
          message: `${pfx} WARN create "${f.name}" failed (HTTP ${r.status}) under parent ${parentTarget}${reason ? ` — ${reason}` : ''}`,
        });
        continue;
      }
      newId = String((safeJson(r.text) as { id?: string } | null)?.id ?? '');
      if (!newId) continue;
      existing.set(dedupKey, newId);
      created += 1;
      onEvent({ kind: 'log', message: `${pfx} OK   created "${f.name}"` });
    }
    map.set(f.id, newId);
  }
  onEvent({
    kind: 'log',
    message: `Folders: ${created} created, ${reused} reused (${map.size} mapped).`,
  });
  return map;
}

/** Read the font key→archive-file map (account/typefaces.assets.json). */
export async function readFontManifest(storage: Storage): Promise<Map<string, string>> {
  const raw = await storage.readFontManifest();
  const m = new Map<string, string>();
  if (!raw) return m;
  try {
    const obj = JSON.parse(raw) as Record<string, string>;
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') m.set(k, v);
  } catch {
    /* tolerate a malformed manifest */
  }
  return m;
}

const EXT_CT: Record<string, string> = {
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

export function contentTypeForExt(ext: string): string {
  return EXT_CT[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** Build the font-bytes reader (font key → archived base64) shared by the
 *  account-settings font upload and the per-course fallback. */
export function makeFontReader(
  storage: Storage,
  fontManifest: Map<string, string>,
): (fontKey: string) => Promise<{ base64: string; contentType: string } | null> {
  return async (fontKey: string) => {
    const file = fontManifest.get(fontKey);
    if (!file) return null;
    // Fonts live under account/assets/ (new) — fall back to assets/ for archives
    // exported before the split.
    const name = file.split('/').pop() ?? file;
    const bytes = file.startsWith('account/assets/')
      ? await storage.readAccountAsset(name)
      : await storage.readAsset(name);
    if (!bytes) return null;
    const ext = file.split('.').pop() ?? 'woff';
    return { base64: bytesToBase64(bytes), contentType: contentTypeForExt(ext) };
  };
}

// --- Cross-step id maps (persisted under `_import/`, shared by A → B → C) ------

interface AccountIdMap {
  folders: Map<string, string>;
  typefaces: Map<string, string>;
}

export async function writeAccountIdMap(
  storage: Storage,
  folders: Map<string, string>,
  typefaces: Map<string, string>,
): Promise<void> {
  await storage.writeImportArtifact(
    'account.idmap.json',
    JSON.stringify(
      { folders: Object.fromEntries(folders), typefaces: Object.fromEntries(typefaces) },
      null,
      2,
    ),
  );
}

export async function readAccountIdMap(storage: Storage): Promise<AccountIdMap> {
  const raw = await storage.readImportArtifact('account.idmap.json');
  const empty = { folders: new Map<string, string>(), typefaces: new Map<string, string>() };
  if (!raw) return empty;
  try {
    const o = JSON.parse(raw) as { folders?: Record<string, string>; typefaces?: Record<string, string> };
    return {
      folders: new Map(Object.entries(o.folders ?? {})),
      typefaces: new Map(Object.entries(o.typefaces ?? {})),
    };
  } catch {
    return empty;
  }
}

/** Imported question banks: source bank id → { newBankId, questionIds }. */
export type BoundBankMap = Map<string, { newBankId: string; questionIds: string[] }>;

export async function writeBankIdMap(storage: Storage, banks: BoundBankMap): Promise<void> {
  await storage.writeImportArtifact(
    'banks.idmap.json',
    JSON.stringify(Object.fromEntries(banks), null, 2),
  );
}

export async function readBankIdMap(storage: Storage): Promise<BoundBankMap> {
  const raw = await storage.readImportArtifact('banks.idmap.json');
  const out: BoundBankMap = new Map();
  if (!raw) return out;
  try {
    const o = JSON.parse(raw) as Record<string, { newBankId?: string; questionIds?: string[] }>;
    for (const [src, v] of Object.entries(o)) {
      if (v && typeof v.newBankId === 'string') {
        out.set(src, { newBankId: v.newBankId, questionIds: Array.isArray(v.questionIds) ? v.questionIds : [] });
      }
    }
  } catch {
    /* tolerate */
  }
  return out;
}
