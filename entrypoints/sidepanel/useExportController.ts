// The export-mode controller: all read-only export state + the operation
// callbacks (list, fetch courses, banks, assets, account data), split out of
// App.tsx so that frequently-read file holds only composition/shell. This is a
// plain custom hook — it runs inside App's render, so the component tree and
// state lifetimes are identical to the inlined version (no behavior change).
import { useCallback, useEffect, useMemo, useState } from 'react';
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
} from '@/core/census/inventory';
import type { Storage } from '@/core/storage/storage';
import type { SessionState } from '@/shared/messaging';
import type { SearchResultItem } from '@/shared/types/rise';
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
  type AssetsSummary,
  type ProgressEvent,
} from './orchestrator';

export type Phase = 'idle' | 'listing' | 'listed' | 'exporting' | 'done';

export const PAGE = 16;

/** Owns every export-side concern: the listing/selection, the census/novelty/
 *  bank/asset reports, and the paced export operations. Returns the state + the
 *  handlers App's export UI binds to. */
export function useExportController(
  storage: Storage | null,
  session: SessionState | null,
  addLog: (message: string) => void,
  logBreak: (label?: string) => void,
) {
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [listLimit, setListLimit] = useState<number>(PAGE);
  const [phase, setPhase] = useState<Phase>('idle');
  const [courses, setCourses] = useState<SearchResultItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [census, setCensus] = useState<Census | null>(null);
  const [novelty, setNovelty] = useState<NoveltyReport | null>(null);
  const [banks, setBanks] = useState<BankCatalog | null>(null);
  const [assets, setAssets] = useState<AssetsSummary | null>(null);

  const onEvent = useCallback(
    (e: ProgressEvent) => {
      if (e.kind === 'log') addLog(e.message);
      else if (e.kind === 'course')
        setProgress({ done: e.index + 1, total: e.total });
    },
    [addLog],
  );

  // The account on the tab drives the count — refresh it when it changes.
  const accountName = session?.accountName ?? null;
  useEffect(() => {
    setTotalCount(null);
  }, [accountName]);

  // Auto-fetch the total course count once a Rise tab is present.
  const risePresent = session?.risePresent ?? false;
  useEffect(() => {
    let alive = true;
    if (!risePresent || totalCount !== null) return;
    void (async () => {
      const n = await countCourses();
      if (alive && n !== null) setTotalCount(n);
    })();
    return () => {
      alive = false;
    };
  }, [risePresent, totalCount]);

  const list = useCallback(async () => {
    logBreak('List courses');
    setPhase('listing');
    setCourses([]);
    const result = await listAllCourses(onEvent, listLimit);
    setCourses(result);
    setSelected(new Set(result.map((c) => c.id)));
    setPhase('listed');
    addLog(`Found ${result.length} courses.`);

    // List-level inventory: a customer-ready catalog, no GET_COURSE needed.
    const rows = buildInventory(result);
    if (storage) {
      await storage.writeInventory(inventoryToJson(rows), inventoryToCsv(rows));
      addLog(`Inventory written (${rows.length} rows) → inventory.csv/json.`);
      // (Folder tree is exported under Account Data, not here.)
    } else {
      addLog(
        `Inventory built (${rows.length} rows) — connect a folder to save it.`,
      );
    }
  }, [onEvent, addLog, logBreak, listLimit, storage]);

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

  const runExport = useCallback(async () => {
    if (!storage) return;
    logBreak('Fetch courses');
    setPhase('exporting');
    setCensus(null);
    setNovelty(null);
    setProgress({ done: 0, total: selectedCourses.length });

    const { saved, skipped, failed } = await exportCourses(
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

    await storage.writeManifest({
      generatedAt: new Date().toISOString(),
      // Source account identity — the import side's Source ≠ Target guard reads
      // this to refuse writing back into the account the archive came from.
      sourceAccount: {
        name: session?.accountName ?? session?.identity?.name ?? null,
        sub: session?.identity?.sub ?? null,
        email: session?.identity?.email ?? null,
        plane: session?.plane ?? null,
      },
      courseCount: scans.length,
      saved,
      skipped,
      failed,
      variantCount: nov.variantCount,
      newVariants: nov.newVariants.map((v) => v.key),
      newFields: nov.newFields.length,
      courses: selectedCourses.map((c) => ({ id: c.id, title: c.title })),
    });
    setCensus(built);
    setNovelty(nov);
    setPhase('done');
    addLog(
      `Done — saved ${saved}, skipped ${skipped}, failed ${failed.length}. Census + catalog + novelty written.`,
    );
    addLog(
      `Catalog: ${nov.variantCount} variant(s). Novelty: ${nov.newVariants.length} new variant(s), ${nov.newFields.length} new field(s).`,
    );
  }, [storage, selectedCourses, onEvent, addLog, logBreak, session]);

  const runBanks = useCallback(async () => {
    if (!storage) return;
    logBreak('Fetch question banks');
    setPhase('exporting');
    setBanks(null);
    setProgress(null);
    const res = await fetchQuestionBanks(storage, onEvent);
    const saved = await scanSavedBanks(storage, onEvent);
    const cat = buildBankCatalog(saved);
    await storage.writeBankCatalog(bankCatalogToJson(cat), bankCatalogToCsv(cat));

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
  }, [storage, onEvent, addLog, logBreak]);

  const runAssets = useCallback(async () => {
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
      const recorded = m ? (JSON.parse(m).sourceAccount?.plane as typeof plane) : null;
      if (recorded === 'us' || recorded === 'eu') plane = recorded;
    } catch {
      /* fall back to the live session plane / both */
    }
    const bases = cdnBasesForPlane(plane);
    addLog(`Downloading assets from ${bases.join(' / ')} (parallel)…`);
    const summary = await downloadAllAssets(storage, onEvent, makeCdnDownloader(bases));
    setAssets(summary);
    setPhase('done');
    const orphan = summary.orphaned.reduce((s, o) => s + o.keys.length, 0);
    addLog(
      `Assets: ${summary.written} written, ${summary.deduped} deduped, ${summary.reused} reused, ${summary.failed} failed across ${summary.owners} owner(s)${
        summary.skipped ? ` (${summary.skipped} already done)` : ''
      }. → assets/, *.assets.json, assets-summary.json.`,
    );
    if (orphan) {
      addLog(
        `${orphan} asset(s) missing at source (403/404 — likely deleted); flagged in assets-summary.json, not blocking.`,
      );
    }
    if (!summary.complete) {
      const n = summary.undownloaded.reduce((s, o) => s + o.keys.length, 0);
      addLog(`⚠ ${n} key(s) failed (non-403/404) — click Download assets again to retry.`);
    }
  }, [storage, onEvent, addLog, logBreak, session]);

  const runAccount = useCallback(async () => {
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
      addLog(`Folders: ${folders.length} (${course} course, ${bank} bank) → folders-inventory.csv/json.`);
    }

    const s = await fetchAccountExtras(storage, onEvent);
    setPhase('done');
    addLog(
      `Account data: ${folders.length} folder(s), ${s.blockTemplates} block template(s), ${s.typefaces} typeface(s) + ${s.fonts.written} font file(s).`,
    );
  }, [storage, onEvent, addLog, logBreak]);

  const busy = phase === 'listing' || phase === 'exporting';
  const atAll = totalCount !== null && listLimit >= totalCount;

  return {
    phase,
    busy,
    totalCount,
    listLimit,
    setListLimit,
    atAll,
    courses,
    selected,
    allSelected,
    toggle,
    toggleAll,
    progress,
    census,
    novelty,
    banks,
    assets,
    list,
    runExport,
    runBanks,
    runAssets,
    runAccount,
  };
}
