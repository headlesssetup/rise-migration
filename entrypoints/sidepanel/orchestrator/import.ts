// Phase 3 — import orchestration (panel-side). Reads a course out of the
// read-only archive, builds the plan, and runs it (dry or live) through the
// background's RELAY_WRITE, strictly sequential + human-paced. Persists a
// fidelity report + the resumable job log under `_import/`. The archive itself
// is never mutated (the immutable source of truth).

import {
  buildPlan,
  executePlan,
  buildFidelityReport,
  fidelityReportToJson,
  fidelityReportToMarkdown,
  checkSourceNotTarget,
  IdMap,
  findBankRef,
  verifyParity,
  parityReportToMarkdown,
  summarizeFlags,
  parseTypefaces,
  resolveTypefaces,
  targetByName,
  buildCreateTypefaceFonts,
  remapIds,
  getYurl,
  s3Put,
  createTypeface,
  postBank,
  putBank,
  parseFolders,
  rootIdsByType,
  orderForCreation,
  ownerPermissions,
  createFolder,
  deleteFolder,
  softDeleteCourses,
  hardDeleteCourses,
  fetchFolders,
  moveCourseToFolder,
  type PlanInput,
  type AssetEntry,
  type SourceBank,
  type AccountIdentity,
  type FidelityReport,
  type ParityReport,
  type Relay,
  type Typeface,
} from '@/core/import';
import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import type { Block } from '@/shared/types/rise';
import { rpc } from '../rpc';
import { extractItems, unwrap, type ProgressEvent } from './shared';

/** The Relay the executor uses: one RELAY_WRITE round-trip to the background. */
const relayThroughTab: Relay = async (spec) => {
  const resp = await rpc({ type: 'RELAY_WRITE', spec });
  if (resp.type !== 'WRITE_RESULT') {
    return { ok: false, status: 0, text: '', error: 'unexpected background response' };
  }
  return resp.result;
};

/** Base64-encode bytes in chunks (avoids the call-stack limit of a single
 *  String.fromCharCode spread on large media). */
