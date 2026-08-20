// Run-level SETUP for a course import — split out of ./import's runImport
// (v0.9.0 restructure): the readiness/source≠target/pin gates, the run-start
// token refresh + heartbeat, account-level inputs (typefaces, fonts, id maps,
// folders), the asset-coverage preflight, the built-in-asset probe cache, the
// stack run-level caches, and the ETA emitter. Returns { blocked } or the
// RunContext the per-course loop destructures.

import {
  checkSourceNotTarget,
  getAvailableLanguages,
  getSubscription,
  parseTypefaces,
  type AccountIdentity,
} from '@/core/import';
import { archiveErrorSummary, inspectSelectedArchive } from '@/core/local-archive';
import { pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import { etaStatus, unwrap, type ProgressEvent } from './shared';
import {
  fetchTargetTypefaces,
  makeFontReader,
  makePinnedRelay,
  pinnedRpc,
  pinTargetTab,
  readAccountIdMap,
  readBankIdMap,
  readFontManifest,
  readSourceIdentity,
  refreshToken,
  safeJson,
  setupFolders,
} from './import-shared';
import {
  missingAssetKeys,
  readCourseAssets,
  readCourseFolders,
} from './import-run-inputs';
// Type-only import back into ./import: erased at compile time (cycle-free).
import type { ImportOptions } from './import';

export async function prepareImportRun(
  storage: Storage,
  courseIds: string[],
  target: AccountIdentity | undefined,
  opts: ImportOptions,
  onEvent: (e: ProgressEvent) => void,
  pacing: PacingConfig,
) {
  // Selected-input readiness is the first gate, before target pinning,
  // authentication, or any network work. Validate only what this run will use:
  // files exist, selected course JSON parses, and its media refs are covered.
  // Export-time hashes are intentionally NOT enforced; local replacement assets
  // are an operator-supported workflow.
  const archive = await inspectSelectedArchive(storage, courseIds);
  if (!archive.ready) {
    const reason = `Archive is not ready: ${archiveErrorSummary(archive) || 'validation failed'}`;
    onEvent({ kind: 'log', message: `BLOCKED: ${reason}` });
    return { blocked: reason };
  }

  // Safe-import gate: never write into the source account (unless overridden).
  const source = await readSourceIdentity(storage);
  const verdict = checkSourceNotTarget(source, target, opts.override);
  if (!verdict.ok && !opts.dryRun) {
    onEvent({ kind: 'log', message: `BLOCKED: ${verdict.reason}` });
    return { blocked: verdict.reason };
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
    return { blocked };
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
  // they were run first: the typeface id map and the imported-bank map for
  // auto-binding draw-from-bank blocks. (Persisted under `_import/`.)
  const accountMap = await readAccountIdMap(storage);
  const boundBanks = await readBankIdMap(storage);
  const typefaceSeed = accountMap.typefaces;
  if (boundBanks.size > 0) {
    onEvent({ kind: 'log', message: `Auto-binding draw-from-bank to ${boundBanks.size} imported bank(s).` });
  }
  const courseFolders = await readCourseFolders(storage);
  // Folders: driven by the "Re-create folders" checkbox, NOT by step A's
  // persisted id map (which can go stale — see the move-to-folder WARN).
  // ON → create/reuse ONLY the folder chains of the selected courses, deduped
  // by name+parent against a fresh listing of the target tree (so step-A
  // folders are found and reused). OFF → empty map ⇒ no creates, no moves.
  const folderIdMap = opts.recreateFolders
    ? await setupFolders(
        storage,
        target,
        opts.dryRun,
        pacing,
        onEvent,
        pin,
        courseIds.map((id) => courseFolders.get(id) ?? '').filter(Boolean),
      )
    : new Map<string, string>();

  // --- Pre-flight: does the archive actually HOLD the media it references? ---
  // "Download assets" is a separate export step and easy to forget; without it
  // every course with media dies on its first upload AFTER the course (and, for a
  // stack, its languages) already exist. Warn once, up front, naming the courses.
  // The per-id result is memoized (missingByCourse) so the per-course skip
  // check in the run loop below doesn't redo the same archive reads + scan.
  const missingByCourse = new Map<string, number>();
  {
    const short: { id: string; title?: string; missing: number }[] = [];
    for (const [idx, id] of courseIds.entries()) {
      onEvent({
        kind: 'log',
        message: `[${idx + 1}/${courseIds.length} preflight] checking archived assets…`,
      });
      const raw = await storage.readCourse(id);
      if (!raw) continue;
      const doc = unwrap(raw);
      const { entries } = await readCourseAssets(storage, id);
      const missing = missingAssetKeys(doc, id, entries);
      missingByCourse.set(id, missing.length);
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
  // Target's supported translation pairs, keyed by SOURCE language — fetched
  // lazily, once, only when the run contains a stack. Localization is free on
  // every subscription; this is purely a locale-code sanity check (cross-plane
  // drift), so a fetch failure downgrades to a warning (POST /translations
  // still fails loudly if wrong). Capture-confirmed shapes (capture_31july):
  //   GET /manage/api/subscription → {…, subscription: {subscription_id, …}}
  //   GET …/available-languages → {languagesInfo: {sourceLangs: [...],
  //     targetLangsIndexedBySourceLang: {<src>: [{targetLang, …}, …]}}}
  let availableBySource: Map<string, Set<string>> | null | undefined;
  const fetchAvailableLangs = async (): Promise<Map<string, Set<string>> | null> => {
    if (availableBySource !== undefined) return availableBySource;
    try {
      await pacedDelay(pacing); // paced like every other authoring-plane read
      const sub = await relay(getSubscription());
      const subBody = sub.ok ? (safeJson(sub.text) as Record<string, unknown>) : {};
      const subscription = (subBody?.subscription ?? {}) as Record<string, unknown>;
      const subId = String(subscription.subscription_id ?? '');
      if (!subId) throw new Error(`subscription id unavailable (HTTP ${sub.status})`);
      await pacedDelay(pacing);
      const al = await relay(getAvailableLanguages(subId));
      if (!al.ok) throw new Error(`available-languages HTTP ${al.status}`);
      const body = safeJson(al.text) as Record<string, unknown>;
      const info = (body?.languagesInfo ?? {}) as Record<string, unknown>;
      const indexed = (info.targetLangsIndexedBySourceLang ?? {}) as Record<string, unknown>;
      const map = new Map<string, Set<string>>();
      for (const [src, arr] of Object.entries(indexed)) {
        if (!Array.isArray(arr)) continue;
        const codes = arr
          .map((t) => String((t as Record<string, unknown>)?.targetLang ?? ''))
          .filter(Boolean);
        if (codes.length) map.set(src, new Set(codes));
      }
      availableBySource = map.size ? map : null;
      if (!availableBySource) {
        onEvent({
          kind: 'log',
          message: 'WARN available-languages returned no target list — skipping the locale-code sanity check',
        });
      }
    } catch (e) {
      availableBySource = null;
      onEvent({
        kind: 'log',
        message: `WARN could not read available-languages (${(e as Error).message}) — skipping the locale-code sanity check`,
      });
    }
    return availableBySource;
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

  /** Per-course bearer refresh + heartbeat-window reset (the loop calls this
   *  before each course; see the heartbeat comment above). */
  const refreshForCourse = async (pfx: string): Promise<void> => {
    await refreshToken(onEvent, pfx, pin);
    lastAuthMs = Date.now();
  };

  return {
    pin,
    send,
    relay,
    pacedWithHeartbeat,
    refreshForCourse,
    sourceTypefaces,
    readFontBytes,
    targetTypefaces,
    accountMap,
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
  };
}
