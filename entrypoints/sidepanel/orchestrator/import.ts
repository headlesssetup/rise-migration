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
  parseFolders,
  rootIdsByType,
  orderForCreation,
  ownerPermissions,
  createFolder,
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
  const fontManifest = await readFontManifest(storage);

  // TARGET account typefaces — fetched once against a *live existing* course.
  // FETCH_TYPEFACES 404s on a just-created course id, so we can't ask the
  // brand-new course; we match fonts by name + dedup recreation against this.
  const targetTypefaces = await fetchTargetTypefaces(onEvent);

  // Account-level folder tree (created once, deduped) + course→folder map.
  const folderIdMap =
    opts.recreateFolders === false
      ? new Map<string, string>()
      : await setupFolders(storage, target, opts.dryRun, pacing, onEvent);
  const courseFolders = await readCourseFolders(storage);
  const readFontBytes = async (fontKey: string) => {
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
      author: target?.sub ?? 'unknown',
      targetFolderId: opts.targetFolderId ?? 'all',
      recreateBanks: opts.recreateBanks ?? false,
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
      readFontBytes,
      ids,
      dryRun: opts.dryRun,
      pace: () => pacedDelay(pacing),
      log: (m) => onEvent({ kind: 'log', message: m }),
    });

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
      const r = await relayThroughTab(
        createFolder({
          name: f.name,
          parentFolderId: parentTarget,
          permissions: f.folderType === 'shared' ? ownerPermissions(target ?? {}) : undefined,
        }),
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
