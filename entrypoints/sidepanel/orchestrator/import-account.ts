// Phase 3 — Operation A: account-level settings import (folders + custom fonts)
// and the read-only archive summary. Split out of import.ts; shares the relay,
// folder recreation, font reader, and id-map persistence from ./import-shared.
// Re-exported from ./import so the public surface is unchanged.

import {
  checkSourceNotTarget,
  parseTypefaces,
  parseFolders,
  orderForCreation,
  resolveTypefaces,
  targetByName,
  buildCreateTypefaceFonts,
  getYurl,
  s3Put,
  createTypeface,
  type AccountIdentity,
  type Typeface,
} from '@/core/import';
import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import { rpc } from '../rpc';
import { extractItems, type ProgressEvent } from './shared';
import {
  readSourceIdentity,
  refreshToken,
  setupFolders,
  fetchTargetTypefaces,
  makeFontReader,
  readFontManifest,
  writeAccountIdMap,
  relayThroughTab,
  safeJson,
} from './import-shared';

function payloadOf(text: string): Record<string, unknown> {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const p = o.payload;
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : o;
  } catch {
    return {};
  }
}

/** A course id valid on the LIVE target account — the context GET_YURL/CREATE_*
 *  need (a just-created course 404s). Page-0 of the target library. */
async function liveTargetCourseId(): Promise<string | undefined> {
  try {
    const resp = await rpc({ type: 'SEARCH_COURSES', page: 0, pageSize: 1 });
    if (resp.type === 'SEARCH_RESULT' && resp.result.ok) {
      return extractItems(resp.result.data)[0]?.id;
    }
  } catch {
    /* none */
  }
  return undefined;
}

// --- A) Account settings: brief info + folders + custom fonts -----------------

export interface ArchiveInfo {
  /** Source account display name (from the manifest), if recorded. */
  sourceName?: string;
  courses: number;
  banks: number;
  folders: number;
  /** Custom (non-built-in) typefaces in the account archive. */
  customFonts: number;
  totalFonts: number;
}

/** A brief read-only summary of what the archive holds (for the A info panel). */
export async function readArchiveInfo(storage: Storage): Promise<ArchiveInfo> {
  const source = await readSourceIdentity(storage);
  let courses = 0;
  const manifestRaw = await storage.readManifest();
  if (manifestRaw) {
    try {
      const m = JSON.parse(manifestRaw) as { courses?: unknown[] };
      if (Array.isArray(m.courses)) courses = m.courses.length;
    } catch {
      /* fall through */
    }
  }
  if (courses === 0) courses = (await storage.listSaved()).length;

  const banks = (await storage.listSavedBanks()).length;

  let folders = 0;
  const foldersRaw = await storage.readFolders();
  if (foldersRaw) folders = orderForCreation(parseFolders(safeJson(foldersRaw))).length;

  const tfRaw = await storage.readTypefaces();
  const typefaces = tfRaw ? parseTypefaces(safeJson(tfRaw)) : new Map<string, Typeface>();
  let customFonts = 0;
  for (const tf of typefaces.values()) if (!isCustomFontBuiltin(tf)) customFonts += 1;

  return {
    sourceName: source?.name ?? source?.sub ?? undefined,
    courses,
    banks,
    folders,
    customFonts,
    totalFonts: typefaces.size,
  };
}

// A typeface is "custom" (uploadable) when it isn't a shared built-in.
function isCustomFontBuiltin(tf: Typeface): boolean {
  return tf.isDefault || tf.fonts.every((f) => f.key.startsWith('assets/'));
}

export interface AccountSettingsSummary {
  folders: { mapped: number };
  fonts: { matched: number; created: number; unresolved: number; mapped: number };
}

export interface AccountSettingsOptions {
  dryRun: boolean;
  override?: boolean;
  pacing?: PacingConfig;
}

/**
 * Operation A — import account-level settings: the folder tree + custom fonts.
 * Persists the folder + typeface id maps under `_import/account.idmap.json` so a
 * later course import (C) places courses + applies fonts without redoing this.
 */
export async function importAccountSettings(
  storage: Storage,
  target: AccountIdentity | undefined,
  opts: AccountSettingsOptions,
  onEvent: (e: ProgressEvent) => void,
): Promise<{ blocked?: string; summary?: AccountSettingsSummary }> {
  const pacing = opts.pacing ?? DEFAULT_PACING;
  const source = await readSourceIdentity(storage);
  const verdict = checkSourceNotTarget(source, target, opts.override);
  if (!verdict.ok && !opts.dryRun) {
    onEvent({ kind: 'log', message: `BLOCKED: ${verdict.reason}` });
    return { blocked: verdict.reason };
  }
  onEvent({
    kind: 'log',
    message: `${opts.dryRun ? 'DRY-RUN' : 'LIVE'} account settings → ${target?.name ?? 'unknown target'}`,
  });

  // Start on a fresh bearer (idle panels lapse the ~15 min token).
  await refreshToken(onEvent, 'run start');

  // Folders (always included in this step).
  const folderIdMap = await setupFolders(storage, target, opts.dryRun, pacing, onEvent);

  // Custom fonts (uploaded once, account-level).
  const tfRaw = await storage.readTypefaces();
  const sourceTypefaces = tfRaw ? parseTypefaces(safeJson(tfRaw)) : new Map<string, Typeface>();
  const targetTypefaces = await fetchTargetTypefaces(onEvent);
  const readFontBytes = makeFontReader(storage, await readFontManifest(storage));
  const fonts = await importAccountFonts({
    sourceTypefaces,
    targetTypefaces,
    readFontBytes,
    dryRun: opts.dryRun,
    pacing,
    onEvent,
  });

  // Persist for B/C (and re-runs).
  await writeAccountIdMap(storage, folderIdMap, fonts.idMap);

  const summary: AccountSettingsSummary = {
    folders: { mapped: folderIdMap.size },
    fonts: { matched: fonts.matched, created: fonts.created, unresolved: fonts.unresolved, mapped: fonts.idMap.size },
  };
  onEvent({
    kind: 'log',
    message: `Account settings ${opts.dryRun ? 'planned' : 'imported'}: ${summary.folders.mapped} folder(s) mapped; fonts — ${fonts.matched} matched, ${fonts.created} created, ${fonts.unresolved} unresolved.`,
  });
  return { summary };
}

