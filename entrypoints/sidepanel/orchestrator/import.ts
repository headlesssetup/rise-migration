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
  defaultOnlyCells,
  isLocalizedStack,
  storylineCells,
  resolveStackTitle,
  stackLocales,
} from '@/core/l10n';
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
  verifyL10nParity,
  estimateImportSeconds,
  sumEstimates,
  formatEstimate,
  type ImportEstimate,
  getTranslations,
  getSubscription,
  getAvailableLanguages,
  summarizeFlags,
  parseTypefaces,
  moveCourseToFolder,
  findForeignMediaKeys,
  type PlanInput,
  type AssetEntry,
  type SourceBank,
  type AccountIdentity,
  type ExecResult,
  type FidelityReport,
  type ManualWorkItem,
  type ParityReport,
  type L10nParityReport,
  type RunCsvCourse,
  verifyTypefaceBindings,
} from '@/core/import';
import { collectAssetKeys, isOrphanStatus } from '@/core/assets';
import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import type { Block } from '@/shared/types/rise';
import { etaStatus, unwrap, type ProgressEvent } from './shared';
import {
  refreshToken,
  bytesToBase64,
  contentTypeForExt,
  safeJson,
  makeFontReader,
  makePinnedRelay,
  pinnedRpc,
  pinTargetTab,
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

/**
 * Media keys a course's document references that the archive has NO bytes for
 * (and that are not recorded as terminal orphans). The usual cause is simply
 * that "Download assets" was never run for this archive — in which case the
 * import would create the course, convert the stack, and only then die on the
 * first upload, leaving a partial to clean up. Cheap to check up front.
 */
export function missingAssetKeys(
  doc: unknown,
  courseId: string,
  entries: { key: string; file?: string; orphaned?: boolean }[],
): string[] {
  const have = new Set(entries.filter((e) => e.file || e.orphaned).map((e) => e.key));
  const missing = new Set<string>();
  for (const k of collectAssetKeys(doc, courseId)) {
    if (!have.has(k.key)) missing.add(k.key);
  }
  return [...missing];
}

/**
 * Split a manifest's `failed` list into the two states the import must treat
 * differently. ONLY 403/404 means "deleted at the source" — a terminal orphan the
 * import may drop (blanked key + manual flag). Anything else (500, network, 0) is
 * an UNKNOWN state: the asset probably still exists and the export simply didn't
 * get it, so calling it orphaned would silently discard live media.
 */
export function classifyAssetFailures(
  failed: { key: string; status?: number; error?: string }[] | undefined,
): {
  orphans: { key: string; status?: number }[];
  unresolved: { key: string; status?: number; error?: string }[];
} {
  const orphans: { key: string; status?: number }[] = [];
  const unresolved: { key: string; status?: number; error?: string }[] = [];
  for (const f of failed ?? []) {
    if (isOrphanStatus(f.status)) orphans.push({ key: f.key, status: f.status });
    else unresolved.push({ key: f.key, status: f.status, error: f.error });
  }
  return { orphans, unresolved };
}

/** Map a course's saved asset manifest → plan AssetEntry[] (downloaded + orphan).
 *  `fileByKey` also yields the archive filename so we can read bytes for upload.
 *  `unresolved` lists keys whose bytes are missing for a NON-terminal reason. */
async function readCourseAssets(
  storage: Storage,
  courseId: string,
): Promise<{
  entries: AssetEntry[];
  fileByKey: Map<string, string>;
  unresolved: { key: string; status?: number; error?: string }[];
}> {
  const raw = await storage.readAssetManifest('courses', courseId);
  const entries: AssetEntry[] = [];
  const fileByKey = new Map<string, string>();
  const unresolved: { key: string; status?: number; error?: string }[] = [];
  if (!raw) return { entries, fileByKey, unresolved };
  try {
    const m = JSON.parse(raw) as {
      assets?: { key: string; kind: string; file: string; ext: string; size?: number }[];
      failed?: { key: string; status?: number; error?: string }[];
    };
    for (const a of m.assets ?? []) {
      entries.push({ key: a.key, kind: a.kind, file: a.file, ext: a.ext, size: a.size });
      fileByKey.set(a.key, a.file);
    }
    // Terminal orphans are imported as block-less (flagged) keys; anything else
    // aborts the course in runImport rather than dropping media as "deleted".
    const split = classifyAssetFailures(m.failed);
    for (const f of split.orphans) entries.push({ key: f.key, kind: 'media-other', orphaned: true });
    unresolved.push(...split.unresolved);
  } catch {
    /* tolerate a malformed manifest — treat as no assets */
  }
  return { entries, fileByKey, unresolved };
}

/** Build the storyline attach map for a source course from its storyline
 *  manifest: SOURCE block id → {reviewPrefix, meta, title}, but ONLY for blocks
 *  whose package has been uploaded (manifest.uploads[leaf].reviewPrefix exists).
 *  Blocks without an uploaded package are left to the manual flag path. */
async function readStorylineAttach(
  storage: Storage,
  courseId: string,
): Promise<
  | {
      /** Monolingual: source block id → the uploaded package to attach. */
      byBlock: Map<string, { reviewPrefix: string; meta?: unknown; title?: string }>;
      /** STACK (docs/rise-multilang.md §4.3b): `${blockId}|${locale}` → package,
       *  one per language (each language can carry its own bundle). */
      byBlockLocale: Map<
        string,
        { locale: string; l10nId?: string; reviewPrefix: string; meta?: unknown; title?: string }
      >;
    }
  | undefined
> {
  const raw = await storage.readStorylineManifest(courseId);
  if (!raw) return undefined;
  try {
    const m = JSON.parse(raw) as {
      blocks?: Array<{
        blockId: string;
        leaf: string;
        meta?: unknown;
        locale?: string;
        l10nId?: string;
      }>;
      uploads?: Record<string, { reviewPrefix?: string }>;
    };
    const byBlock = new Map<string, { reviewPrefix: string; meta?: unknown; title?: string }>();
    const byBlockLocale = new Map<
      string,
      { locale: string; l10nId?: string; reviewPrefix: string; meta?: unknown; title?: string }
    >();
    for (const b of m.blocks ?? []) {
      const reviewPrefix = m.uploads?.[b.leaf]?.reviewPrefix;
      if (!reviewPrefix) continue;
      const title =
        b.meta && typeof b.meta === 'object' ? (b.meta as { title?: string }).title : undefined;
      if (b.locale) {
        byBlockLocale.set(`${b.blockId}|${b.locale}`, {
          locale: b.locale,
          l10nId: b.l10nId,
          reviewPrefix,
          meta: b.meta,
          title,
        });
      } else {
        byBlock.set(b.blockId, { reviewPrefix, meta: b.meta, title });
      }
    }
    return byBlock.size || byBlockLocale.size ? { byBlock, byBlockLocale } : undefined;
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
  /** A FINISHED live import: ok, not stopped, with a real target course id. */
  completed: boolean;
}

function parsePriorReport(raw: string | null | undefined): PriorCourseReport | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as FidelityReport & {
      parity?: ParityReport | null;
      manualWork?: ManualWorkItem[];
      idMap?: Record<string, string>;
    };
    return {
      report: p,
      parity: p.parity ?? undefined,
      manual: p.manualWork ?? [],
      idMap: p.idMap,
      completed:
        p.ok === true && p.dryRun === false && !p.stopped && typeof p.newCourseId === 'string' && !!p.newCourseId,
    };
  } catch {
    return null; // corrupt report — treat as no prior run
  }
}

