// Phase 3 — import orchestration (panel-side). Reads a course out of the
// read-only archive, builds the plan, and runs it (dry or live) through the
// background's RELAY_WRITE, strictly sequential + human-paced. Persists a
// fidelity report + the resumable job log under `_import/`. The archive itself
// is never mutated (the immutable source of truth).

import {
  buildPlan,
  executePlan,
  buildFidelityReport,
  buildBlockIndex,
  resolveManualWork,
  buildCourseReportMarkdown,
  buildCourseReportJson,
  buildRunCsv,
  checkSourceNotTarget,
  IdMap,
  findBankRef,
  verifyParity,
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
  fetchFolders,
  moveCourseToFolder,
  type PlanInput,
  type AssetEntry,
  type SourceBank,
  type AccountIdentity,
  type FidelityReport,
  type ParityReport,
  type RunCsvCourse,
  type Relay,
  type RelayResponse,
  type WriteSpec,
  type Typeface,
} from '@/core/import';
import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import type { Block } from '@/shared/types/rise';
import { rpc } from '../rpc';
import { extractItems, unwrap, type ProgressEvent } from './shared';

/**
 * Force a fresh bearer before a (possibly long) stretch of writes. The held
 * token is ~15 min and an import is write-quiet, so the webRequest observer
 * never sees a fresh bearer to capture — we must pull a rotated one ourselves.
 * Non-mutating (a session refresh + cookie re-read), so it's safe in dry-run too
 * and makes the dry-run preview reads (FETCH_TYPEFACES) accurate. Best-effort:
 * on failure we still proceed and let the reactive 401/403 retry catch up.
 */