/** Upload + register the account's custom fonts (match-by-name dedup; recreate
 *  the rest). Returns source typeface id → target id for ALL resolved fonts. */
async function importAccountFonts(args: {
  sourceTypefaces: Map<string, Typeface>;
  targetTypefaces: Map<string, Typeface>;
  readFontBytes: (k: string) => Promise<{ base64: string; contentType: string } | null>;
  dryRun: boolean;
  pacing: PacingConfig;
  onEvent: (e: ProgressEvent) => void;
}): Promise<{ idMap: Map<string, string>; matched: number; created: number; unresolved: number }> {
  const { sourceTypefaces, targetTypefaces, readFontBytes, dryRun, pacing, onEvent } = args;
  const allIds = [...sourceTypefaces.keys()];
  const { idMap, toRecreate, unresolved } = resolveTypefaces(
    allIds,
    sourceTypefaces,
    targetByName(targetTypefaces),
  );
  const matched = idMap.size;
  if (toRecreate.length === 0) {
    return { idMap, matched, created: 0, unresolved: unresolved.length };
  }

  const total = toRecreate.length;
  // DRY-RUN: do NOT touch the live account — just report what WOULD be created.
  // (GET_YURL + CREATE_TYPEFACE are real writes; sending them in a "dry-run" was
  // polluting the target with empty typefaces.)
  if (dryRun) {
    onEvent({ kind: 'log', message: `Would create ${total} custom typeface(s) (dry-run — no writes):` });
    for (const tf of toRecreate) {
      onEvent({ kind: 'log', message: `  • would create typeface "${tf.name}" (${tf.fonts.length} font file(s))` });
    }
    return { idMap, matched, created: total, unresolved: unresolved.length };
  }

  onEvent({ kind: 'log', message: `Creating ${total} custom typeface(s)…` });
  const courseId = await liveTargetCourseId();
  if (!courseId) {
    onEvent({ kind: 'log', message: 'WARN no live target course to anchor font uploads — skipping font creation' });
    return { idMap, matched, created: 0, unresolved: unresolved.length };
  }
  let created = 0;
  for (const [ti, tf] of toRecreate.entries()) {
    const pfx = `[${ti + 1}/${total} fonts]`;
    const uploaded = new Map<string, { key: string; url: string; type: string; filename: string }>();
    for (const f of tf.fonts) {
      const filename = f.original ?? f.key.split('/').pop() ?? 'font.woff';
      await pacedDelay(pacing);
      const yresp = await relayThroughTab(getYurl({ courseId, filename, assetPath: 'fonts/' }));
      onEvent({ kind: 'log', message: `${pfx} ${yresp.ok ? 'OK' : 'FAIL'} POST rise/uploads/GET_YURL` });
      if (!yresp.ok) {
        onEvent({ kind: 'log', message: `${pfx} WARN GET_YURL failed for "${tf.name}" (HTTP ${yresp.status}) — skipping this file` });
        continue;
      }
      const yurl = payloadOf(yresp.text);
      const newKey = String(yurl.key ?? '');
      const url = String(yurl.url ?? '');
      const type = String(yurl.type ?? 'font/woff');
      const bytes = await readFontBytes(f.key);
      if (!bytes) {
        onEvent({ kind: 'log', message: `${pfx} WARN missing archived font bytes for ${f.key} (skipping)` });
        continue;
      }
      const put = await relayThroughTab(s3Put({ url, base64Body: bytes.base64, contentType: type }));
      onEvent({ kind: 'log', message: `${pfx} ${put.ok ? 'OK' : 'FAIL'} PUT S3 (font bytes)` });
      if (!put.ok) {
        onEvent({ kind: 'log', message: `${pfx} WARN font S3 PUT failed for "${tf.name}" (HTTP ${put.status})` });
        continue;
      }
      uploaded.set(f.key, { key: newKey, url, type, filename: String(yurl.filename ?? filename) });
    }
    if (uploaded.size === 0) {
      onEvent({ kind: 'log', message: `${pfx} WARN custom font "${tf.name}" had no uploadable files — skipping` });
      continue;
    }
    await pacedDelay(pacing);
    const cresp = payloadOf(
      (await relayThroughTab(createTypeface({ name: tf.name, fonts: buildCreateTypefaceFonts(tf, uploaded) }))).text,
    );
    const newId = String(cresp.id ?? '');
    if (newId) {
      idMap.set(tf.id, newId);
      created += 1;
      onEvent({ kind: 'log', message: `${pfx} OK   created typeface "${tf.name}" (${created}/${total})` });
    } else {
      onEvent({ kind: 'log', message: `${pfx} WARN CREATE_TYPEFACE returned no id for "${tf.name}"` });
    }
  }
  return { idMap, matched, created, unresolved: unresolved.length };
}
