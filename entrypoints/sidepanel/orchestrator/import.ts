// Phase 3 — import orchestration (panel-side). Reads a course out of the
// read-only archive, builds the plan, and runs it (dry or live) through the
// background's RELAY_WRITE, strictly sequential + human-paced. Persists a
// fidelity report + the resumable job log under `_import/`. The archive itself
// is never mutated (the immutable source of truth).
//
// Shared helpers (relay, token refresh, folders, fonts, id maps) live in
// ./import-shared; account settings (A) in ./import-account; banks (B) in
// ./import-banks. They are re-exported below so `./import` (and the orchestrator
// barrel) keeps the same surface after the split.

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
  moveCourseToFolder,
  type PlanInput,
  type AssetEntry,
  type SourceBank,
  type AccountIdentity,
  type FidelityReport,
  type ParityReport,
  type RunCsvCourse,
} from '@/core/import';
import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import type { Block } from '@/shared/types/rise';
import { rpc } from '../rpc';
import { unwrap, type ProgressEvent } from './shared';
import {
  refreshToken,
  relayThroughTab,
  bytesToBase64,
  contentTypeForExt,
  safeJson,
  makeFontReader,
  readFontManifest,
  fetchTargetTypefaces,
  readAccountIdMap,
  readBankIdMap,
  setupFolders,
  readSourceIdentity,
} from './import-shared';

// Re-export the shared + A + B surface so existing importers of './import' (and
// the orchestrator barrel) keep working unchanged after the split.
export { readSourceIdentity, type BoundBankMap } from './import-shared';
export {
  readArchiveInfo,
  importAccountSettings,
  type ArchiveInfo,
  type AccountSettingsSummary,
  type AccountSettingsOptions,
} from './import-account';
export {
  listLocalBanks,
  importBanks,
  type LocalBank,
  type BankImportOutcome,
  type BankImportOptions,
} from './import-banks';

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

/** Build the storyline attach map for a source course from its storyline
 *  manifest: SOURCE block id → {reviewPrefix, meta, title}, but ONLY for blocks
 *  whose package has been uploaded (manifest.uploads[leaf].reviewPrefix exists).
 *  Blocks without an uploaded package are left to the manual flag path. */
async function readStorylineAttach(
  storage: Storage,
  courseId: string,
): Promise<Map<string, { reviewPrefix: string; meta?: unknown; title?: string }> | undefined> {
  const raw = await storage.readStorylineManifest(courseId);
  if (!raw) return undefined;
  try {
    const m = JSON.parse(raw) as {
      blocks?: Array<{ blockId: string; leaf: string; meta?: unknown }>;
      uploads?: Record<string, { reviewPrefix?: string }>;
    };
    const map = new Map<string, { reviewPrefix: string; meta?: unknown; title?: string }>();
    for (const b of m.blocks ?? []) {
      const reviewPrefix = m.uploads?.[b.leaf]?.reviewPrefix;
      if (!reviewPrefix) continue;
      const title =
        b.meta && typeof b.meta === 'object' ? (b.meta as { title?: string }).title : undefined;
      map.set(b.blockId, { reviewPrefix, meta: b.meta, title });
    }
    return map.size ? map : undefined;
  } catch {
    return undefined;
  }
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
    const storylineAttach = await readStorylineAttach(storage, courseId);
    if (storylineAttach) {
      onEvent({
        kind: 'log',
        message: `Storyline: ${storylineAttach.size} block(s) have uploaded packages → will attach (rest flagged).`,
      });
    }

    const input: PlanInput = {
      course,
      assets: entries,
      banksById,
      storylineAttach,
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