async function refreshToken(
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
const relayThroughTab: Relay = async (spec) => {
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
      assets?: { key: string; kind: string; file: string; ext: string; size?: number }[];
      failed?: { key: string; status?: number }[];
    };
    for (const a of m.assets ?? []) {
      entries.push({ key: a.key, kind: a.kind, file: a.file, ext: a.ext, size: a.size });
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
  /** Cooperative cancel for the Stop button. Polled between courses and (via the
   *  executor) between paced write steps — never mid-write. */
  shouldStop?: () => boolean;
}

/** Per-course outcome status for the run summary / outcome table. */
export type CourseStatus =
  | 'planned' // dry-run
  | 'imported' // live, fully imported + (where applicable) parity-checked
  | 'partial' // live, confirmed course but failed mid-build — resumable on re-run
  | 'stopped' // live, halted by Stop mid-course — resumable on re-run
  | 'failed'; // live, failed before/at confirmation (orphan shell left in place)

export interface CourseImportOutcome {
  courseId: string;
  title?: string;
  status: CourseStatus;
  report: FidelityReport;
  /** A created-but-unconfirmed course shell left on the target (no auto-delete). */
  orphanedCourseId?: string;
  /** Read-back parity (live runs only): GET_COURSE the new course + diff vs source. */
  parity?: ParityReport;
}

export interface ImportRunResult {
  /** Set when the run was blocked before any write (guard failure). */
  blocked?: string;
  outcomes: CourseImportOutcome[];
  /** True when the run was halted early by the Stop button. */
  stopped?: boolean;
  /** Course ids that were queued but never started (Stop pressed before them). */
  notStarted?: string[];
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
  // Rows for the single run-level CSV (one file for the whole run), built per course.
  const csvCourses: RunCsvCourse[] = [];

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

  // Start on a fresh bearer: the panel may have been idle since the token was
  // last captured, so the very first reads (target fonts) could otherwise 403.
  await refreshToken(onEvent, 'run start');

  // Token heartbeat: Rise's own editor refreshes the session continuously (~30s
  // lifecycle/refresh) so the bearer is always fresh. We don't need that cadence
  // (we're paced, and re-auth before each course gives a full ~15min window), but a
  // single LONG course (hundreds of paced writes) can outlast the token mid-course.
  // So we proactively refresh during a course if the bearer has been held too long
  // — woven into the paced gap between writes. `lastAuthMs` is reset by every
  // refresh (run-start, per-course, heartbeat).
  let lastAuthMs = Date.now();
  const HEARTBEAT_MS = 5 * 60_000; // well under the ~15min token, far calmer than Rise's 30s
  const pacedWithHeartbeat = async (): Promise<void> => {
    if (!opts.dryRun && Date.now() - lastAuthMs > HEARTBEAT_MS) {
      await refreshToken(onEvent, 'heartbeat');
      lastAuthMs = Date.now();
    }
    await pacedDelay(pacing);
  };

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

  // ETA: project remaining time from elapsed wall-clock and the fraction of work
  // done (course index + within-course step fraction). Self-correcting and pacing-
  // agnostic — no need to hardcode per-block/asset times. Live runs only.
  const numCourses = courseIds.length;
  const runStart = Date.now();
  const emitStatus = (i: number, done: number, total: number): void => {
    if (opts.dryRun) return;
    const fraction = (i + (total ? done / total : 0)) / Math.max(1, numCourses);
    const elapsed = Date.now() - runStart;
    // Wait for a little signal before showing a time (early fractions are noisy).
    const etaSeconds =
      fraction > 0.02 && elapsed > 3000
        ? Math.round((elapsed * (1 - fraction)) / fraction / 1000)
        : null;
    onEvent({ kind: 'import-status', label: `Importing ${i + 1}/${numCourses}`, etaSeconds, done: false });
  };

  let stopped = false;
  for (const [i, courseId] of courseIds.entries()) {
    // Graceful Stop: honor a cancel BETWEEN courses (the cleanest break point —
    // nothing of this course has been touched yet).
    if (opts.shouldStop?.()) {
      stopped = true;
      onEvent({ kind: 'log', message: 'Stop requested — halting before the next course.' });
      break;
    }
    // Read the course first so the per-course log header can show its real name.
    const raw = await storage.readCourse(courseId);
    if (!raw) {
      onEvent({ kind: 'log', message: `Skipped (not in archive): ${courseId}` });
      continue;
    }
    const course = unwrap(raw);
    const courseTitle =
      typeof course.course?.title === 'string' ? course.course.title : undefined;
    onEvent({ kind: 'course', index: i, total: courseIds.length, courseId, title: courseTitle });
    emitStatus(i, 0, 1);

    // Refresh the bearer before EACH course: every course is many paced writes,
    // and the first ducks call (UPDATE_COURSE_FIELD_THROTTLE / CREATE_LESSON)
    // 403s on a token that lapsed during the previous course. Per-course refresh
    // keeps each course starting on a token with the full ~15 min window.
    await refreshToken(onEvent, `[${i + 1}/${courseIds.length}]`);
    lastAuthMs = Date.now();

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

    // Resume: rehydrate the prior id map so a retry never double-creates. The id
    // map now lives nested in the consolidated report.json (`.idMap`); fall back
    // to the legacy standalone joblog.json for migrations started before that.
    let ids = new IdMap();
    const priorReport = await storage.readImportArtifact(`${courseId}.report.json`);
    if (priorReport) {
      try {
        const parsed = JSON.parse(priorReport) as { idMap?: Record<string, string> };
        if (parsed.idMap) ids = IdMap.fromJSON(parsed.idMap);
      } catch {
        /* corrupt report — start fresh */
      }
    }
    if (ids.size === 0) {
      const priorLog = await storage.readImportArtifact(`${courseId}.joblog.json`);
      if (priorLog) {
        const parsed = JSON.parse(priorLog) as Record<string, string>;
        delete parsed._courseTitle; // informational header only — not an id mapping
        ids = IdMap.fromJSON(parsed);
      }
    }

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
      pace: pacedWithHeartbeat,
      log: (m) => onEvent({ kind: 'log', message: m }),
      onProgress: (done, total) => emitStatus(i, done, total),
      shouldStop: opts.shouldStop,
    });

    // Place the new course into its mapped folder (the course was created at
    // root; folders are recreated account-level above). Best-effort + paced.
    if (res.ok && res.newCourseId) {
      const tgtFolder = folderIdMap.get(courseFolders.get(courseId) ?? '');
      if (tgtFolder) {
        if (!opts.dryRun) {
          await pacedDelay(pacing);
          const mv = await relayThroughTab(moveCourseToFolder(res.newCourseId, tgtFolder));
          if (mv.ok) {
            onEvent({ kind: 'log', message: `Moved course into folder ${tgtFolder}` });
          } else {
            // The envelope is capture-confirmed (PATCH /content/{id}/move, bare
            // folder id as text/plain → 200), so a failure here is almost always a
            // STALE/invalid target folder id (e.g. a persisted account.idmap.json
            // pointing at a folder that no longer exists). Surface the server's
            // reason + the folder id so it's diagnosable, not a bare HTTP code.
            const reason = (mv.text || mv.error || '').toString().slice(0, 200);
            onEvent({
              kind: 'log',
              message: `WARN move-to-folder failed (HTTP ${mv.status}) — folder ${tgtFolder}${reason ? ` — ${reason}` : ''} — course left in root, move it manually`,
            });
          }
        } else {
          onEvent({ kind: 'log', message: `DRY  move course → folder ${tgtFolder}` });
        }
      }
    }

    const report = buildFidelityReport(steps, res, courseId, courseTitle);

    // Read-back parity (live, successful runs only): paced GET_COURSE of the new
    // course → structural diff vs the archived source. The true round-trip check.
    // Done BEFORE persisting so it folds into the consolidated report.
    let parity: ParityReport | undefined;
    if (!opts.dryRun && res.ok && res.newCourseId) {
      await pacedDelay(pacing);
      onEvent({ kind: 'log', message: `Verifying parity (read-back GET_COURSE ${res.newCourseId})…` });
      const rb = await rpc({ type: 'GET_COURSE', courseId: res.newCourseId });
      if (rb.type === 'COURSE_RESULT' && rb.result.ok) {
        parity = verifyParity(course, rb.result.data.doc, res.flags);
        onEvent({
          kind: 'log',
          message: parity.ok
            ? `Parity OK — ${parity.blocks.compared} block(s) match (${parity.expectedDivergences.length} expected divergence(s))`
            : `Parity DIVERGENCES — ${parity.issues.length} unexpected (see ${courseId}.report.md)`,
        });
      } else {
        onEvent({ kind: 'log', message: `Parity read-back failed — could not GET_COURSE ${res.newCourseId}` });
      }
    }

    // Resolve every manual-handling flag to a real location (course/lesson/block
    // names + sequence numbers) and persist TWO consolidated files per course:
    //   .report.md   — brief, human, issue-focused (report + parity + manual work)
    //   .report.json — machine-readable (report + parity + manual work + id map)
    // (Replaces the old 4-file layout: report.md/json + joblog.json + parity.md.)
    const blockIndex = buildBlockIndex(course);
    const manual = resolveManualWork(res.flags, blockIndex);
    await storage.writeImportArtifact(
      `${courseId}.report.md`,
      buildCourseReportMarkdown({ report, parity, manual }),
    );
    await storage.writeImportArtifact(
      `${courseId}.report.json`,
      buildCourseReportJson({ report, parity, manual, idMap: res.idMap }),
    );

    const status: CourseStatus = opts.dryRun
      ? 'planned'
      : res.stopped
        ? 'stopped'
        : res.ok
          ? 'imported'
          : // A confirmed course that failed mid-build is kept + resumable (partial);
            // an unconfirmed shell (orphanedCourseId set) or a pre-confirm failure is a hard failure.
            res.newCourseId && !res.orphanedCourseId
            ? 'partial'
            : 'failed';

    outcomes.push({
      courseId,
      title: courseTitle,
      status,
      report,
      orphanedCourseId: res.orphanedCourseId,
      parity,
    });
    csvCourses.push({
      title: courseTitle,
      courseId,
      targetCourseId: res.newCourseId,
      status,
      manual,
    });

    const titleStr = course.course?.title ?? courseId;
    let msg: string;
    if (res.stopped) {
      msg = `STOPPED "${titleStr}" mid-course — partial, resumable on re-run (course ${res.newCourseId ?? '—'})`;
    } else if (res.ok) {
      msg = `${opts.dryRun ? 'Planned' : 'Imported'} "${titleStr}" — ${report.planned.blocks} block(s), ${report.flags.length} flag(s)`;
    } else if (status === 'partial') {
      msg = `PARTIAL "${titleStr}": ${res.error} — course ${res.newCourseId} kept (resumable on re-run)`;
    } else {
      const orphan = res.orphanedCourseId
        ? ` (orphaned shell ${res.orphanedCourseId} left in place — delete manually if needed)`
        : '';
      msg = `FAILED "${titleStr}": ${res.error}${orphan}`;
    }
    onEvent({ kind: 'log', message: msg });
    // Break flags down by kind so the operator knows WHAT needs manual handling
    // (storyline vs orphan vs cover/header media …) without opening the report.
    if (res.flags.length) {
      onEvent({ kind: 'log', message: `  flags: ${summarizeFlags(res.flags)}` });
    }

    // The executor halted this course mid-build → stop the whole run here.
    if (res.stopped) {
      stopped = true;
      break;
    }

    if (i < courseIds.length - 1) await pacedDelay(pacing);
  }

  // Courses that were queued but never reached (Stop pressed before them).
  const attempted = new Set(outcomes.map((o) => o.courseId));
  const notStarted = courseIds.filter((id) => !attempted.has(id));

  // One CSV for the whole run: every course + the manual work remaining, with
  // human locations (course/lesson/block names + numbers). Not-started courses
  // are listed too so nothing is silently dropped.
  for (const id of notStarted) {
    csvCourses.push({ courseId: id, status: 'not-started', manual: [] });
  }
  // Timestamped so each run keeps its own summary (no overwrite). e.g.
  // import-summary-2026-06-23T18-52-46.csv
  const csvStamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
  const csvName = `import-summary-${csvStamp}.csv`;
  await storage.writeImportArtifact(csvName, buildRunCsv(csvCourses));
  onEvent({ kind: 'log', message: `Wrote run summary → ${csvName}` });

  emitRunSummary(onEvent, outcomes, notStarted, stopped, opts.dryRun);

  if (!opts.dryRun) {
    onEvent({
      kind: 'import-status',
      label: stopped ? 'Import stopped' : 'Import complete',
      etaSeconds: null,
      done: true,
    });
  }
  return {
    outcomes,
    stopped: stopped || undefined,
    notStarted: notStarted.length ? notStarted : undefined,
  };
}

