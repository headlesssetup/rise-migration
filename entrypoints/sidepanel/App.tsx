import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildCensus, type Census } from '@/core/census/aggregate';
import { censusToCsv, censusToJson } from '@/core/census/export';
import {
  buildNovelty,
  noveltyToCsv,
  noveltyToJson,
  type NoveltyReport,
} from '@/core/census/novelty';
import {
  buildProfiles,
  profileToCsv,
  profileToJson,
} from '@/core/census/profile';
import {
  bankCatalogToCsv,
  bankCatalogToJson,
  bankInventoryToCsv,
  bankInventoryToJson,
  buildBankCatalog,
  type BankCatalog,
} from '@/core/census/question-banks';
import {
  buildInventory,
  inventoryToCsv,
  inventoryToJson,
  withFolderPaths,
  type InventoryRow,
} from '@/core/census/inventory';
import { FileSystemStorage } from '@/core/storage/fs';
import type { Storage } from '@/core/storage/storage';
import {
  LOCAL_ARCHIVE_FORMAT,
  buildCourseEntries,
  createManifestV1,
  type LocalArchiveManifestV1,
} from '@/core/local-archive';
import type { SessionState } from '@/shared/messaging';
import type { SearchResultItem } from '@/shared/types/rise';
import {
  mergeById,
  parseIdRows,
  parseManifestCourses,
} from './archive-merge';
import { AssetsView } from './components/AssetsView';
import { BanksView } from './components/BanksView';
import { CensusView } from './components/CensusView';
import { ExportDocxPanel } from './components/ExportDocxPanel';
import { ImportView } from './components/ImportView';
import { LogLines } from './components/LogLines';
import { NoveltyView } from './components/NoveltyView';
import { SessionView } from './components/SessionView';
import { TaskHome, type View } from './components/TaskHome';
import { appendLogLines } from './log-lines';
import {
  clearDirHandle,
  loadDirHandle,
  saveDirHandle,
  verifyPermission,
} from './folder-store';
import {
  buildFolders,
  cdnBasesForPlane,
  countCourses,
  downloadAllAssets,
  makeCdnDownloader,
  exportCourses,
  fetchAccountExtras,
  fetchFolders,
  fetchQuestionBanks,
  buildBankInventoryRows,
  listAllCourses,
  scanSavedBanks,
  scanSavedCourses,
  exportStorylinePackages,
  type AssetsSummary,
  type ProgressEvent,
  type StorylineExportSummary,
} from './orchestrator';
import { rpc } from './rpc';

type DirPicker = (opts?: {
  mode?: 'read' | 'readwrite';
}) => Promise<FileSystemDirectoryHandle>;

type Phase = 'idle' | 'listing' | 'listed' | 'exporting' | 'done';

const PAGE = 16;

// The header course count is fetched once a Rise tab + token exist, but the very
// first attempt can still lose the race (or hit a transient 403). Retry on a
// bounded, human-paced backoff — never a tight loop, and after the last attempt
// the operator's Refresh is the only trigger.
const COUNT_RETRY_MS = [0, 4_000, 15_000, 45_000];

