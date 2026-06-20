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
  buildBankCatalog,
  type BankCatalog,
} from '@/core/census/question-banks';
import {
  buildInventory,
  inventoryToCsv,
  inventoryToJson,
} from '@/core/census/inventory';
import { FileSystemStorage } from '@/core/storage/fs';
import type { Storage } from '@/core/storage/storage';
import type { SessionState } from '@/shared/messaging';
import type { SearchResultItem } from '@/shared/types/rise';
import { AssetsView } from './components/AssetsView';
import { BanksView } from './components/BanksView';
import { CensusView } from './components/CensusView';
import { NoveltyView } from './components/NoveltyView';
import { SessionView } from './components/SessionView';
import {
  clearDirHandle,
  loadDirHandle,
  saveDirHandle,
  verifyPermission,
} from './folder-store';
import {
  buildFolders,
  countCourses,
  downloadAllAssets,
  exportCourses,
  fetchFolders,
  fetchQuestionBanks,
  listAllCourses,
  scanSavedBanks,
  scanSavedCourses,
  type AssetsSummary,
  type ProgressEvent,
} from './orchestrator';
import { rpc } from './rpc';

type DirPicker = (opts?: {
  mode?: 'read' | 'readwrite';
}) => Promise<FileSystemDirectoryHandle>;

type Phase = 'idle' | 'listing' | 'listed' | 'exporting' | 'done';

const PAGE = 16;

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [pendingHandle, setPendingHandle] =
    useState<FileSystemDirectoryHandle | null>(null);
  const [listLimit, setListLimit] = useState<number>(PAGE);
  const [phase, setPhase] = useState<Phase>('idle');
  const [courses, setCourses] = useState<SearchResultItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [census, setCensus] = useState<Census | null>(null);
  const [novelty, setNovelty] = useState<NoveltyReport | null>(null);
  const [banks, setBanks] = useState<BankCatalog | null>(null);
  const [assets, setAssets] = useState<AssetsSummary | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((message: string) => {
    setLog((l) => [...l, message]);
  }, []);

  // Poll session state (identity + token + Rise tab presence + account name).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const resp = await rpc({ type: 'GET_SESSION_STATE' });
      if (alive && resp.type === 'SESSION_STATE') setSession(resp.state);
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

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  const onEvent = useCallback(
    (e: ProgressEvent) => {
      if (e.kind === 'log') addLog(e.message);
      else if (e.kind === 'course')
        setProgress({ done: e.index + 1, total: e.total });
    },
    [addLog],
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

  const list = useCallback(async () => {
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

      // Folder structure (course folders now; bank folders after a bank fetch).
      await fetchFolders(storage, onEvent);
      const folders = await buildFolders(storage);
      if (folders.length) {
        const course = folders.filter((f) => f.source === 'course').length;
        const bank = folders.filter((f) => f.source === 'bank').length;
        addLog(
          `Folders: ${folders.length} (${course} course, ${bank} bank) → folders-inventory.csv/json.`,
        );
      }
    } else {
      addLog(
        `Inventory built (${rows.length} rows) — connect a folder to save it.`,
      );
    }
  }, [onEvent, addLog, listLimit, storage]);

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
  }, [storage, selectedCourses, onEvent, addLog]);

  const runBanks = useCallback(async () => {
    if (!storage) return;
    setPhase('exporting');
    setBanks(null);
    setProgress(null);
    const res = await fetchQuestionBanks(storage, onEvent);
    const saved = await scanSavedBanks(storage, onEvent);
    const cat = buildBankCatalog(saved);
    await storage.writeBankCatalog(bankCatalogToJson(cat), bankCatalogToCsv(cat));
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
  }, [storage, onEvent, addLog]);

  const runAssets = useCallback(async () => {
    if (!storage) return;
    setPhase('exporting');
    setAssets(null);
    setProgress(null);
    addLog('Downloading assets from articulateusercontent.com (parallel)…');
    const summary = await downloadAllAssets(storage, onEvent);
    setAssets(summary);
    setPhase('done');
    const orphan = summary.orphaned.reduce((s, o) => s + o.keys.length, 0);
    addLog(
      `Assets: ${summary.written} written, ${summary.deduped} deduped, ${summary.reused} reused, ${summary.failed} failed across ${summary.owners} owner(s)${
        summary.skipped ? ` (${summary.skipped} already done)` : ''
      }. → assets/, *.assets.json, assets-summary.json.`,
    );
    if (orphan) {
      addLog(`${orphan} asset(s) orphaned (404 — likely deleted); not blocking.`);
    }
    if (!summary.complete) {
      const n = summary.undownloaded.reduce((s, o) => s + o.keys.length, 0);
      addLog(`⚠ ${n} key(s) failed (non-404) — click Download assets again to retry.`);
    }
  }, [storage, onEvent, addLog]);

  const busy = phase === 'listing' || phase === 'exporting';
  const atAll = totalCount !== null && listLimit >= totalCount;

  return (
    <div className="app">
      <h1>Rise Explorer · Phase 0</h1>

      <section className="card">
        <h2>Session</h2>
        <SessionView session={session} totalCount={totalCount} />
      </section>

      <section className="card">
        <h2>Destination folder</h2>
        <div className="row">
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
      </section>

      <section className="card">
        <h2>Courses</h2>
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
        <button onClick={list} disabled={busy || !session?.risePresent}>
          {phase === 'listing'
            ? 'Listing…'
            : `List ${atAll ? 'all' : listLimit} course(s) (paced)`}
        </button>
        {!session?.risePresent && (
          <p className="hint">
            Open and log into a Rise tab (US rise.articulate.com or EU
            rise.eu.articulate.com) and keep it open — the panel rides that
            tab's live session.
          </p>
        )}

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
        <h2>Question banks</h2>
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
        <h2>Assets (Phase 2)</h2>
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

      {progress && (
        <section className="card">
          <h2>Progress</h2>
          <p>
            {progress.done} / {progress.total}
          </p>
        </section>
      )}

      {novelty && (
        <section className="card">
          <h2>Novelty</h2>
          <NoveltyView novelty={novelty} />
        </section>
      )}

      {census && (
        <section className="card">
          <h2>Census</h2>
          <CensusView census={census} />
        </section>
      )}

      <section className="card">
        <h2>Log</h2>
        <div className="log" ref={logRef}>
          {log.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      </section>
    </div>
  );
}