/** Emit a run-level summary: counts by status + the ids needing attention or
 *  manual cleanup (resumable partials, orphaned shells, orphaned banks, not-started). */
function emitRunSummary(
  onEvent: (e: ProgressEvent) => void,
  outcomes: CourseImportOutcome[],
  notStarted: string[],
  stopped: boolean,
  dryRun: boolean,
): void {
  const by = (s: CourseStatus): CourseImportOutcome[] => outcomes.filter((o) => o.status === s);
  const imported = by('imported');
  const planned = by('planned');
  const partial = by('partial');
  const stoppedC = by('stopped');
  const failed = by('failed');

  onEvent({ kind: 'log', message: `— Run summary${stopped ? ' (STOPPED)' : ''} —` });
  const parts: string[] = [];
  parts.push(dryRun ? `${planned.length} planned` : `${imported.length} imported`);
  if (partial.length) parts.push(`${partial.length} partial`);
  if (stoppedC.length) parts.push(`${stoppedC.length} stopped`);
  if (failed.length) parts.push(`${failed.length} failed`);
  if (notStarted.length) parts.push(`${notStarted.length} not started`);
  onEvent({ kind: 'log', message: `  ${parts.join(', ')}` });

  const resumable = [...partial, ...stoppedC];
  if (resumable.length) {
    onEvent({
      kind: 'log',
      message: `  resumable (re-run to continue): ${resumable.map((o) => `"${o.title ?? o.courseId}"`).join(', ')}`,
    });
  }
  const orphanCourses = outcomes.filter((o) => o.orphanedCourseId);
  if (orphanCourses.length) {
    onEvent({
      kind: 'log',
      message: `  orphaned course shells left in place (delete manually if needed): ${orphanCourses.map((o) => o.orphanedCourseId).join(', ')}`,
    });
  }
  const orphanBanks = outcomes.flatMap((o) =>
    o.report.flags.filter((f) => f.kind === 'orphan-bank').map((f) => f.detail),
  );
  if (orphanBanks.length) {
    onEvent({ kind: 'log', message: `  orphaned/incomplete banks left in place (delete manually if needed):` });
    for (const d of orphanBanks) onEvent({ kind: 'log', message: `    - ${d}` });
  }
  if (notStarted.length) {
    onEvent({ kind: 'log', message: `  not started: ${notStarted.length} course(s) — re-run to import` });
  }
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
  /** Empty bank shell left on the target (question write failed; no auto-delete). */
  orphanedBankId?: string;
}

