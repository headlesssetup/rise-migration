// Export-run state + the six export handlers — split out of App.tsx (v0.9.0
// restructure). The hook is called by App (NOT by the export view): run state
// must survive view navigation, and a run's stop/progress handles must never
// live in a component that unmounts. Views receive the returned handles only.
import { useCallback, useMemo, useState } from 'react';
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
import {
  buildFolders,
  cdnBasesForPlane,
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

export type Phase = 'idle' | 'listing' | 'listed' | 'exporting' | 'done';

export const PAGE = 16;

/** Message out of an unknown throw (Error, DOMException, string, …). */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface ExportRunsArgs {
  storage: Storage | null;
  session: SessionState | null;
  addLog: (message: string) => void;
  logBreak: (label?: string) => void;
  /** Live run status for the log-header countdown (shared with import). */
  onRunStatus: (e: Extract<ProgressEvent, { kind: 'import-status' }>) => void;
}

export function useExportRuns({
  storage,
  session,
  addLog,
  logBreak,
  onRunStatus,
}: ExportRunsArgs) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [listLimit, setListLimit] = useState<number>(PAGE);
  const [searchTerm, setSearchTerm] = useState('');
  const [courses, setCourses] = useState<SearchResultItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [census, setCensus] = useState<Census | null>(null);
  const [novelty, setNovelty] = useState<NoveltyReport | null>(null);
  const [banks, setBanks] = useState<BankCatalog | null>(null);
  const [assets, setAssets] = useState<AssetsSummary | null>(null);
  const [storyline, setStoryline] = useState<StorylineExportSummary | null>(null);

  const onEvent = useCallback(
    (e: ProgressEvent) => {
      if (e.kind === 'log') addLog(e.message);
      else if (e.kind === 'course')
        setProgress({ done: e.index + 1, total: e.total });
      // Drive the header countdown for export/upload too (not just import).
      else if (e.kind === 'import-status') onRunStatus(e);
    },
    [addLog, onRunStatus],
  );

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

  // Listing is a PURE paced search + display (v0.9.0). The inventory used to be
  // written here as a hidden side effect (plus a paced folder-tree refetch per
  // listing) — it is now the operator's explicit `saveInventory` click below.
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
      }),
    [guarded, onEvent, addLog, logBreak, listLimit, searchTerm],
  );

  // "Save visible course list": the explicit inventory write. Import reads
  // inventory.json for folder placement; the Storyline stage (D) records
  // legacy flags into it.
  const saveInventory = useCallback(
    () =>
      guarded('Save course list', async () => {
        if (!storage || courses.length === 0) return;
        logBreak('Save course list');
        setPhase('exporting');
        // The `location` column: resolve each course's folderId to a name-path.
        // The listing only carries the id, so we need the folder tree — and we
        // REFETCH it on every save (one paced read). A saved folders.json goes
        // stale the moment the operator adds a folder in Rise, and trusting it
        // left every course in a new folder permanently location-less, with a
        // re-save unable to fix it.
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
          courses
            .map((c) => String(c.folderId ?? ''))
            .filter((id) => id && !pathByFolderId.has(id)),
        );
        if (unresolved.size) {
          addLog(
            `⚠ ${unresolved.size} folder id(s) are absent from the folder tree — those courses get a blank location (ids: ${[...unresolved].join(', ')}).`,
          );
        }
        const rows = buildInventory(courses, pathByFolderId);
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
        setPhase('done');
        addLog(
          `Inventory written (${merged.length} rows total, ${rows.length} from this listing) → inventory.csv/json.`,
        );
      }),
    [guarded, onEvent, addLog, logBreak, courses, storage],
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
          `Storyline: ${summary.packaged} packaged, ${summary.skipped} skipped, ${summary.failed} failed of ${summary.courses} course(s) with storyline blocks; ${summary.legacySkipped} legacy package(s) flagged, ${summary.legacySaved} preserved. → storyline/<courseId>/<leaf>.zip, storyline-legacy/<courseId>/<leaf>.zip + manifest.`,
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

  // A live listing/export latches the whole panel busy (App adds import/docx).
  const exporting = phase === 'listing' || phase === 'exporting';

  return {
    phase,
    exporting,
    listLimit,
    setListLimit,
    searchTerm,
    setSearchTerm,
    courses,
    selected,
    allSelected,
    toggle,
    toggleAll,
    list,
    saveInventory,
    runExport,
    runBanks,
    runAssets,
    runStoryline,
    runAccount,
    progress,
    census,
    novelty,
    banks,
    assets,
    storyline,
  };
}

export type ExportRuns = ReturnType<typeof useExportRuns>;
