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
  defaultLocaleOf,
  isLocalizedStack,
  resolveStackTitle,
  stackLocales,
} from '@/core/l10n';
import {
  blockKey,
  buildPlan,
  executePlan,
  buildFidelityReport,
  buildBlockIndex,
  resolveManualWork,
  buildCourseReportMarkdown,
  buildCourseReportJson,
  buildRunCsv,
  IdMap,
  findBankRef,
  estimateImportSeconds,
  sumEstimates,
  formatEstimate,
  type ImportEstimate,
  summarizeFlags,
  moveCourseToFolder,
  type PlanInput,
  type AssetEntry,
  type SourceBank,
  type AccountIdentity,
  type ExecResult,
  type FidelityReport,
  type ManualWorkItem,
  type ParityReport,
  type PendingSetReport,
  type L10nParityReport,
  type RunCsvCourse,
  READ_BACK_POLICY_VERSION,
} from '@/core/import';
import { isKnownLegacyStorylineMeta } from '@/core/storyline/compatibility';
import {
  collectAssetKeys,
  isOrphanStatus,
  type OptionalAssetReason,
} from '@/core/assets';
import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import type { Block } from '@/shared/types/rise';
import { unwrap, type ProgressEvent } from './shared';
import {
  missingAssetKeys,
  readCourseAssets,
  readReferencedBanks,
  readStorylineAttach,
} from './import-run-inputs';
import { emitRunSummary } from './import-summary';
import { verifyCourseReadBack } from './import-readback';
import { prepareImportRun } from './import-run-setup';
import {
  bytesToBase64,
  contentTypeForExt,
  readSourceIdentity,
} from './import-shared';

// Re-export the shared + A + B surface so existing importers of './import' (and
// the orchestrator barrel) keep working unchanged after the split.
export { readSourceIdentity, type BoundBankMap } from './import-shared';
// Run inputs (readers/estimate/coverage) split to ./import-run-inputs (v0.9.0).
export {
  classifyAssetFailures,
  estimateCourses,
  missingAssetKeys,
} from './import-run-inputs';
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