export interface BankImportOptions {
  dryRun: boolean;
  override?: boolean;
  pacing?: PacingConfig;
  /** Cooperative cancel for the Stop button (polled between banks). */
  shouldStop?: () => boolean;
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

  // Start on a fresh bearer (idle panels lapse the ~15 min token).
  await refreshToken(onEvent, 'run start');

  // Merge into any previously-imported banks so C sees the full set.
  const bound = await readBankIdMap(storage);
  // Account-local owner (see runImport) — author of the bank lock_data.
  const author = target?.userId ?? target?.sub ?? 'unknown';

  let stopped = false;
  for (const [i, bankId] of bankIds.entries()) {
    if (opts.shouldStop?.()) {
      stopped = true;
      onEvent({ kind: 'log', message: 'Stop requested — halting before the next bank.' });
      break;
    }
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

    // Hoisted so the catch can report a shell that was created before the
    // question write failed (empty bank left on target — no auto-delete).
    let createdBankId: string | undefined;
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
        createdBankId = newBankId; // the shell now exists on the target

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
      const orphanNote = createdBankId
        ? ` — empty bank ${createdBankId} left on target (delete manually if needed)`
        : '';
      outcomes.push({
        sourceBankId: bankId,
        title,
        questionCount: qCount,
        ok: false,
        error: (e as Error).message,
        orphanedBankId: createdBankId,
      });
      onEvent({ kind: 'log', message: `  FAILED: ${(e as Error).message}${orphanNote}` });
    }
    if (i < bankIds.length - 1) await pacedDelay(pacing);
  }

  // Persist the merged map (skip in dry-run so a preview never alters state).
  if (!opts.dryRun) await writeBankIdMap(storage, bound);

  // Banks summary: ok/failed counts + ids needing manual cleanup / re-run.
  const attempted = new Set(outcomes.map((o) => o.sourceBankId));
  const notStarted = bankIds.filter((id) => !attempted.has(id));
  const orphaned = outcomes.map((o) => o.orphanedBankId).filter((x): x is string => !!x);
  const okN = outcomes.filter((o) => o.ok).length;
  const failN = outcomes.filter((o) => !o.ok).length;
  onEvent({
    kind: 'log',
    message: `— Banks summary${stopped ? ' (STOPPED)' : ''} — ${okN} ${opts.dryRun ? 'planned' : 'ok'}, ${failN} failed${notStarted.length ? `, ${notStarted.length} not started` : ''}`,
  });
  if (orphaned.length) {
    onEvent({
      kind: 'log',
      message: `  empty banks left in place (delete manually if needed): ${orphaned.join(', ')}`,
    });
  }
  return { outcomes };
}