/**
 * Run an import for the selected source course ids. Enforces the Source ≠ Target
 * guard once up front, then imports each course strictly sequentially. Persists
 * `_import/<courseId>.report.{md,json}` + `<courseId>.joblog.json` (resume map).
 */
/** "Ready to import?" — rough pre-run estimate for the selected courses.
 *  Local only (archive reads + pure buildPlan; no network, no ids minted).
 *  Returns per-course estimates + the language count so the UI can show
 *  "N courses (M multi-language), ~X min (rough)". */
export async function estimateCourses(
  storage: Storage,
  courseIds: string[],
): Promise<{ estimate: ImportEstimate; stacks: number; missing: number }> {
  const per: ImportEstimate[] = [];
  let stacks = 0;
  let missing = 0;
  for (const courseId of courseIds) {
    const raw = await storage.readCourse(courseId);
    if (!raw) {
      missing++;
      continue;
    }
    try {
      const course = unwrap(raw);
      if (isLocalizedStack(course)) stacks++;
      const { entries } = await readCourseAssets(storage, courseId);
      const steps = buildPlan({
        course,
        assets: entries,
        banksById: new Map(),
        author: 'estimate',
      });
      per.push(estimateImportSeconds(steps, entries));
    } catch {
      missing++;
    }
  }
  return { estimate: sumEstimates(per), stacks, missing };
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

  // Pin the run to ONE target tab before anything touches the network. A live run
  // that can't be pinned is blocked (writes must never follow window focus); a
  // dry run only reads, so it proceeds unpinned with a warning.
  const { pin, blocked } = await pinTargetTab(target, onEvent);
  if (blocked && !opts.dryRun) {
    onEvent({ kind: 'log', message: `BLOCKED: ${blocked}` });
    return { blocked, outcomes };
  }
  if (blocked) onEvent({ kind: 'log', message: `WARN ${blocked} — dry run continues (reads only)` });
  const relay = makePinnedRelay(pin);
  const send = pinnedRpc(pin);

  // Start on a fresh bearer: the panel may have been idle since the token was
  // last captured, so the very first reads (target fonts) could otherwise 403.
  await refreshToken(onEvent, 'run start', pin);

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
      await refreshToken(onEvent, 'heartbeat', pin);
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
  const targetTypefaces = await fetchTargetTypefaces(onEvent, pin);

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
        : await setupFolders(storage, target, opts.dryRun, pacing, onEvent, pin);
  const typefaceSeed = accountMap.typefaces;
  if (boundBanks.size > 0) {
    onEvent({ kind: 'log', message: `Auto-binding draw-from-bank to ${boundBanks.size} imported bank(s).` });
  }
  const courseFolders = await readCourseFolders(storage);

  // --- Pre-flight: does the archive actually HOLD the media it references? ---
  // "Download assets" is a separate export step and easy to forget; without it
  // every course with media dies on its first upload AFTER the course (and, for a
  // stack, its languages) already exist. Warn once, up front, naming the courses.
  {
    const short: { id: string; title?: string; missing: number }[] = [];
    for (const id of courseIds) {
      const raw = await storage.readCourse(id);
      if (!raw) continue;
      const doc = unwrap(raw);
      const { entries } = await readCourseAssets(storage, id);
      const missing = missingAssetKeys(doc, id, entries);
      if (missing.length) {
        short.push({
          id,
          title: typeof doc.course?.title === 'string' ? doc.course.title : undefined,
          missing: missing.length,
        });
      }
    }
    if (short.length) {
      onEvent({
        kind: 'log',
        message:
          `⚠ ASSETS MISSING FROM THE ARCHIVE — did you forget Export → "Download assets"? ` +
          `${short.length} of ${courseIds.length} selected course(s) reference media this archive has no bytes for; ` +
          `they will be SKIPPED (nothing is created for them):`,
      });
      for (const c of short) {
        onEvent({
          kind: 'log',
          message: `    - ${c.title ?? c.id}: ${c.missing} missing asset(s)`,
        });
      }
    }
  }

  // --- Built-in (library/CDN) assets: verify on the TARGET plane -------------
  // These are copied verbatim (nothing to re-upload), but the two planes' asset
  // libraries are not known to be identical — a region may not serve a given
  // file. Probe once per distinct reference, run-wide, and let the executor flag
  // whatever it cannot confirm. A public CDN request: outside the pacing
  // invariant, and `no-store` so a probe never poisons the browser cache.
  const builtinProbeCache = new Map<
    string,
    { value: string; available: boolean | null; probedUrl: string; status?: number }
  >();
  const probeBuiltinAsset = async (url: string): Promise<{ ok: boolean; status: number }> => {
    try {
      const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      return { ok: r.ok, status: r.status };
    } catch {
      return { ok: false, status: 0 };
    }
  };

  // --- Multi-language stacks (docs/rise-multilang.md): run-level state ---
  // Account-scoped label sets recreated once per run (source set id → target id).
  const labelSetCache = new Map<string, string>();
  // Target's supported translation codes — fetched lazily, once, only when the
  // run contains a stack. Localization is free on every subscription; this is
  // purely a locale-code sanity check (cross-plane drift), so a fetch failure
  // downgrades to a warning (POST /translations still fails loudly if wrong).
  let availableTargetLangs: Set<string> | null | undefined;
  const fetchAvailableLangs = async (): Promise<Set<string> | null> => {
    if (availableTargetLangs !== undefined) return availableTargetLangs;
    try {
      const sub = await relay(getSubscription());
      const subBody = sub.ok ? (safeJson(sub.text) as Record<string, unknown>) : {};
      const subId = String(subBody?.id ?? '');
      if (!subId) throw new Error(`subscription id unavailable (HTTP ${sub.status})`);
      await pacedDelay(pacing);
      const al = await relay(getAvailableLanguages(subId));
      if (!al.ok) throw new Error(`available-languages HTTP ${al.status}`);
      const body = safeJson(al.text) as Record<string, unknown>;
      const info = (body?.languagesInfo ?? {}) as Record<string, unknown>;
      const rawTargets = Array.isArray(info.targetLangs) ? info.targetLangs : [];
      const codes = rawTargets
        .map((t) =>
          typeof t === 'string'
            ? t
            : String((t as Record<string, unknown>)?.targetLang ?? ''),
        )
        .filter(Boolean);
      availableTargetLangs = codes.length ? new Set(codes) : null;
      if (!availableTargetLangs) {
        onEvent({
          kind: 'log',
          message: 'WARN available-languages returned no target list — skipping the locale-code sanity check',
        });
      }
    } catch (e) {
      availableTargetLangs = null;
      onEvent({
        kind: 'log',
        message: `WARN could not read available-languages (${(e as Error).message}) — skipping the locale-code sanity check`,
      });
    }
    return availableTargetLangs;
  };

  // ETA: project remaining time from elapsed wall-clock and the fraction of work
  // done (course index + within-course step fraction). Self-correcting and pacing-
  // agnostic — no need to hardcode per-block/asset times. Live runs only.
  const numCourses = courseIds.length;
  const runStart = Date.now();
  const emitStatus = (i: number, done: number, total: number): void => {
    if (opts.dryRun) return;
    onEvent(
      etaStatus({
        label: `Importing ${i + 1}/${numCourses}`,
        doneFraction: (i + (total ? done / total : 0)) / Math.max(1, numCourses),
        runStartMs: runStart,
        nowMs: Date.now(),
      }),
    );
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
      });
      continue;
    }

    // Refresh the bearer before EACH course: every course is many paced writes,
    // and the first ducks call (UPDATE_COURSE_FIELD_THROTTLE / CREATE_LESSON)
    // 403s on a token that lapsed during the previous course. Per-course refresh
    // keeps each course starting on a token with the full ~15 min window.
    await refreshToken(onEvent, pfx, pin);
    lastAuthMs = Date.now();

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
    const absent = missingAssetKeys(course, courseId, entries);
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
        const missing = avail
          ? langs.filter((c) => c !== def && !avail.has(c))
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
    // root; folders are recreated account-level above). Best-effort + paced.
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

    // Read-back parity (live, successful runs only): paced GET_COURSE of the new
    // course → structural diff vs the archived source. The true round-trip check.
    // Done BEFORE persisting so it folds into the consolidated report.
    let parity: ParityReport | undefined;
    // Set when the read-back proves a source/foreign media key survived ON THE
    // TARGET — the executor's own check only inspects a locally derived document.
    let readBackForeign: string[] = [];
    // Multi-language stack read-back: translation-table parity + per-language
    // pending-translation counts (informational — see the report warning).
    let l10nParity: L10nParityReport | undefined;
    let l10nPending: Record<string, number> | undefined;
    let l10nPendingExpected: Record<string, number> | undefined;
    if (!opts.dryRun && res.ok && res.newCourseId) {
      await pacedDelay(pacing);
      onEvent({ kind: 'log', message: `Verifying parity (read-back GET_COURSE ${res.newCourseId})…` });
      // Pinned like every other request of the run: the read-back must GET the
      // course from the tab we wrote it to, or an unpinned re-resolve could ask
      // the SOURCE account for an id that only exists on the target (404 → a
      // false "could not verify" on a course that is actually fine).
      const rb = await send({ type: 'GET_COURSE', courseId: res.newCourseId });
      if (rb.type === 'COURSE_RESULT' && rb.result.ok) {
        const targetDoc = unwrap(rb.result.data.raw);
        parity = verifyParity(course, targetDoc, res.flags);
        onEvent({
          kind: 'log',
          message: parity.ok
            ? `Parity OK — ${parity.blocks.compared} block(s) match (${parity.expectedDivergences.length} expected divergence(s))`
            : `Parity DIVERGENCES — ${parity.issues.length} unexpected (see ${courseId}.report.md)`,
        });

        // INVARIANT, measured on the REAL target (CLAUDE.md: "no source media keys
        // may survive"). The executor asserts this against a doc it derived itself,
        // which can only ever confirm its own bookkeeping; this reads what Rise
        // actually stored. Any uploaded key not owned by the new course / new banks
        // is a key that wasn't remapped → fail this course loudly.
        const targetOwners = new Set<string>([res.newCourseId]);
        for (const sourceBankId of banksById.keys()) {
          const newBankId = res.idMap[sourceBankId] ?? boundBanks.get(sourceBankId)?.newBankId;
          if (newBankId) targetOwners.add(newBankId);
        }
        readBackForeign = findForeignMediaKeys(targetDoc, targetOwners);

        // Typeface IDENTITY: parity tokenizes ids, so it proves a font is bound
        // but not WHICH — resolve the three binding slots to names on both
        // sides (course.typefaces maps id → name in every GET_COURSE).
        {
          const hadTypefaceFlag = res.flags.some((f) => f.kind === 'typeface');
          const tf = verifyTypefaceBindings(course, targetDoc, hadTypefaceFlag);
          for (const i of tf.issues) {
            parity.issues.push({ kind: 'course-field-changed', path: i.path, detail: i.detail });
            parity.ok = false;
          }
          for (const i of tf.expected) {
            parity.expectedDivergences.push({
              kind: 'course-field-changed',
              path: i.path,
              detail: i.detail,
              expected: true,
            });
          }
          if (tf.issues.length) {
            onEvent({
              kind: 'log',
              message: `${pfx} ⚠ typeface read-back: ${tf.issues.map((i) => `${i.path} (${i.detail})`).join('; ')}`,
            });
          }
        }

        // Storyline bundles: copy_review_item's 200 proved the copy request was
        // accepted — HEAD the copied bundle's story.html on usercontent (public
        // read, outside pacing) to confirm it actually exists and serves.
        for (const prefix of res.storylinePrefixes ?? []) {
          const base = target?.plane === 'eu'
            ? 'https://articulateusercontent.eu/'
            : 'https://articulateusercontent.com/';
          let ok = false;
          let status = 0;
          try {
            const r = await fetch(`${base}${prefix}/story.html`, { method: 'HEAD', cache: 'no-store' });
            ok = r.ok;
            status = r.status;
          } catch {
            /* network error → unverified */
          }
          if (ok) {
            onEvent({ kind: 'log', message: `${pfx} storyline read-back OK — ${prefix}/story.html` });
          } else {
            parity.issues.push({
              kind: 'media-missing',
              path: `storyline ${prefix}/story.html`,
              detail: `attached bundle not readable on usercontent (HTTP ${status})`,
            });
            parity.ok = false;
            onEvent({
              kind: 'log',
              message: `${pfx} ⚠ storyline read-back: ${prefix}/story.html not readable (HTTP ${status})`,
            });
          }
        }
        if (readBackForeign.length) {
          report.ok = false;
          report.survivingSourceKeys = [
            ...new Set([...report.survivingSourceKeys, ...readBackForeign]),
          ];
          report.error =
            `Read-back FAILED: ${readBackForeign.length} foreign media key(s) survived on the target ` +
            `course ${res.newCourseId} (${readBackForeign.slice(0, 3).join(', ')}${readBackForeign.length > 3 ? ', …' : ''})`;
          onEvent({ kind: 'log', message: `${pfx} ${report.error} — course kept; re-run to repair, or fix those blocks manually` });
        }

        // Multi-language stack: verify the translation tables cell-by-cell
        // (locale sets, per-locale values modulo media remap) and read back the
        // per-language pending counts for the report.
        if (courseIsStack) {
          // Flagged storyline cells are deliberately NOT copied — their absence
          // on the target is announced, not a failure (docs/rise-multilang.md §4.3b).
          const toleratedMissing = new Set(
            storylineCells(course).map((c) => `${c.l10nId} ${c.locale}`),
          );
          l10nParity = verifyL10nParity(course, targetDoc, { toleratedMissing });
          // Per-language label-set bindings: every source locale with a CUSTOM
          // set must be bound on the target to the set this run recreated for it.
          for (const row of stackLocales(course)) {
            const code = String(row.locale ?? '');
            const srcSet = typeof row.labelSetId === 'string' ? row.labelSetId : null;
            if (!code || !srcSet || code === defaultLocaleOf(course)) continue;
            const expectedSet = labelSetCache.get(srcSet);
            const tgtRow = stackLocales(targetDoc).find((r) => r.locale === code);
            const actual = typeof tgtRow?.labelSetId === 'string' ? tgtRow.labelSetId : null;
            if (!actual || (expectedSet && actual !== expectedSet)) {
              l10nParity.issues.push({
                kind: 'labelset-binding',
                locale: code,
                detail: actual
                  ? `bound to ${actual}, expected ${expectedSet}`
                  : 'custom label set not bound on the target',
              });
              l10nParity.ok = false;
            }
          }
          onEvent({
            kind: 'log',
            message: l10nParity.ok
              ? `Language parity OK — ${l10nParity.cells.compared} cell(s) match across ${l10nParity.locales.target.length} language(s)`
              : `Language parity DIVERGENCES — ${l10nParity.issues.length} issue(s) (see ${courseId}.report.md)`,
          });
          if (!l10nParity.ok) {
            report.ok = false;
            report.error =
              report.error ??
              `Language read-back FAILED: ${l10nParity.issues.length} translation divergence(s) on ${res.newCourseId}`;
          }
          await pacedDelay(pacing);
          const tr = await relay(getTranslations(res.newCourseId));
          if (tr.ok && tr.text) {
            const body = safeJson(tr.text) as Record<string, unknown>;
            const items = Array.isArray(body?.stackItems)
              ? (body.stackItems as Record<string, unknown>[])
              : [];
            l10nPending = {};
            for (const it of items) {
              const code = String(it.locale ?? '');
              const n = typeof it.pendingChangesCount === 'number' ? it.pendingChangesCount : 0;
              if (code && n > 0) l10nPending[code] = n;
            }
            // Predict the count from the ARCHIVE (cells the source has only in
            // the default language) so the operator can match it against Rise's
            // badge: equal ⇒ expected/benign, different ⇒ a real signal.
            const expected = defaultOnlyCells(course);
            l10nPendingExpected = Object.fromEntries(
              Object.entries(expected).map(([c, v]) => [c, v.total]),
            );
            if (Object.keys(l10nPending).length) {
              const parts = Object.entries(l10nPending).map(([c, n]) => {
                const e = expected[c];
                if (!e) return `${c}: ${n}`;
                const verdict = n === e.total ? 'as expected' : `EXPECTED ${e.total}`;
                return `${c}: ${n} (${verdict}; ${e.media} media, ${e.text} text)`;
              });
              const mismatch = Object.entries(l10nPending).some(
                ([c, n]) => (expected[c]?.total ?? -1) !== n,
              );
              onEvent({
                kind: 'log',
                message:
                  `${pfx} NOTE: Rise shows "source changes detected" — ${parts.join(', ')}. ` +
                  'These are cells the SOURCE holds only in its default language (fallback ' +
                  'cells — mostly media): the content is identical, only Rise\'s sync marker ' +
                  'differs, and it cannot be set via the API. Do NOT click "Update Translations" ' +
                  '(it would AI-translate them).' +
                  (mismatch ? ' ⚠ The count does NOT match the archive — investigate.' : ''),
              });
            }
          }
        }
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
      buildCourseReportMarkdown({ report, parity, l10nParity, l10nPending, l10nPendingExpected, manual }),
    );
    await storage.writeImportArtifact(
      `${courseId}.report.json`,
      buildCourseReportJson({
        report,
        parity,
        l10nParity,
        l10nPending,
        l10nPendingExpected,
        manual,
        idMap: res.idMap,
      }),
    );

    const status: CourseStatus = opts.dryRun
      ? 'planned'
      : res.stopped
        ? 'stopped'
        : // A read-back survivor (foreign key OR translation divergence) means the
          // course exists but is NOT faithful — never reported as imported; the
          // course is kept and a re-run repairs it.
          res.ok && (readBackForeign.length || (l10nParity && !l10nParity.ok))
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
    });

    const titleStr = courseTitle ?? courseId;
    let msg: string;
    if (res.stopped) {
      msg = `STOPPED "${titleStr}" mid-course — partial, resumable on re-run (course ${res.newCourseId ?? '—'})`;
    } else if (res.ok && (readBackForeign.length || (l10nParity && !l10nParity.ok))) {
      msg = `PARTIAL "${titleStr}": ${report.error} — course ${res.newCourseId} kept (re-run to repair)`;
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