export interface ImportOptions {
  dryRun: boolean;
  /** Override the Source ≠ Target guard (same-account write). */
  override?: boolean;
  pacing?: PacingConfig;
  targetFolderId?: string | null;
  /** Recreate referenced question banks + bind draw-from-bank blocks. Default
   *  OFF — draw-from-bank blocks become unbound placeholders (manual). */
  recreateBanks?: boolean;
  /** "Re-create folders" checkbox. ON → create the folder chains of the
   *  SELECTED courses on the target (deduped by name+parent against the live
   *  target tree, so folders from the account-settings step or a prior run are
   *  reused, never duplicated) and place each course into its folder. OFF
   *  (default) → nothing is created or moved; courses land in the root. */
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

/** A course we refuse to start (missing media of unknown state, …): a real
 *  failed outcome, never a silent skip. */
function abortedResult(error: string): ExecResult {
  return { ok: false, dryRun: false, envelopes: [], flags: [], idMap: {}, survivingKeys: [], error };
}

/** What a persisted `<courseId>.report.json` tells us on a re-run. */
interface PriorCourseReport {
  report: FidelityReport;
  parity?: ParityReport;
  manual: ManualWorkItem[];
  idMap?: Record<string, string>;
  /** Whether this report proves completion under the current parity contract. */
  currentReadBackPolicy: boolean;
  /** A FINISHED live import: ok, not stopped, with a real target course id. */
  completed: boolean;
}

function parsePriorReport(raw: string | null | undefined): PriorCourseReport | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as FidelityReport & {
      readBackPolicyVersion?: number;
      parity?: ParityReport | null;
      manualWork?: ManualWorkItem[];
      idMap?: Record<string, string>;
    };
    const currentReadBackPolicy = p.readBackPolicyVersion === READ_BACK_POLICY_VERSION;
    return {
      report: p,
      parity: p.parity ?? undefined,
      manual: p.manualWork ?? [],
      idMap: p.idMap,
      currentReadBackPolicy,
      completed:
        currentReadBackPolicy &&
        p.ok === true &&
        p.dryRun === false &&
        !p.stopped &&
        typeof p.newCourseId === 'string' &&
        !!p.newCourseId,
    };
  } catch {
    return null; // corrupt report — treat as no prior run
  }
}


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

  // Run-level setup (gates, pin, token heartbeat, account inputs, preflight,
  // probe/label caches, ETA) — split to ./import-run-setup (v0.9.0).
  const setup = await prepareImportRun(storage, courseIds, target, opts, onEvent, pacing);
  if ('blocked' in setup) {
    return { blocked: setup.blocked, outcomes };
  }
  const {
    send,
    relay,
    pacedWithHeartbeat,
    refreshForCourse,
    sourceTypefaces,
    readFontBytes,
    targetTypefaces,
    boundBanks,
    folderIdMap,
    typefaceSeed,
    courseFolders,
    missingByCourse,
    builtinProbeCache,
    probeBuiltinAsset,
    labelSetCache,
    fetchAvailableLangs,
    emitStatus,
  } = setup;


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
    const courseIsStack = isLocalizedStack(course);
    const courseTitle =
      typeof course.course?.title === 'string'
        ? course.course.title
        : courseIsStack
          ? resolveStackTitle(course) || undefined
          : undefined;
    onEvent({ kind: 'course', index: i, total: courseIds.length, courseId, title: courseTitle });
    emitStatus(i, 0, 1);
    const pfx = `[${i + 1}/${courseIds.length}]`;

    // Run-level resume: a course whose PRIOR report says it finished is skipped
    // outright, BEFORE any network call. The rehydrated id map alone doesn't stop
    // a re-run — the plan's create-course step would create a SECOND target
    // course — so the skip is what makes a re-run idempotent.
    const prior = parsePriorReport(await storage.readImportArtifact(`${courseId}.report.json`));
    if (!opts.dryRun && prior && !prior.currentReadBackPolicy) {
      onEvent({
        kind: 'log',
        message:
          `${pfx} Prior report predates read-back policy v${READ_BACK_POLICY_VERSION}; ` +
          'reusing its target ID map, but re-running final parity before this course can be considered imported',
      });
    }
    if (!opts.dryRun && prior?.completed) {
      onEvent({
        kind: 'log',
        message: `${pfx} Skipped "${courseTitle ?? courseId}" — already imported (target course ${prior.report.newCourseId}); delete _import/${courseId}.report.json to force a re-import`,
      });
      outcomes.push({
        courseId,
        title: courseTitle,
        status: 'imported',
        report: prior.report,
        parity: prior.parity,
      });
      csvCourses.push({
        title: courseTitle,
        courseId,
        targetCourseId: prior.report.newCourseId,
        status: 'imported',
        manual: prior.manual,
        parity: prior.parity,
      });
      continue;
    }

    // Refresh the bearer before EACH course: every course is many paced writes,
    // and the first ducks call (UPDATE_COURSE_FIELD_THROTTLE / CREATE_LESSON)
    // 403s on a token that lapsed during the previous course. Per-course refresh
    // keeps each course starting on a token with the full ~15 min window.
    await refreshForCourse(pfx);

    const { entries, fileByKey, unresolved } = await readCourseAssets(storage, courseId);
    // Media whose bytes are missing for a NON-terminal reason (500 / network) is an
    // unknown state, not a deletion at source: importing now would silently drop
    // live media. Abort this course and tell the operator to re-export its assets.
    if (unresolved.length && !opts.dryRun) {
      const sample = unresolved
        .slice(0, 3)
        .map((u) => `${u.key}${u.status ? ` (HTTP ${u.status})` : ''}`)
        .join(', ');
      const error =
        `${unresolved.length} asset(s) failed to download for a retryable reason ` +
        `(${sample}${unresolved.length > 3 ? ', …' : ''}) — re-run the asset export for this course, ` +
        'then import again. They are NOT known-deleted at the source, so importing would drop live media.';
      onEvent({ kind: 'log', message: `${pfx} FAILED "${courseTitle ?? courseId}": ${error}` });
      const report = buildFidelityReport([], abortedResult(error), courseId, courseTitle);
      outcomes.push({ courseId, title: courseTitle, status: 'failed', report });
      csvCourses.push({ title: courseTitle, courseId, status: 'failed', manual: [] });
      continue;
    }
    // Media the archive simply does not hold (no bytes, not a recorded orphan):
    // almost always a forgotten "Download assets". Refuse BEFORE the first write —
    // otherwise the course (and, for a stack, its AI-converted languages) exists
    // and the run dies on the first upload, leaving a partial to delete by hand.
    // (The run-start preflight already scanned this course; recompute the key
    // list only when it found something, to name an example in the error.)
    const absent =
      missingByCourse.get(courseId) === 0 ? [] : missingAssetKeys(course, courseId, entries);
    if (absent.length && !opts.dryRun) {
      const error =
        `${absent.length} referenced asset(s) are not in the archive (e.g. ${absent[0]}) — ` +
        'run Export → "Download assets" for this archive, then import again. ' +
        'Nothing was created for this course.';
      onEvent({ kind: 'log', message: `${pfx} SKIPPED "${courseTitle ?? courseId}": ${error}` });
      const report = buildFidelityReport([], abortedResult(error), courseId, courseTitle);
      outcomes.push({ courseId, title: courseTitle, status: 'failed', report });
      csvCourses.push({ title: courseTitle, courseId, status: 'failed', manual: [] });
      continue;
    }
    const banksById = await readReferencedBanks(storage, course);
    const storylineManifest = await readStorylineAttach(storage, courseId);
    if (storylineManifest) {
      const nBlocks = storylineManifest.byBlock.size;
      const nLocalized = storylineManifest.byBlockLocale.size;
      const parts = [
        ...(nBlocks ? [`${nBlocks} block(s)`] : []),
        ...(nLocalized ? [`${nLocalized} language-specific package(s)`] : []),
      ];
      onEvent({
        kind: 'log',
        message: `Storyline: ${parts.join(' + ')} uploaded → will attach (rest flagged).`,
      });
    }

    // Multi-language stack: announce + locale-code sanity check BEFORE any write.
    if (courseIsStack) {
      const langs = stackLocales(course)
        .map((l) => String(l.locale ?? ''))
        .filter(Boolean);
      onEvent({
        kind: 'log',
        message: `${pfx} Multi-language stack (${langs.join(', ')}) — a minimal AI conversion creates the stack shape; every cell is then copied from the archive.`,
      });
      if (!opts.dryRun) {
        const avail = await fetchAvailableLangs();
        const def = defaultLocaleOf(course);
        const forSource = avail && def ? avail.get(def) : undefined;
        if (avail && def && !forSource) {
          const error = `Target plane does not support "${def}" as a translation SOURCE language — stack cannot be recreated (nothing was written)`;
          onEvent({ kind: 'log', message: `${pfx} FAILED "${courseTitle ?? courseId}": ${error}` });
          const report = buildFidelityReport([], abortedResult(error), courseId, courseTitle);
          outcomes.push({ courseId, title: courseTitle, status: 'failed', report });
          csvCourses.push({ title: courseTitle, courseId, status: 'failed', manual: [] });
          continue;
        }
        const missing = forSource
          ? langs.filter((c) => c !== def && !forSource.has(c))
          : [];
        if (missing.length) {
          const error = `Target plane does not offer translation into: ${missing.join(', ')} — stack cannot be recreated (nothing was written)`;
          onEvent({ kind: 'log', message: `${pfx} FAILED "${courseTitle ?? courseId}": ${error}` });
          const report = buildFidelityReport([], abortedResult(error), courseId, courseTitle);
          outcomes.push({ courseId, title: courseTitle, status: 'failed', report });
          csvCourses.push({ title: courseTitle, courseId, status: 'failed', manual: [] });
          continue;
        }
      }
    }

    const input: PlanInput = {
      course,
      assets: entries,
      banksById,
      storylineAttach: storylineManifest?.byBlock,
      storylineAttachL10n: storylineManifest?.byBlockLocale,
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
    if (prior?.idMap) ids = IdMap.fromJSON(prior.idMap);
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
      relay,
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
      labelSetCache,
      targetPlane: target?.plane ?? undefined,
      probeBuiltinAsset,
      builtinProbeCache,
    });

    // Place the new course into its mapped folder (the course was created at
    // root; with "Re-create folders" off the map is empty and it stays there).
    // Best-effort + paced.
    if (res.ok && res.newCourseId) {
      const tgtFolder = folderIdMap.get(courseFolders.get(courseId) ?? '');
      if (tgtFolder) {
        if (!opts.dryRun) {
          await pacedDelay(pacing);
          const mv = await relay(moveCourseToFolder(res.newCourseId, tgtFolder));
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

    // Read-back parity (live, successful runs only) — split to
    // ./import-readback (v0.9.0). Mutates `report` exactly as the inline block
    // did; the outputs feed the consolidated report below.
    let parity: ParityReport | undefined;
    let readBackForeign: string[] = [];
    let l10nParity: L10nParityReport | undefined;
    let l10nPending: Record<string, number> | undefined;
    let l10nPendingSet: PendingSetReport | undefined;
    let aiTextCells: string[] | undefined;
    if (!opts.dryRun && res.ok && res.newCourseId) {
      ({ parity, readBackForeign, l10nParity, l10nPending, l10nPendingSet, aiTextCells } =
        await verifyCourseReadBack({
          pacing,
          onEvent,
          send,
          relay,
          course,
          res,
          steps,
          banksById,
          boundBanks,
          target,
          pfx,
          courseIsStack,
          labelSetCache,
          courseId,
          report,
        }));
    }

    // A successful live write is not "imported" until GET_COURSE read-back was
    // obtained and every blocking structural/course-field/settings comparison
    // passed. Announced media replacements and draw-from-bank randomness remain
    // in the expected bucket; unmigrated course settings do not.
    const parityReadBackMissing =
      !opts.dryRun && res.ok && !!res.newCourseId && parity === undefined;
    if (parityReadBackMissing) {
      report.ok = false;
      report.error =
        report.error ??
        `Parity read-back UNAVAILABLE: could not confirm target course ${res.newCourseId}`;
    } else if (parity && !parity.ok) {
      report.ok = false;
      report.error =
        report.error ??
        `Parity read-back FAILED: ${parity.issues.length} blocking divergence(s) on ${res.newCourseId}`;
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
      buildCourseReportMarkdown({ report, parity, l10nParity, l10nPending, l10nPendingSet, aiTextCells, manual }),
    );
    await storage.writeImportArtifact(
      `${courseId}.report.json`,
      buildCourseReportJson({
        report,
        parity,
        l10nParity,
        l10nPending,
        l10nPendingSet,
        aiTextCells,
        manual,
        idMap: res.idMap,
      }),
    );

    // Any BLOCKING read-back divergence — a surviving foreign key, a
    // translation-cell divergence, or a structural/course-field parity issue
    // (including an unmigrated setting), or an unavailable GET_COURSE — means
    // the course exists but is NOT confirmed faithful. Only explicitly
    // announced replacements/absences ride the expected bucket.
    const readBackDiverged =
      parityReadBackMissing ||
      readBackForeign.length > 0 ||
      (l10nParity && !l10nParity.ok) ||
      (parity && !parity.ok);
    const status: CourseStatus = opts.dryRun
      ? 'planned'
      : res.stopped
        ? 'stopped'
        : // A read-back divergence: never reported as imported; the course is
          // kept and a re-run (or manual fix) repairs it.
          res.ok && readBackDiverged
          ? 'partial'
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
      parity,
    });

    const titleStr = courseTitle ?? courseId;
    let msg: string;
    if (res.stopped) {
      msg = `STOPPED "${titleStr}" mid-course — partial, resumable on re-run (course ${res.newCourseId ?? '—'})`;
    } else if (res.ok && readBackDiverged) {
      msg =
        `PARTIAL "${titleStr}": ${report.error} — course ${res.newCourseId} kept; ` +
        'inspect the report (re-running only retries currently supported writes)';
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


