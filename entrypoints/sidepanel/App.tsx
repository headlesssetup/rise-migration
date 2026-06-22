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
} from '@/core/census/inventory';
import { FileSystemStorage } from '@/core/storage/fs';
import type { Storage } from '@/core/storage/storage';
import type { SessionState } from '@/shared/messaging';
import type { SearchResultItem } from '@/shared/types/rise';
import { AssetsView } from './components/AssetsView';
import { BanksView } from './components/BanksView';
import { CensusView } from './components/CensusView';
import { ImportView } from './components/ImportView';
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
import { rpc } from './rpc';

type DirPicker = (opts?: {
  mode?: 'read' | 'readwrite';
}) => Promise<FileSystemDirectoryHandle>;

type Phase = 'idle' | 'listing' | 'listed' | 'exporting' | 'done';
type Mode = 'export' | 'import';

const PAGE = 16;

/** Classify a log line for colorization (CSS in style.css). */
function logLineClass(line: string): string {
  if (/^\s*(FAILED|BLOCKED|✗)|\berror\b|Unauthorized|HTTP [45]\d\d/i.test(line))
    return 'log-line log-error';
  if (/^\s*(\[\d+\/\d+\]\s*)?WARN|⚠/i.test(line)) return 'log-line log-warn';
  if (/\bOK\b|✓|Imported|Planned|done\b/i.test(line)) return 'log-line log-ok';
  if (/^\s*(\[\d+\/\d+\]\s*)?DRY\b/i.test(line)) return 'log-line log-dry';
  return 'log-line';
}

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [mode, setMode] = useState<Mode>('export');
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
  const [copied, setCopied] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [census, setCensus] = useState<Census | null>(null);
  const [novelty, setNovelty] = useState<NoveltyReport | null>(null);
  const [banks, setBanks] = useState<BankCatalog | null>(null);
  const [assets, setAssets] = useState<AssetsSummary | null>(null);
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
    if (stickToBottomRef.current) {
      logRef.current?.scrollTo(0, logRef.current.scrollHeight);
    }
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
  }, [storage, selectedCourses, onEvent, addLog, session]);

  const runBanks = useCallback(async () => {
    if (!storage) return;
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
  }, [storage, onEvent, addLog]);

  const runAssets = useCallback(async () => {
    if (!storage) return;
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
  }, [storage, onEvent, addLog, session]);

  const runAccount = useCallback(async () => {
    if (!storage) return;
    setPhase('exporting');
    setProgress(null);
    addLog('Exporting account extras (block templates, typefaces, review items)…');
    const s = await fetchAccountExtras(storage, onEvent);
    setPhase('done');
    addLog(
      `Account extras: ${s.blockTemplates} block template(s), ${s.typefaces} typeface(s) + ${s.fonts.written} font file(s), ${s.reviewItems} review item(s) (${s.mightyItems} Mighty).`,
    );
  }, [storage, onEvent, addLog]);

  const busy = phase === 'listing' || phase === 'exporting';
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

  return (
    <div className="app">
      <h1>Rise Migration — {mode === 'export' ? 'Exporter' : 'Importer'}</h1>

      <div className="row" role="tablist" style={{ marginBottom: 8 }}>
        <button
          onClick={() => setMode('export')}
          disabled={busy}
          aria-pressed={mode === 'export'}
          style={mode === 'export' ? { fontWeight: 700 } : undefined}
        >
          Export (read-only)
        </button>
        <button
          onClick={() => setMode('import')}
          disabled={busy}
          aria-pressed={mode === 'import'}
          style={mode === 'import' ? { fontWeight: 700, color: '#b00' } : undefined}
        >
          Import (write)
        </button>
      </div>

      <section className="card">
        <h2>Setup</h2>
        <SessionView session={session} totalCount={totalCount} />
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

      {ready && mode === 'import' && (
        <ImportView storage={storage} session={session} addLog={addLog} />
      )}

      {ready && mode === 'export' && (
      <>
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
        <h2>Assets</h2>
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
        <h2>Account extras</h2>
        <button
          onClick={runAccount}
          disabled={busy || !storage || !session?.risePresent}
        >
          {phase === 'exporting' ? 'Working…' : 'Export account extras'}
        </button>
        <p className="hint">
          Block templates, custom typefaces (+ font files), and the Review-360
          items inventory (flags Mighty bundles). Raw → account/, reports →
          _metadata/.
        </p>
      </section>
      </>
      )}

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
        <details className="card">
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            Census — {census.courseCount} course(s) · {census.variants.length}{' '}
            variants · {census.refs.length} ref shapes
          </summary>
          <CensusView census={census} />
        </details>
      )}

      <section className="card log-card">
        <div className="log-header">
          <h2>Log</h2>
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
        </div>
        <div className="log" ref={logRef} onScroll={onLogScroll}>
          {log.map((line, i) => (
            <div key={i} className={logLineClass(line)}>
              {line}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
