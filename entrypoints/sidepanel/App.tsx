import { useCallback, useEffect, useRef, useState } from 'react';
import { FileSystemStorage } from '@/core/storage/fs';
import type { Storage } from '@/core/storage/storage';
import type { SessionState } from '@/shared/messaging';
import { AssetsView } from './components/AssetsView';
import { BanksView } from './components/BanksView';
import { CensusView } from './components/CensusView';
import { ImportView } from './components/ImportView';
import { LogView } from './components/LogView';
import { NoveltyView } from './components/NoveltyView';
import { SessionView } from './components/SessionView';
import {
  clearDirHandle,
  loadDirHandle,
  saveDirHandle,
  verifyPermission,
} from './folder-store';
import type { ProgressEvent } from './orchestrator';
import { rpc } from './rpc';
import { PAGE, useExportController } from './useExportController';

type DirPicker = (opts?: {
  mode?: 'read' | 'readwrite';
}) => Promise<FileSystemDirectoryHandle>;

type Mode = 'export' | 'import';

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [mode, setMode] = useState<Mode>('export');
  const [storage, setStorage] = useState<Storage | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [pendingHandle, setPendingHandle] =
    useState<FileSystemDirectoryHandle | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  // Live import status for the log-header countdown (set via ImportView).
  const [importStatus, setImportStatus] = useState<
    { label: string; finishAt: number | null } | null
  >(null);
  const [, forceTick] = useState(0);
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

  // Visually separate each new user-launched operation in the log: drop a blank
  // line before it (never as the very first line), then an optional bold ▶ header.
  const logBreak = useCallback((label?: string) => {
    setLog((l) => {
      const next = l.length === 0 ? [...l] : [...l, ''];
      if (label) next.push(`▶ ${label}`);
      return next;
    });
  }, []);

  const clearLog = useCallback(() => setLog([]), []);

  const onImportStatus = useCallback(
    (e: Extract<ProgressEvent, { kind: 'import-status' }>) => {
      setImportStatus(
        e.done
          ? { label: e.label, finishAt: null }
          : {
              label: e.label,
              finishAt: e.etaSeconds != null ? Date.now() + e.etaSeconds * 1000 : null,
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

  useEffect(() => {
    if (stickToBottomRef.current) {
      logRef.current?.scrollTo(0, logRef.current.scrollHeight);
    }
  }, [log]);

  // Export-side state + paced operations (listing, courses, banks, assets,
  // account data + the census/novelty/bank/asset reports). Lives in a hook so
  // this file stays focused on the shell; the component tree is unchanged.
  const ex = useExportController(storage, session, addLog, logBreak);

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

  const busy = ex.busy;

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
        <SessionView session={session} totalCount={ex.totalCount} />
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
        <ImportView
          storage={storage}
          session={session}
          addLog={addLog}
          logBreak={logBreak}
          onStatus={onImportStatus}
        />
      )}

      {ready && mode === 'export' && (
      <>
      {/* A · Account Data */}
      <section className="card">
        <h2>A · Account Data</h2>
        <button
          onClick={ex.runAccount}
          disabled={busy || !storage || !session?.risePresent}
        >
          {ex.phase === 'exporting' ? 'Working…' : 'Export account data'}
        </button>
        <p className="hint">
          Block templates and custom typefaces (+ font files). Raw → account/,
          reports → _metadata/.
        </p>
      </section>

      {/* B · Question banks */}
      <section className="card">
        <h2>B · Question banks</h2>
        <button
          onClick={ex.runBanks}
          disabled={busy || !storage || !session?.risePresent}
        >
          {ex.phase === 'exporting' ? 'Working…' : 'Fetch question banks (paced)'}
        </button>
        <p className="hint">
          Reusable banks referenced by draw-from-bank blocks — saved to
          question-banks/, profiled in question-banks-catalog.csv/json.
        </p>
        {ex.banks && <BanksView banks={ex.banks} />}
      </section>

      {/* C · Courses */}
      <section className="card">
        <h2>C · Courses</h2>
        <div className="row">
          <label>
            List{' '}
            <input
              type="number"
              min={PAGE}
              step={PAGE}
              value={ex.listLimit}
              disabled={busy}
              onChange={(e) =>
                ex.setListLimit(Math.max(PAGE, Number(e.target.value) || PAGE))
              }
              style={{ width: 72 }}
            />{' '}
            courses
          </label>
          <button
            onClick={() => ex.totalCount !== null && ex.setListLimit(ex.totalCount)}
            disabled={busy || ex.totalCount === null || ex.atAll}
          >
            All{ex.totalCount !== null ? ` (${ex.totalCount})` : ''}
          </button>
        </div>
        <button onClick={ex.list} disabled={busy}>
          {ex.phase === 'listing'
            ? 'Listing…'
            : `List ${ex.atAll ? 'all' : ex.listLimit} course(s) (paced)`}
        </button>

        {ex.courses.length > 0 && (
          <>
            <div className="row">
              <label>
                <input
                  type="checkbox"
                  checked={ex.allSelected}
                  onChange={ex.toggleAll}
                />{' '}
                Select all ({ex.selected.size}/{ex.courses.length})
              </label>
              <button
                onClick={ex.runExport}
                disabled={
                  busy ||
                  !storage ||
                  ex.selected.size === 0 ||
                  !session?.risePresent
                }
              >
                {ex.phase === 'exporting'
                  ? 'Fetching…'
                  : `Fetch ${ex.selected.size} course(s) →`}
              </button>
            </div>
            <ul className="course-list">
              {ex.courses.map((c) => (
                <li key={c.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={ex.selected.has(c.id)}
                      onChange={() => ex.toggle(c.id)}
                    />{' '}
                    {c.title ?? c.id}
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* C2 · Assets */}
      <section className="card">
        <h2>C2 · Assets</h2>
        <button onClick={ex.runAssets} disabled={busy || !storage}>
          {ex.phase === 'exporting' ? 'Working…' : 'Download assets'}
        </button>
        <p className="hint">
          Downloads uploaded media (image/video/audio) for every saved course +
          bank from the public CDN (parallel — no pacing). Stored content-addressed
          in assets/ with per-owner *.assets.json. Storyline bundles, cdn.articulate.com,
          and YouTube/Vimeo embeds are kept as references. No Rise tab required.
        </p>
        {ex.assets && <AssetsView summary={ex.assets} />}
      </section>
      </>
      )}

      {ex.progress && (
        <section className="card">
          <h2>Progress</h2>
          <p>
            {ex.progress.done} / {ex.progress.total}
          </p>
        </section>
      )}

      {ex.novelty && (
        <section className="card">
          <h2>Novelty</h2>
          <NoveltyView novelty={ex.novelty} />
        </section>
      )}

      {ex.census && (
        <details className="card">
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            Census — {ex.census.courseCount} course(s) · {ex.census.variants.length}{' '}
            variants · {ex.census.refs.length} ref shapes
          </summary>
          <CensusView census={ex.census} />
        </details>
      )}

      <LogView
        log={log}
        importStatus={importStatus}
        copied={copied}
        onCopy={copyLog}
        onClear={clearLog}
        logRef={logRef}
        onScroll={onLogScroll}
      />
    </div>
  );
}