function bytesToBase64(bytes: Uint8Array): string {
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
async function fetchTargetTypefaces(
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

/** Map a course's saved asset manifest → plan AssetEntry[] (downloaded + orphan).
 *  `byKey` also yields the archive filename so we can read bytes for upload. */
async function readCourseAssets(
  storage: Storage,
  courseId: string,
): Promise<{ entries: AssetEntry[]; fileByKey: Map<string, string> }> {
  const raw = await storage.readAssetManifest('courses', courseId);
  const entries: AssetEntry[] = [];
  const fileByKey = new Map<string, string>();
  if (!raw) return { entries, fileByKey };
  try {
    const m = JSON.parse(raw) as {
      assets?: { key: string; kind: string; file: string; ext: string }[];
      failed?: { key: string; status?: number }[];
    };
    for (const a of m.assets ?? []) {
      entries.push({ key: a.key, kind: a.kind, file: a.file, ext: a.ext });
      fileByKey.set(a.key, a.file);
    }
    for (const f of m.failed ?? []) {
      // 403/404 ⇒ orphaned (deleted at source); other failures still block-less.
      entries.push({ key: f.key, kind: 'media-other', orphaned: true });
    }
  } catch {
    /* tolerate a malformed manifest — treat as no assets */
  }
  return { entries, fileByKey };
}

/** Collect the banks referenced by draw-from-bank blocks in a course doc. */
async function readReferencedBanks(
  storage: Storage,
  course: PlanInput['course'],
): Promise<Map<string, SourceBank>> {
  const ids = new Set<string>();
  for (const l of course.lessons ?? []) {
    for (const b of (l.items ?? []) as Block[]) {
      if (`${b.family}/${b.variant}` === 'knowledgeCheck/draw from question bank') {
        const { bankId } = findBankRef(b);
        if (bankId) ids.add(bankId);
      }
    }
  }
  const out = new Map<string, SourceBank>();
  for (const id of ids) {
    const raw = await storage.readQuestionBank(id);
    if (!raw) continue;
    try {
      const doc = JSON.parse(raw) as SourceBank;
      out.set(id, doc);
    } catch {
      /* skip unreadable bank */
    }
  }
  return out;
}

export interface ImportOptions {
  dryRun: boolean;
  /** Override the Source ≠ Target guard (same-account write). */
  override?: boolean;
  pacing?: PacingConfig;
  targetFolderId?: string | null;
  /** Recreate referenced question banks + bind draw-from-bank blocks. Default
   *  OFF — draw-from-bank blocks become unbound placeholders (manual). */
  recreateBanks?: boolean;
  /** Recreate the source folder tree on the target + place courses into it.
   *  Default ON; deduped by name so re-runs don't spawn duplicate folders. */
  recreateFolders?: boolean;
}

export interface CourseImportOutcome {
  courseId: string;
  title?: string;
  report: FidelityReport;
  /** Read-back parity (live runs only): GET_COURSE the new course + diff vs source. */
  parity?: ParityReport;
}

export interface ImportRunResult {
  /** Set when the run was blocked before any write (guard failure). */
  blocked?: string;
  outcomes: CourseImportOutcome[];
}

/**
 * Run an import for the selected source course ids. Enforces the Source ≠ Target
 * guard once up front, then imports each course strictly sequentially. Persists
 * `_import/<courseId>.report.{md,json}` + `<courseId>.joblog.json` (resume map).
 */
export async function runImport(
  storage: Storage,
  courseIds: string[],
  target: AccountIdentity | undefined,
  opts: ImportOptions,
  onEvent: (e: ProgressEvent) => void,
): Promise<ImportRunResult> {
  const pacing = opts.pacing ?? DEFAULT_PACING;
  const outcomes: CourseImportOutcome[] = [];

  // Safe-import gate: never write into the source account (unless overridden).
  const source = await readSourceIdentity(storage);
  const verdict = checkSourceNotTarget(source, target, opts.override);
  if (!verdict.ok && !opts.dryRun) {
    onEvent({ kind: 'log', message: `BLOCKED: ${verdict.reason}` });
    return { blocked: verdict.reason, outcomes };
  }
  onEvent({
    kind: 'log',
    message: `${opts.dryRun ? 'DRY-RUN' : 'LIVE'} import → ${target?.name ?? 'unknown target'} (${verdict.reason})`,
  });

  // Account-level typeface migration inputs (load once): the source account's
  // typefaces + the font key→archive-file map, so the import can match fonts by
  // name on the target and recreate custom ones.
  const tfRaw = await storage.readTypefaces();
  const sourceTypefaces = tfRaw ? parseTypefaces(safeJson(tfRaw)) : new Map();
  const readFontBytes = makeFontReader(storage, await readFontManifest(storage));

  // TARGET account typefaces — fetched once against a *live existing* course.
  // FETCH_TYPEFACES 404s on a just-created course id, so we can't ask the
  // brand-new course; we match fonts by name + dedup recreation against this.
  const targetTypefaces = await fetchTargetTypefaces(onEvent);

  // Cross-step state from the account-settings (A) + banks (B) operations, if
  // they were run first: folder + typeface id maps, and the imported-bank map for
  // auto-binding draw-from-bank blocks. (Persisted under `_import/`.)
  const accountMap = await readAccountIdMap(storage);
  const boundBanks = await readBankIdMap(storage);
  // Folders: prefer the map persisted by step A; else create them here when the
  // caller opted in (back-compat for a one-shot course import without step A).
  const folderIdMap =
    accountMap.folders.size > 0
      ? accountMap.folders
      : opts.recreateFolders === false
        ? new Map<string, string>()
        : await setupFolders(storage, target, opts.dryRun, pacing, onEvent);
  const typefaceSeed = accountMap.typefaces;
  if (boundBanks.size > 0) {
    onEvent({ kind: 'log', message: `Auto-binding draw-from-bank to ${boundBanks.size} imported bank(s).` });
  }
  const courseFolders = await readCourseFolders(storage);

  for (const [i, courseId] of courseIds.entries()) {
    onEvent({ kind: 'course', index: i, total: courseIds.length, courseId });

    const raw = await storage.readCourse(courseId);
    if (!raw) {
      onEvent({ kind: 'log', message: `Skipped (not in archive): ${courseId}` });
      continue;
    }
    const course = unwrap(raw);
    const { entries, fileByKey } = await readCourseAssets(storage, courseId);
    const banksById = await readReferencedBanks(storage, course);

    const input: PlanInput = {
      course,
      assets: entries,
      banksById,
      // The current account-local user (the `_articulate_user_id` owner), NOT the
      // Okta `sub` — same principal the folders API requires. Author of created
      // lessons/locks; keeps every created resource owned by the live account.
      author: target?.userId ?? target?.sub ?? 'unknown',
      targetFolderId: opts.targetFolderId ?? 'all',
      recreateBanks: opts.recreateBanks ?? false,
      boundBanks: boundBanks.size > 0 ? boundBanks : undefined,
    };
    const steps = buildPlan(input);

    // Resume: rehydrate a prior job log so a retry never double-creates.
    const priorLog = await storage.readImportArtifact(`${courseId}.joblog.json`);
    const ids = priorLog
      ? IdMap.fromJSON(JSON.parse(priorLog) as Record<string, string>)
      : new IdMap();

    const readAsset = async (sourceKey: string) => {
      const file = fileByKey.get(sourceKey);
      if (!file) return null;
      const name = file.replace(/^assets\//, '');
      const bytes = await storage.readAsset(name);
      if (!bytes) return null;
      const ext = name.split('.').pop() ?? '';
      return { base64: bytesToBase64(bytes), contentType: contentTypeForExt(ext) };
    };

    const res = await executePlan(steps, {
      input,
      relay: relayThroughTab,
      readAsset,
      sourceTypefaces,
      targetTypefaces,
      typefaceIdMap: typefaceSeed.size > 0 ? typefaceSeed : undefined,
      readFontBytes,
      ids,
      dryRun: opts.dryRun,
      pace: () => pacedDelay(pacing),
      log: (m) => onEvent({ kind: 'log', message: m }),
    });

    // Record the created course id (append-only) so a later Purge can clean up
    // this shell even if a retry overwrites the per-course joblog. Live only.
    if (!opts.dryRun && res.newCourseId) await recordCreatedCourse(storage, res.newCourseId);

    // Place the new course into its mapped folder (the course was created at
    // root; folders are recreated account-level above). Best-effort + paced.
    if (res.ok && res.newCourseId) {
      const tgtFolder = folderIdMap.get(courseFolders.get(courseId) ?? '');
      if (tgtFolder) {
        if (!opts.dryRun) {
          await pacedDelay(pacing);
          const mv = await relayThroughTab(moveCourseToFolder(res.newCourseId, tgtFolder));
          onEvent({
            kind: 'log',
            message: mv.ok
              ? `Moved course into folder ${tgtFolder}`
              : `WARN move-to-folder failed (HTTP ${mv.status})`,
          });
        } else {
          onEvent({ kind: 'log', message: `DRY  move course → folder ${tgtFolder}` });
        }
      }
    }

    const report = buildFidelityReport(steps, res, courseId);
    // Persist outputs (never into the read-only archive dirs).
    await storage.writeImportArtifact(
      `${courseId}.report.md`,
      fidelityReportToMarkdown(report),
    );
    await storage.writeImportArtifact(
      `${courseId}.report.json`,
      fidelityReportToJson(report),
    );
    await storage.writeImportArtifact(
      `${courseId}.joblog.json`,
      JSON.stringify(res.idMap, null, 2),
    );

    // Read-back parity (live, successful runs only): paced GET_COURSE of the new
    // course → structural diff vs the archived source. The true round-trip check.
    let parity: ParityReport | undefined;
    if (!opts.dryRun && res.ok && res.newCourseId) {
      await pacedDelay(pacing);
      onEvent({ kind: 'log', message: `Verifying parity (read-back GET_COURSE ${res.newCourseId})…` });
      const rb = await rpc({ type: 'GET_COURSE', courseId: res.newCourseId });
      if (rb.type === 'COURSE_RESULT' && rb.result.ok) {
        parity = verifyParity(course, rb.result.data.doc, res.flags);
        await storage.writeImportArtifact(`${courseId}.parity.md`, parityReportToMarkdown(parity));
        onEvent({
          kind: 'log',
          message: parity.ok
            ? `Parity OK — ${parity.blocks.compared} block(s) match (${parity.expectedDivergences.length} expected divergence(s))`
            : `Parity DIVERGENCES — ${parity.issues.length} unexpected (see ${courseId}.parity.md)`,
        });
      } else {
        onEvent({ kind: 'log', message: `Parity read-back failed — could not GET_COURSE ${res.newCourseId}` });
      }
    }

    outcomes.push({
      courseId,
      title: typeof course.course?.title === 'string' ? course.course.title : undefined,
      report,
      parity,
    });
    onEvent({
      kind: 'log',
      message: res.ok
        ? `${opts.dryRun ? 'Planned' : 'Imported'} "${course.course?.title ?? courseId}" — ${report.planned.blocks} block(s), ${report.flags.length} flag(s)`
        : `FAILED "${course.course?.title ?? courseId}": ${res.error}`,
    });
    // Break flags down by kind so the operator knows WHAT needs manual handling
    // (storyline vs orphan vs cover/header media …) without opening the report.
    if (res.flags.length) {
      onEvent({ kind: 'log', message: `  flags: ${summarizeFlags(res.flags)}` });
    }

    if (i < courseIds.length - 1) await pacedDelay(pacing);
  }

  return { outcomes };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Course id → source folderId, from `_metadata/inventory.json`. */
async function readCourseFolders(storage: Storage): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const raw = await storage.readInventory();
  if (!raw) return m;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : ((parsed as { items?: unknown[] }).items ?? []);
    for (const r of rows as Record<string, unknown>[]) {
      if (typeof r.id === 'string' && typeof r.folderId === 'string' && r.folderId) {
        m.set(r.id, r.folderId);
      }
    }
  } catch {
    /* tolerate */
  }
  return m;
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
async function setupFolders(
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
  for (const f of toCreate) {
    const parentTarget =
      (f.parentFolderId && map.get(f.parentFolderId)) ||
      (f.folderType === 'private' ? roots.private : roots.shared) ||
      roots.shared ||
      roots.private;
    if (!parentTarget) {
      onEvent({ kind: 'log', message: `Folder "${f.name}" skipped: no target root` });
      continue;
    }
    const dedupKey = `${parentTarget}|${f.name.toLowerCase()}`;
    let newId = existing.get(dedupKey);
    if (newId) {
      reused += 1;
    } else if (dryRun) {
      newId = `dry-folder-${f.id}`;
    } else {
      await pacedDelay(pacing);
      // Create WITH the owner ACL — never leave a folder owner-less.
      const r = await relayThroughTab(
        createFolder({ name: f.name, parentFolderId: parentTarget, permissions: owner }),
      );
      if (!r.ok) {
        onEvent({ kind: 'log', message: `WARN folder "${f.name}" create failed (HTTP ${r.status})` });
        continue;
      }
      newId = String((safeJson(r.text) as { id?: string } | null)?.id ?? '');
      if (!newId) continue;
      existing.set(dedupKey, newId);
      created += 1;
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
async function readFontManifest(storage: Storage): Promise<Map<string, string>> {
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

function contentTypeForExt(ext: string): string {
  return EXT_CT[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** Build the font-bytes reader (font key → archived base64) shared by the
 *  account-settings font upload and the per-course fallback. */
function makeFontReader(
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

// --- Cross-step id maps (persisted under `_import/`, shared by A → B → C) ------

interface AccountIdMap {
  folders: Map<string, string>;
  typefaces: Map<string, string>;
}

async function writeAccountIdMap(
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

/** Append-only ledger of EVERY target course id this tool created — across all
 *  runs and RETRIES (a per-source joblog only keeps the latest attempt, so a
 *  retried course leaves orphan shells the joblog forgets). Purge reads this to
 *  clean up all of them. `_import/created-courses.json` = string[]. */
async function recordCreatedCourse(storage: Storage, newCourseId: string): Promise<void> {
  const ids = await readCreatedCourses(storage);
  if (ids.includes(newCourseId)) return;
  ids.push(newCourseId);
  await storage.writeImportArtifact('created-courses.json', JSON.stringify(ids, null, 2));
}

async function readCreatedCourses(storage: Storage): Promise<string[]> {
  const raw = await storage.readImportArtifact('created-courses.json');
  if (!raw) return [];
  try {
    const a = JSON.parse(raw) as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function readAccountIdMap(storage: Storage): Promise<AccountIdMap> {
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

async function writeBankIdMap(storage: Storage, banks: BoundBankMap): Promise<void> {
  await storage.writeImportArtifact(
    'banks.idmap.json',
    JSON.stringify(Object.fromEntries(banks), null, 2),
  );
}

async function readBankIdMap(storage: Storage): Promise<BoundBankMap> {
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

// --- B) Question banks: list + standalone import ------------------------------

export interface LocalBank {
  id: string;
  title: string;
  questionCount: number;
}

/** List the question banks saved locally (id + title + question count) for the
 *  selectable B list. Titles come from the saved bank index when present. */
export async function listLocalBanks(storage: Storage): Promise<LocalBank[]> {
  const titleById = new Map<string, string>();
  const indexRaw = await storage.readBankIndex();
  if (indexRaw) {
    try {
      const doc = JSON.parse(indexRaw) as unknown;
      const arr = Array.isArray(doc)
        ? doc
        : (((doc as Record<string, unknown>).items as unknown[]) ??
           ((doc as Record<string, unknown>).questionBanks as unknown[]) ??
           Object.values(doc as Record<string, unknown>));
      for (const it of (arr ?? []) as Record<string, unknown>[]) {
        if (it && typeof it.id === 'string' && typeof it.title === 'string') {
          titleById.set(it.id, it.title);
        }
      }
    } catch {
      /* tolerate */
    }
  }
  const ids = await storage.listSavedBanks();
  const out: LocalBank[] = [];
  for (const id of ids) {
    let questionCount = 0;
    let title: string | undefined;
    const raw = await storage.readQuestionBank(id);
    if (raw) {
      try {
        const b = JSON.parse(raw) as SourceBank;
        questionCount = Array.isArray(b.questions) ? b.questions.length : 0;
        // The bank's own JSON carries the real title; prefer it over the index.
        if (typeof b.title === 'string' && b.title) title = b.title;
      } catch {
        /* tolerate */
      }
    }
    out.push({ id, title: title ?? titleById.get(id) ?? id, questionCount });
  }
  return out;
}

export interface BankImportOutcome {
  sourceBankId: string;
  title: string;
  newBankId?: string;
  questionCount: number;
  ok: boolean;
  error?: string;
}

export interface BankImportOptions {
  dryRun: boolean;
  override?: boolean;
  pacing?: PacingConfig;
}

/**
 * Operation B — import selected question banks as standalone resources. Creates
 * each bank (POST → PUT questions, copy-faithful with regenerated ids) and
 * persists source bank id → { newBankId, questionIds } so course import (C)
 * auto-binds draw-from-bank blocks. (Bank-question media is not re-uploaded — it
 * stays flagged, consistent with the course path.)
 */
export async function importBanks(
  storage: Storage,
  target: AccountIdentity | undefined,
  bankIds: string[],
  opts: BankImportOptions,
  onEvent: (e: ProgressEvent) => void,
): Promise<{ blocked?: string; outcomes: BankImportOutcome[] }> {
  const pacing = opts.pacing ?? DEFAULT_PACING;
  const outcomes: BankImportOutcome[] = [];

  const source = await readSourceIdentity(storage);
  const verdict = checkSourceNotTarget(source, target, opts.override);
  if (!verdict.ok && !opts.dryRun) {
    onEvent({ kind: 'log', message: `BLOCKED: ${verdict.reason}` });
    return { blocked: verdict.reason, outcomes };
  }

  // Merge into any previously-imported banks so C sees the full set.
  const bound = await readBankIdMap(storage);
  // Account-local owner (see runImport) — author of the bank lock_data.
  const author = target?.userId ?? target?.sub ?? 'unknown';

  for (const [i, bankId] of bankIds.entries()) {
    const raw = await storage.readQuestionBank(bankId);
    if (!raw) {
      onEvent({ kind: 'log', message: `Skipped bank (not in archive): ${bankId}` });
      continue;
    }
    let bank: SourceBank;
    try {
      bank = JSON.parse(raw) as SourceBank;
    } catch {
      outcomes.push({ sourceBankId: bankId, title: bankId, questionCount: 0, ok: false, error: 'unreadable bank JSON' });
      continue;
    }
    const title = bank.title ?? bankId;
    const qCount = Array.isArray(bank.questions) ? bank.questions.length : 0;
    onEvent({ kind: 'log', message: `[${i + 1}/${bankIds.length}] Bank "${title}" (${qCount} question(s))` });

    // Regenerate question ids (copy-faithful) so the target bank owns fresh ids.
    const ids = new IdMap();
    const questions = remapIds(bank.questions ?? [], ids) as Array<{ id?: string }>;
    const questionIds = questions.map((q) => String(q.id ?? '')).filter(Boolean);

    try {
      let newBankId: string;
      if (opts.dryRun) {
        newBankId = `dry-bank-${bankId}`;
      } else {
        await pacedDelay(pacing);
        const cresp = await relayThroughTab(postBank({ folderId: null, title }));
        if (!cresp.ok) throw new Error(`create failed (HTTP ${cresp.status})`);
        newBankId = String((safeJson(cresp.text) as { id?: string } | null)?.id ?? '');
        if (!newBankId) throw new Error('create returned no id');

        await pacedDelay(pacing);
        const presp = await relayThroughTab(
          putBank({
            bankId: newBankId,
            questions: questions as unknown[],
            session: `${Date.now()}`,
            lockData: { user_id: author, staff: false, content_team_admin: false },
          }),
        );
        if (!presp.ok) throw new Error(`write questions failed (HTTP ${presp.status})`);
      }
      bound.set(bankId, { newBankId, questionIds });
      outcomes.push({ sourceBankId: bankId, title, newBankId, questionCount: qCount, ok: true });
      onEvent({ kind: 'log', message: `  ${opts.dryRun ? 'planned' : 'OK'} → bank ${newBankId}` });
    } catch (e) {
      outcomes.push({ sourceBankId: bankId, title, questionCount: qCount, ok: false, error: (e as Error).message });
      onEvent({ kind: 'log', message: `  FAILED: ${(e as Error).message}` });
    }
    if (i < bankIds.length - 1) await pacedDelay(pacing);
  }

  // Persist the merged map (skip in dry-run so a preview never alters state).
  if (!opts.dryRun) await writeBankIdMap(storage, bound);
  return { outcomes };
}

// --- Cleanup: purge everything this tool created on the target ----------------

export interface PurgeOutcome {
  foldersDeleted: number;
  foldersFailed: number;
  coursesDeleted: number;
  coursesFailed: number;
}

/** A target course this tool created, with provenance (which source course +
 *  title it came from), so the purge can show exactly what it will delete. */
interface ImportedCourse {
  targetId: string;
  sourceId: string;
  title?: string;
  /** Where we learned the target id — a per-course job log, or the ledger. */
  via: 'joblog' | 'ledger';
}

/** TARGET courses this tool created — read from each course's joblog id-map
 *  (`joblog[sourceCourseId]` = newCourseId, recorded at create time) plus the
 *  append-only ledger. Carries the source title for an auditable purge preview. */
async function importedCourses(storage: Storage): Promise<ImportedCourse[]> {
  const titleBySrc = new Map<string, string>();
  let srcIds: string[] = [];
  const manifestRaw = await storage.readManifest();
  if (manifestRaw) {
    try {
      const m = JSON.parse(manifestRaw) as { courses?: { id?: string; title?: string }[] };
      for (const c of m.courses ?? []) {
        if (c.id) {
          srcIds.push(c.id);
          if (c.title) titleBySrc.set(c.id, c.title);
        }
      }
    } catch {
      /* fall through */
    }
  }
  if (srcIds.length === 0) srcIds = await storage.listSaved();

  const out: ImportedCourse[] = [];
  const seen = new Set<string>();
  for (const src of srcIds) {
    const log = await storage.readImportArtifact(`${src}.joblog.json`);
    if (!log) continue;
    try {
      const m = JSON.parse(log) as Record<string, string>;
      const newId = m[src];
      if (newId && newId !== src && !seen.has(newId)) {
        seen.add(newId);
        out.push({ targetId: newId, sourceId: src, title: titleBySrc.get(src), via: 'joblog' });
      }
    } catch {
      /* tolerate */
    }
  }
  // Append-only ledger catches RETRIED courses' orphan shells (no source link).
  for (const t of await readCreatedCourses(storage)) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push({ targetId: t, sourceId: '(unknown)', via: 'ledger' });
    }
  }
  return out;
}

/** TARGET folder ids this tool created, CHILD-FIRST (so a parent isn't deleted
 *  before its children). */
async function importedFolderTargetIds(
  storage: Storage,
  folderMap: Map<string, string>,
): Promise<string[]> {
  let srcOrder = [...folderMap.keys()];
  const raw = await storage.readFolders();
  if (raw) {
    // orderForCreation is parent-first; reverse → child-first for deletion.
    srcOrder = orderForCreation(parseFolders(safeJson(raw))).map((f) => f.id).reverse();
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of srcOrder) {
    const t = folderMap.get(s);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Cleanup — delete everything this tool created on the TARGET (the courses from
 * the per-course job logs, then the folders from `account.idmap.json`,
 * child-first). Recovers an account broken by owner-less folders. Best-effort:
 * a 404 counts as already-gone. Clears the persisted folder map afterward so a
 * fresh import recreates folders correctly (owned).
 */
export async function purgeImported(
  storage: Storage,
  opts: { dryRun: boolean; pacing?: PacingConfig },
  onEvent: (e: ProgressEvent) => void,
): Promise<PurgeOutcome> {
  const pacing = opts.pacing ?? DEFAULT_PACING;
  const out: PurgeOutcome = { foldersDeleted: 0, foldersFailed: 0, coursesDeleted: 0, coursesFailed: 0 };

  // 1) Courses we created (half-imported shells litter the content list).
  //    Delete ONE id per call (matches the UI; a batch 500s if any single id is
  //    bad). Two-step per course: soft-delete → bin, then hard-delete → gone.
  const courses = await importedCourses(storage);
  if (courses.length) {
    onEvent({ kind: 'log', message: `Purge: ${courses.length} imported course(s) (from job logs we wrote at create time):` });
    // Provenance: show source course + title → target id, so it's auditable.
    for (const c of courses) {
      onEvent({
        kind: 'log',
        message: `  • ${c.title ?? c.sourceId} [src ${c.sourceId}] → target ${c.targetId} (${c.via})`,
      });
    }
  }
  for (const { targetId: id } of courses) {
    if (opts.dryRun) {
      onEvent({ kind: 'log', message: `DRY  soft+hard delete course ${id}` });
      out.coursesDeleted += 1;
      continue;
    }
    await pacedDelay(pacing);
    const sr = await relayThroughTab(softDeleteCourses([id]));
    if (sr.status === 404) {
      out.coursesDeleted += 1;
      onEvent({ kind: 'log', message: `OK   course ${id} already gone (404)` });
      continue;
    }
    if (!sr.ok) {
      // A "never-born"/ghost shell can't be binned (soft-delete 500s) — try a
      // direct hard-delete; a 404 there means it's already gone.
      await pacedDelay(pacing);
      const hr = await relayThroughTab(hardDeleteCourses([id]));
      if (hr.ok || hr.status === 404) {
        out.coursesDeleted += 1;
        onEvent({ kind: 'log', message: `OK   course ${id} removed (hard-delete HTTP ${hr.status}; soft had 500'd)` });
      } else {
        out.coursesFailed += 1;
        onEvent({ kind: 'log', message: `WARN delete ${id} failed (soft HTTP ${sr.status}, hard HTTP ${hr.status})` });
      }
      continue;
    }
    await pacedDelay(pacing);
    const hr = await relayThroughTab(hardDeleteCourses([id]));
    out.coursesDeleted += 1;
    onEvent({
      kind: 'log',
      message: hr.ok
        ? `OK   deleted course ${id} (soft + hard)`
        : `OK   course ${id} → bin; empty manually (hard-delete HTTP ${hr.status})`,
    });
  }

  // 2) Folders we created, child-first (the owner-less ones break the dashboard).
  const accountMap = await readAccountIdMap(storage);
  const folderIds = await importedFolderTargetIds(storage, accountMap.folders);
  if (folderIds.length) {
    onEvent({ kind: 'log', message: `Purge: ${folderIds.length} imported folder(s)…` });
  }
  for (const id of folderIds) {
    if (opts.dryRun) {
      onEvent({ kind: 'log', message: `DRY  delete folder ${id}` });
      out.foldersDeleted += 1;
      continue;
    }
    await pacedDelay(pacing);
    const r = await relayThroughTab(deleteFolder(id));
    if (r.ok || r.status === 404) {
      out.foldersDeleted += 1;
      onEvent({ kind: 'log', message: `OK   deleted folder ${id}` });
    } else {
      out.foldersFailed += 1;
      onEvent({ kind: 'log', message: `WARN delete folder ${id} failed (HTTP ${r.status})` });
    }
  }

  // Clear the persisted folder map so a fresh import recreates folders (owned).
  if (!opts.dryRun && out.foldersFailed === 0) {
    await writeAccountIdMap(storage, new Map(), accountMap.typefaces);
  }
  onEvent({
    kind: 'log',
    message: `Purge ${opts.dryRun ? 'preview' : 'done'}: ${out.coursesDeleted} course(s), ${out.foldersDeleted} folder(s) deleted; ${out.coursesFailed + out.foldersFailed} failed.`,
  });
  return out;
}