/** Message out of an unknown throw (Error, DOMException, string, …). */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Format a remaining-duration (ms) as HH:MM:SS for the log-header countdown. */
function fmtRemaining(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
}

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [view, setView] = useState<View>('home');
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [countAttempt, setCountAttempt] = useState(0);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [pendingHandle, setPendingHandle] =
    useState<FileSystemDirectoryHandle | null>(null);
  const [listLimit, setListLimit] = useState<number>(PAGE);
  const [searchTerm, setSearchTerm] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [courses, setCourses] = useState<SearchResultItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  // A live import run. Owned HERE, not inside ImportView: a mode-tab click must
  // not be able to unmount a running import into a detached closure (no Stop
  // button, no outcome table) while every export button goes clickable and can
  // interleave a second paced job through the same Rise tab.
  const [importRunning, setImportRunning] = useState(false);
  // Live import status for the log-header countdown (set via ImportView).
  const [importStatus, setImportStatus] = useState<
    { label: string; finishAt: number | null; done: boolean } | null
  >(null);
  const [, forceTick] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [census, setCensus] = useState<Census | null>(null);
  const [novelty, setNovelty] = useState<NoveltyReport | null>(null);
  const [banks, setBanks] = useState<BankCatalog | null>(null);
  const [assets, setAssets] = useState<AssetsSummary | null>(null);
  const [storyline, setStoryline] = useState<StorylineExportSummary | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  // Only auto-scroll the log to the bottom when the user is already there — if
  // they've scrolled up to read, leave their position alone.
  const stickToBottomRef = useRef(true);
  const onLogScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  const copyLog = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(log.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }, [log]);

  const addLog = useCallback((message: string) => {
    setLog((l) => appendLogLines(l, [message]));
  }, []);

  // Visually separate each new user-launched operation in the log: drop a blank
  // line before it (never as the very first line), then an optional bold ▶ header.
  const logBreak = useCallback((label?: string) => {
    setLog((l) =>
      appendLogLines(l, [
        ...(l.length === 0 ? [] : ['']),
        ...(label ? [`▶ ${label}`] : []),
      ]),
    );
  }, []);

  const clearLog = useCallback(() => setLog([]), []);

  const onImportStatus = useCallback(
    (e: Extract<ProgressEvent, { kind: 'import-status' }>) => {
      setImportStatus(
        e.done
          ? { label: e.label, finishAt: null, done: true }
          : {
              label: e.label,
              finishAt: e.etaSeconds != null ? Date.now() + e.etaSeconds * 1000 : null,
              done: false,
            },
      );
    },
    [],
  );

  // Tick once a second while a countdown is live, so the remaining time updates
  // between the (slower) status events.
  useEffect(() => {
    if (!importStatus || importStatus.finishAt == null) return;
    const id = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [importStatus]);

  // Poll session state (identity + token + Rise tab presence + account name).
  // Failures used to be silent — a dead service worker left "Connecting…" forever.
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const resp = await rpc({ type: 'GET_SESSION_STATE' });
        if (!alive) return;
        if (resp.type === 'SESSION_STATE') {
          setSession(resp.state);
          setSessionError(null);
        } else if (resp.type === 'ERROR') {
          setSessionError(resp.error);
        } else {
          setSessionError(`Unexpected reply: ${resp.type}`);
        }
      } catch (e) {
        if (alive) setSessionError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Restore the persisted destination folder on first load.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const handle = await loadDirHandle();
      if (!handle || !alive) return;
      setFolderName(handle.name);
      if (await verifyPermission(handle, false)) {
        setStorage(new FileSystemStorage(handle));
        addLog(`Folder restored: ${handle.name}`);
      } else {
        setPendingHandle(handle); // needs a click to re-grant access
      }
    })();
    return () => {
      alive = false;
    };
  }, [addLog]);

  // The account on the tab drives the count — refresh it when it changes.
  const accountName = session?.accountName ?? null;
  useEffect(() => {
    setTotalCount(null);
    setCountAttempt(0);
  }, [accountName]);

  /** Ask for the course count again (header affordance + after a failed run). */
  const refreshCount = useCallback(() => {
    setTotalCount(null);
    setCountAttempt(0);
  }, []);

  // Auto-fetch the total course count once a Rise tab AND a token are present.
  // A null answer used to wedge the header at "Courses: —" forever: the effect
  // could fire before the token was captured, and its deps never changed again.
  const risePresent = session?.risePresent ?? false;
  const hasToken = session?.hasToken ?? false;
  useEffect(() => {
    if (!risePresent || !hasToken || totalCount !== null) return;
    const delay = COUNT_RETRY_MS[countAttempt];
    if (delay === undefined) return; // attempts spent — Refresh is the retry
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        const n = await countCourses().catch(() => null);
        if (!alive) return;
        if (n !== null) setTotalCount(n);
        else setCountAttempt((a) => a + 1);
      })();
    }, delay);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [risePresent, hasToken, totalCount, countAttempt]);

  useEffect(() => {
    if (stickToBottomRef.current) {
      logRef.current?.scrollTo(0, logRef.current.scrollHeight);
    }
  }, [log]);

  const onEvent = useCallback(
    (e: ProgressEvent) => {
      if (e.kind === 'log') addLog(e.message);
      else if (e.kind === 'course')
        setProgress({ done: e.index + 1, total: e.total });
      // Drive the header countdown for export/upload too (not just import).
      else if (e.kind === 'import-status') onImportStatus(e);
    },
    [addLog, onImportStatus],
  );

  const useFolder = useCallback(
    (handle: FileSystemDirectoryHandle) => {
      setStorage(new FileSystemStorage(handle));
      setFolderName(handle.name);
      setPendingHandle(null);
    },
    [],
  );

  const pickFolder = useCallback(async () => {
    const picker = (window as unknown as { showDirectoryPicker?: DirPicker })
      .showDirectoryPicker;
    if (!picker) {
      addLog('File System Access API unavailable in this browser.');
      return;
    }
    try {
      const handle = await picker({ mode: 'readwrite' });
      await saveDirHandle(handle);
      useFolder(handle);
      addLog(`Folder selected: ${handle.name}`);
    } catch {
      /* user cancelled */
    }
  }, [addLog, useFolder]);

  const reconnectFolder = useCallback(async () => {
    if (!pendingHandle) return;
    if (await verifyPermission(pendingHandle, true)) {
      useFolder(pendingHandle);
      addLog(`Folder reconnected: ${pendingHandle.name}`);
    } else {
      addLog('Folder access was not granted.');
    }
  }, [pendingHandle, addLog, useFolder]);

  const forgetFolder = useCallback(async () => {
    await clearDirHandle();
    setStorage(null);
    setFolderName(null);
    setPendingHandle(null);
    addLog('Folder forgotten.');
  }, [addLog]);

  // Every export handler runs inside this guard. Without it a single rejection
  // (relay error, FS write, JSON throw) left `phase` latched at listing/exporting
  // → `busy` true forever, every button disabled, and NOT ONE line in the log.
  const guarded = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        addLog(`FAILED — ${label}: ${errText(e)}`);
      } finally {
        // Success paths have already moved on to 'listed'/'done'; this only
        // releases a run that died while still latched busy.
        setPhase((p) => (p === 'listing' || p === 'exporting' ? 'idle' : p));
      }
    },
    [addLog],
  );

  const list = useCallback(
    () =>
      guarded('List courses', async () => {
        logBreak('List courses');
        setPhase('listing');
        setCourses([]);
        const result = await listAllCourses(
          onEvent,
          listLimit,
          undefined,
          undefined,
          searchTerm.trim() || undefined,
        );
        setCourses(result);
        setSelected(new Set(result.map((c) => c.id)));
        setPhase('listed');
        addLog(`Found ${result.length} courses.`);

        // List-level inventory: a customer-ready catalog, no GET_COURSE needed.
        if (storage) {
          // The `location` column: resolve each course's folderId to a name-path.
          // The listing only carries the id, so we need the folder tree — and we
          // REFETCH it every listing (one paced read). A saved folders.json goes
          // stale the moment the operator adds a folder in Rise, and trusting it
          // left every course in a new folder permanently location-less, with a
          // re-list unable to fix it.
          addLog('Fetching the folder tree (for the inventory location column)…');
          await fetchFolders(storage, onEvent);
          const pathByFolderId = new Map<string, string>();
          for (const f of await buildFolders(storage)) {
            if (f.source === 'course') pathByFolderId.set(f.id, f.path);
          }
          if (!pathByFolderId.size) {
            addLog('No folder tree available — inventory location will be blank.');
          }
          const unresolved = new Set(
            result
              .map((c) => String(c.folderId ?? ''))
              .filter((id) => id && !pathByFolderId.has(id)),
          );
          if (unresolved.size) {
            addLog(
              `⚠ ${unresolved.size} folder id(s) are absent from the folder tree — those courses get a blank location (ids: ${[...unresolved].join(', ')}).`,
            );
          }
          const rows = buildInventory(result, pathByFolderId);
          // MERGE with what's on disk: this listing may be a partial page range,
          // and the import side reads inventory.json for folder placement of
          // EVERY archived course — overwriting it hid earlier batches. Paths are
          // backfilled across the whole merged set, so rows from an earlier
          // listing (possibly written before any folder export) get a location too.
          const merged = withFolderPaths(
            mergeById(parseIdRows<InventoryRow>(await storage.readInventory()), rows),
            pathByFolderId,
          );
          await storage.writeInventory(
            inventoryToJson(merged),
            inventoryToCsv(merged),
          );
          addLog(
            `Inventory written (${merged.length} rows total, ${rows.length} from this listing) → inventory.csv/json.`,
          );
        } else {
          const rows = buildInventory(result);
          addLog(
            `Inventory built (${rows.length} rows) — connect a folder to save it.`,
          );
        }
      }),
    [guarded, onEvent, addLog, logBreak, listLimit, searchTerm, storage],
  );

  const toggle = useCallback((id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected = courses.length > 0 && selected.size === courses.length;
  const toggleAll = useCallback(() => {
    setSelected((s) =>
      s.size === courses.length ? new Set() : new Set(courses.map((c) => c.id)),
    );
  }, [courses]);

  const selectedCourses = useMemo(
    () => courses.filter((c) => selected.has(c.id)),
    [courses, selected],
  );

  const runExport = useCallback(
    () =>
      guarded('Fetch courses', async () => {
        if (!storage) return;
        logBreak('Fetch courses');
        setPhase('exporting');
        setCensus(null);
        setNovelty(null);
        setProgress({ done: 0, total: selectedCourses.length });

        // Read the archive's current course list BEFORE overwriting the manifest.
        const priorCourses = parseManifestCourses(await storage.readManifest());

        const { saved, skipped, failed, stopped } = await exportCourses(
          selectedCourses,
          storage,
          onEvent,
        );

        // Build the report from EVERY saved course in the folder (not just this
        // run's selection) — so partial / multi-attempt scrapes stay complete.
        const scans = await scanSavedCourses(storage, onEvent);
        const built = buildCensus(scans);
        await storage.writeCensus(censusToJson(built), censusToCsv(built));

        // Per-variant field profiles (the catalog knowledge base) + Tier-2 novelty.
        const profiles = buildProfiles(scans);
        await storage.writeCatalog(profileToJson(profiles), profileToCsv(profiles));
        const nov = buildNovelty(profiles);
        await storage.writeNovelty(noveltyToJson(nov), noveltyToCsv(nov));

        // The course list ACCUMULATES across export batches — the import picker
        // reads it as the archive's contents, so it must not shrink to just this
        // run's selection while the earlier batches' JSON sits on disk.
        const knownCourses = mergeById(
          priorCourses,
          selectedCourses.map((c) => ({ id: c.id, title: c.title })),
        );
        const knownTitleById = new Map(knownCourses.map((course) => [course.id, course.title]));
        // The manifest describes what is actually on disk, not merely what this
        // batch selected or what an older manifest happened to list.
        const courseList = (await storage.listSaved()).map((id) => ({
          id,
          title: knownTitleById.get(id),
        }));
        const createdAt = new Date().toISOString();
        const sourceAccount = {
            name: session?.accountName ?? session?.identity?.name ?? null,
            sub: session?.identity?.sub ?? null,
            email: session?.identity?.email ?? null,
            plane: session?.plane ?? null,
          };
        await storage.writeManifest(
          createManifestV1({
            origin: 'rise-export',
            // Export has more stages (assets/banks/Storyline). Download assets
            // validates the self-contained byte set and promotes this to ready.
            state: 'building',
            createdAt,
            toolVersion: browser.runtime.getManifest().version,
            sourceAccount,
            courses: await buildCourseEntries(storage, courseList),
            exportSummary: {
              courseCount: scans.length,
              saved,
              skipped,
              failed,
              variantCount: nov.variantCount,
              newVariants: nov.newVariants.map((v) => v.key),
              newFields: nov.newFields.length,
            },
          }),
        );
        setCensus(built);
        setNovelty(nov);
        setPhase('done');
        addLog(
          stopped
            ? `Stopped safely — saved ${saved}, skipped ${skipped}, failed ${failed.length}; ${stopped.remaining} course(s) not attempted. Partial census + catalog + novelty written.`
            : `Done — saved ${saved}, skipped ${skipped}, failed ${failed.length}. Census + catalog + novelty written.`,
        );
        addLog(
          `Catalog: ${nov.variantCount} variant(s). Novelty: ${nov.newVariants.length} new variant(s), ${nov.newFields.length} new field(s). Manifest lists ${courseList.length} course(s).`,
        );
      }),
    [guarded, storage, selectedCourses, onEvent, addLog, logBreak, session],
  );

  const runBanks = useCallback(
    () =>
      guarded('Fetch question banks', async () => {
        if (!storage) return;
        logBreak('Fetch question banks');
        setPhase('exporting');
        setBanks(null);
        setProgress(null);
        const res = await fetchQuestionBanks(storage, onEvent);
        const saved = await scanSavedBanks(storage, onEvent);
        const cat = buildBankCatalog(saved);
        await storage.writeBankCatalog(
          bankCatalogToJson(cat),
          bankCatalogToCsv(cat),
        );

        // Per-bank inventory (decision table: size, folder, usage, owner, status).
        const inv = await buildBankInventoryRows(storage, saved);
        await storage.writeBankInventory(
          bankInventoryToJson(inv),
          bankInventoryToCsv(inv),
        );
        addLog(
          `Bank inventory: ${inv.length} bank(s) → question-banks-inventory.csv/json.`,
        );

        setBanks(cat);
        setPhase('done');
        if (res.failed.length) {
          addLog(`Question banks: ${res.failed.length} failed to fetch.`);
        }
        addLog(
          `Question banks: ${cat.bankCount} bank(s), ${cat.questionCount} question(s); types: ${
            cat.byType.map((t) => `${t.type}:${t.count}`).join(', ') || 'none'
          }. → question-banks-catalog.csv/json.`,
        );
        if (cat.mediaRefs.length) {
          addLog(
            `Bank media: ${cat.mediaRefs.map((m) => `${m.kind}:${m.count}`).join(', ')}.`,
          );
        }
        // Merge bank folders (from the saved index) into the folder inventory.
        const folders = await buildFolders(storage);
        if (folders.length) {
          addLog(`Folders updated: ${folders.length} total (incl. bank folders).`);
        }
      }),
    [guarded, storage, onEvent, addLog, logBreak],
  );

  const runAssets = useCallback(
    () =>
      guarded('Download assets', async () => {
        if (!storage) return;
        logBreak('Download assets');
        setPhase('exporting');
        setAssets(null);
        setProgress(null);
        // Plane-aware CDN host: prefer the account plane recorded in the archive
        // manifest (the account the media belongs to), else the live tab's plane,
        // else try both (US then EU).
        let plane: 'us' | 'eu' | null = session?.plane ?? null;
        try {
          const m = await storage.readManifest();
          const recorded = m
            ? (JSON.parse(m).sourceAccount?.plane as typeof plane)
            : null;
          if (recorded === 'us' || recorded === 'eu') plane = recorded;
        } catch {
          /* fall back to the live session plane / both */
        }
        const bases = cdnBasesForPlane(plane);
        addLog(`Downloading assets from ${bases.join(' / ')} (parallel)…`);
        const summary = await downloadAllAssets(
          storage,
          onEvent,
          makeCdnDownloader(bases),
        );
        setAssets(summary);
        setPhase('done');
        const orphan = summary.orphaned.reduce((s, o) => s + o.keys.length, 0);
        const optionalUnavailable = summary.optionalUnavailable.reduce(
          (s, o) => s + o.keys.length,
          0,
        );
        addLog(
          `Assets: ${summary.written} written, ${summary.deduped} deduped, ${summary.reused} reused, ${summary.failed} failed across ${summary.owners} owner(s)${
            summary.skipped ? ` (${summary.skipped} already done)` : ''
          }. → assets/, *.assets.json, assets-summary.json.`,
        );
        if (orphan) {
          addLog(
            `⚠ ${orphan} active asset(s) unavailable at source (403/404); flagged for manual handling.`,
          );
        }
        if (optionalUnavailable) {
          addLog(
            `${optionalUnavailable} optional source/provenance ref(s) unavailable; active rendering media is unaffected.`,
          );
        }
        if (!summary.complete) {
          const n = summary.undownloaded.reduce((s, o) => s + o.keys.length, 0);
          addLog(
            `⚠ ${n} key(s) failed (non-403/404) — click Download assets again to retry.`,
          );
        }
        // Promote a versioned export archive only after the byte manifests have
        // been written and checksummed. Legacy manifests stay untouched.
        try {
          const raw = await storage.readManifest();
          const manifest = raw ? (JSON.parse(raw) as LocalArchiveManifestV1) : null;
          if (manifest?.format === LOCAL_ARCHIVE_FORMAT && manifest.formatVersion === 1) {
            const courses = await buildCourseEntries(
              storage,
              manifest.courses.map((c) => ({ id: c.id, title: c.title })),
            );
            await storage.writeManifest({
              ...manifest,
              state: summary.complete ? 'ready' : 'building',
              courses,
              exportSummary: {
                ...(manifest.exportSummary ?? {}),
                assets: {
                  complete: summary.complete,
                  owners: summary.owners,
                  failed: summary.failed,
                  failedOwners: summary.failedOwners.length,
                },
              },
            });
            addLog(
              summary.complete
                ? 'Archive preflight state: READY.'
                : 'Archive preflight state: INCOMPLETE — asset retries are required before import.',
            );
          }
        } catch (e) {
          addLog(`⚠ Could not update archive readiness: ${errText(e)}`);
        }
      }),
    [guarded, storage, onEvent, addLog, logBreak, session],
  );

  const runStoryline = useCallback(
    () =>
      guarded('Export storyline packages', async () => {
        if (!storage) return;
        logBreak('Export storyline packages');
        setPhase('exporting');
        setStoryline(null);
        setProgress(null);
        // Scope to the currently SELECTED courses so the operator can test 1-2 of
        // hundreds; if nothing is selected, fall back to all saved courses.
        const onlyCourseIds = selected.size > 0 ? new Set(selected) : undefined;
        addLog(
          onlyCourseIds
            ? `Exporting Storyline packages for ${onlyCourseIds.size} selected course(s)…`
            : 'Scanning ALL saved courses for Storyline blocks, then exporting + repackaging each (Review-360 form)…',
        );
        const summary = await exportStorylinePackages(storage, onEvent, {
          onlyCourseIds,
        });
        setStoryline(summary);
        setPhase('done');
        addLog(
          `Storyline: ${summary.packaged} packaged, ${summary.skipped} skipped, ${summary.failed} failed of ${summary.courses} course(s) with storyline blocks; ${summary.legacySkipped} legacy package(s) flagged for manual replacement. → storyline/<courseId>/<leaf>.zip + manifest.`,
        );
        if (summary.failed) {
          for (const e of summary.errors) addLog(`⚠ ${e.courseId}: ${e.error}`);
        }
      }),
    [guarded, storage, onEvent, addLog, logBreak, selected],
  );

  const runAccount = useCallback(
    () =>
      guarded('Export account data', async () => {
        if (!storage) return;
        logBreak('Export account data');
        setPhase('exporting');
        setProgress(null);
        addLog('Exporting account data (folders, block templates, typefaces)…');

        // Folder tree — account-level data, independent of the course listing.
        await fetchFolders(storage, onEvent);
        const folders = await buildFolders(storage);
        if (folders.length) {
          const course = folders.filter((f) => f.source === 'course').length;
          const bank = folders.filter((f) => f.source === 'bank').length;
          addLog(
            `Folders: ${folders.length} (${course} course, ${bank} bank) → folders-inventory.csv/json.`,
          );
        }

        const s = await fetchAccountExtras(storage, onEvent);
        setPhase('done');
        addLog(
          `Account data: ${folders.length} folder(s), ${s.blockTemplates} block template(s), ${s.typefaces} typeface(s) + ${s.fonts.written} font file(s).`,
        );
      }),
    [guarded, storage, onEvent, addLog, logBreak],
  );

  // `busy` gates EVERY mode tab + export action. A live import counts: leaving
  // it out let one click detach the run and start a second paced job alongside it.
  const busy = phase === 'listing' || phase === 'exporting' || importRunning;
  const atAll = totalCount !== null && listLimit >= totalCount;

  // Setup gate: a Rise tab, a destination folder, and a captured token.
  const ready = !!session?.risePresent && !!storage && !!session?.hasToken;
  const setupNeeds = [
    !session?.risePresent && 'open a logged-in Rise tab',
    !storage && 'pick a destination folder',
    // The token is read from the Rise cookie automatically once a logged-in tab
    // is found — surfaced as a transient status, not an action.
    session?.risePresent &&
      !session?.hasToken &&
      'capturing the session token… (reload your Rise tab if it doesn’t appear)',
  ].filter(Boolean) as string[];

  const VIEW_TITLE: Record<View, string> = {
    home: 'Rise tools',
    archive: 'Export from Rise',
    import: 'Import into Rise',
    'export-docx': 'Save course to document',
  };

  return (
    <div className="app">
      {view === 'home' ? (
        <>
          <h1>Rise tools</h1>
          {sessionError && (
            <p className="hint" style={{ color: '#c00' }}>⚠ {sessionError}</p>
          )}
          {!storage && !pendingHandle && (
            <section className="card">
              <button onClick={pickFolder}>Pick archive folder…</button>
            </section>
          )}
          {pendingHandle && !storage && (
            <section className="card">
              <p className="hint">
                Folder remembered but needs access —{' '}
                <button onClick={reconnectFolder}>Reconnect: {pendingHandle.name}</button>
              </p>
            </section>
          )}
          <TaskHome
            session={session}
            storage={storage}
            folderName={folderName}
            busy={busy}
            onNavigate={setView}
          />
        </>
      ) : (
        <>
          <div className="view-header">
            <button
              className="back-btn"
              onClick={() => setView('home')}
              disabled={busy}
            >
              ←
            </button>
            <h1>{VIEW_TITLE[view]}</h1>
          </div>
          {importRunning && view !== 'import' && (
            <p className="hint" style={{ color: '#c00' }}>
              An import is running — go back to <b>Import to account</b> to
              monitor or stop it.
            </p>
          )}
        </>
      )}

      {/* Setup card — shown in archive/import views */}
      {(view === 'archive' || view === 'import') && (
        <section className="card">
          <h2>Setup</h2>
          <SessionView
            session={session}
            sessionError={sessionError}
            totalCount={totalCount}
            onRefreshCount={refreshCount}
            refreshDisabled={busy}
          />
          <div className="row" style={{ marginTop: 6 }}>
            <button onClick={pickFolder} disabled={busy}>
              {folderName ? `Folder: ${folderName}` : 'Pick folder…'}
            </button>
            {folderName && (
              <button onClick={forgetFolder} disabled={busy}>
                Forget
              </button>
            )}
          </div>
          {pendingHandle && (
            <p className="hint">
              Folder remembered but needs access —{' '}
              <button onClick={reconnectFolder}>Reconnect</button>
            </p>
          )}
          {!ready && setupNeeds.length > 0 && (
            <p className="hint">To continue: {setupNeeds.join(' · ')}.</p>
          )}
        </section>
      )}

      {/* Import view */}
      {view === 'import' && storage && (
        <ImportView
          storage={storage}
          session={session}
          addLog={addLog}
          logBreak={logBreak}
          onStatus={onImportStatus}
          running={importRunning}
          setRunning={setImportRunning}
        />
      )}

      {/* Archive (export) view — steps A through D */}
      {view === 'archive' && ready && (
      <>
      <section className="card">
        <h2>A · Account Data</h2>
        <button
          onClick={runAccount}
          disabled={busy || !storage || !session?.risePresent}
        >
          {phase === 'exporting' ? 'Working…' : 'Export account data'}
        </button>
        <p className="hint">
          Block templates and custom typefaces (+ font files). Raw → account/,
          reports → _metadata/.
        </p>
      </section>

      <section className="card">
        <h2>B · Question banks</h2>
        <button
          onClick={runBanks}
          disabled={busy || !storage || !session?.risePresent}
        >
          {phase === 'exporting' ? 'Working…' : 'Fetch question banks (paced)'}
        </button>
        <p className="hint">
          Reusable banks referenced by draw-from-bank blocks — saved to
          question-banks/, profiled in question-banks-catalog.csv/json.
        </p>
        {banks && <BanksView banks={banks} />}
      </section>

      <section className="card">
        <h2>C · Courses</h2>
        <input
          type="text"
          placeholder="Search by name…"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          disabled={busy}
          style={{ width: '100%', boxSizing: 'border-box', marginBottom: 6 }}
        />
        <div className="row">
          <label>
            List{' '}
            <input
              type="number"
              min={PAGE}
              step={PAGE}
              value={listLimit}
              disabled={busy}
              onChange={(e) =>
                setListLimit(Math.max(PAGE, Number(e.target.value) || PAGE))
              }
              style={{ width: 72 }}
            />{' '}
            courses
          </label>
          <button
            onClick={() => totalCount !== null && setListLimit(totalCount)}
            disabled={busy || totalCount === null || atAll}
          >
            All{totalCount !== null ? ` (${totalCount})` : ''}
          </button>
        </div>
        <button onClick={list} disabled={busy}>
          {phase === 'listing'
            ? 'Listing…'
            : `List ${atAll ? 'all' : listLimit} course(s) (paced)`}
        </button>

        {courses.length > 0 && (
          <>
            <div className="row">
              <label>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                />{' '}
                Select all ({selected.size}/{courses.length})
              </label>
              <button
                onClick={runExport}
                disabled={
                  busy ||
                  !storage ||
                  selected.size === 0 ||
                  !session?.risePresent
                }
              >
                {phase === 'exporting'
                  ? 'Fetching…'
                  : `Fetch ${selected.size} course(s) →`}
              </button>
            </div>
            <ul className="course-list">
              {courses.map((c) => (
                <li key={c.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={() => toggle(c.id)}
                    />{' '}
                    {c.title ?? c.id}
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card">
        <h2>C2 · Assets</h2>
        <button onClick={runAssets} disabled={busy || !storage}>
          {phase === 'exporting' ? 'Working…' : 'Download assets'}
        </button>
        <p className="hint">
          Downloads uploaded media (image/video/audio) for every saved course +
          bank from the public CDN (parallel — no pacing). Stored content-addressed
          in assets/ with per-owner *.assets.json. Storyline bundles, cdn.articulate.com,
          and YouTube/Vimeo embeds are kept as references. No Rise tab required.
        </p>
        {assets && <AssetsView summary={assets} />}
      </section>

      <section className="card">
        <h2>D · Embeds (Storyline)</h2>
        <button onClick={runStoryline} disabled={busy || !storage || !session?.risePresent}>
          {phase === 'exporting'
            ? 'Working…'
            : selected.size > 0
              ? `Export storyline packages (${selected.size} selected)`
              : 'Export storyline packages (ALL saved)'}
        </button>
        <p className="hint">
          For the courses <b>selected above</b> (or all saved courses if none selected) that
          contain Storyline/Mighty blocks: triggers a Rise web export (paced), downloads the zip,
          and repackages every storyline bundle into a Review-360 upload zip →
          storyline/&lt;courseId&gt;/&lt;leaf&gt;.zip + a per-course manifest. Select 1–2 courses in
          C to test without exporting everything. Re-runnable (skips courses already exported).
        </p>
        {storyline && (
          <p className="hint">
            {storyline.packaged} packaged · {storyline.skipped} skipped · {storyline.failed} failed
            {' '}of {storyline.courses} storyline course(s).
          </p>
        )}
      </section>
      </>
      )}

      {/* Export to docx view */}
      {view === 'export-docx' && storage && (
        <ExportDocxPanel storage={storage} addLog={addLog} />
      )}

      {/* Archive-view reports */}
      {view === 'archive' && progress && (
        <section className="card">
          <h2>Progress</h2>
          <p>
            {progress.done} / {progress.total}
          </p>
        </section>
      )}

      {view === 'archive' && novelty && (
        <section className="card">
          <h2>Novelty</h2>
          <NoveltyView novelty={novelty} />
        </section>
      )}

      {view === 'archive' && census && (
        <details className="card">
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            Census — {census.courseCount} course(s) · {census.variants.length}{' '}
            variants · {census.refs.length} ref shapes
          </summary>
          <CensusView census={census} />
        </details>
      )}

      {/* Log — always visible */}
      <section className="card log-card">
        <div className="log-header">
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
            <h2>Log</h2>
            {importStatus && (
              <span className="hint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                {importStatus.label}
                {importStatus.finishAt != null
                  ? ` · ${fmtRemaining(importStatus.finishAt - Date.now())} remaining`
                  : importStatus.done
                    ? ''
                    : ' · estimating…'}
              </span>
            )}
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button
              className="copy-btn"
              onClick={copyLog}
              disabled={log.length === 0}
              title="Copy log to clipboard"
              aria-label="Copy log to clipboard"
            >
              {copied ? (
                '✓ Copied'
              ) : (
                <>
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>{' '}
                  Copy
                </>
              )}
            </button>
            <button
              className="copy-btn"
              onClick={clearLog}
              disabled={log.length === 0}
              title="Clear log"
              aria-label="Clear log"
            >
              Clear
            </button>
          </span>
        </div>
        <div className="log" ref={logRef} onScroll={onLogScroll}>
          <LogLines lines={log} />
        </div>
      </section>
    </div>
  );
}
