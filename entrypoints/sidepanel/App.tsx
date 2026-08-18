// Side-panel shell: view routing + composition. All run state lives HERE (or
// in hooks called from here) — never in a view component that unmounts on
// navigation. The panel's lifetime is the job's lifetime (CLAUDE.md).
import { useCallback, useEffect, useState } from 'react';
import { ArchiveView } from './components/ArchiveView';
import { ExportDocxPanel } from './components/ExportDocxPanel';
import { FolderControls } from './components/FolderControls';
import { ImportView } from './components/ImportView';
import { LogCard, type RunStatus } from './components/LogCard';
import { SessionView } from './components/SessionView';
import { TaskHome, type View } from './components/TaskHome';
import type { ProgressEvent } from './orchestrator';
import { useArchiveFolder } from './use-archive-folder';
import { useExportRuns } from './use-export-runs';
import { useLog } from './use-log';
import { useSession } from './use-session';

export function App() {
  const [view, setView] = useState<View>('home');
  // A live import run. Owned HERE, not inside ImportView: a mode-tab click must
  // not be able to unmount a running import into a detached closure (no Stop
  // button, no outcome table) while every export button goes clickable and can
  // interleave a second paced job through the same Rise tab.
  const [importRunning, setImportRunning] = useState(false);
  // Live import status for the log-header countdown (set via ImportView).
  const [importStatus, setImportStatus] = useState<RunStatus | null>(null);
  const [, forceTick] = useState(0);

  const {
    log,
    copied,
    logRef,
    onLogScroll,
    copyLog,
    addLog,
    logBreak,
    clearLog,
  } = useLog();
  const { session, sessionError, totalCount, refreshCount } = useSession();
  const {
    storage,
    folderName,
    pendingHandle,
    pickFolder,
    reconnectFolder,
    forgetFolder,
  } = useArchiveFolder(addLog);

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

  const runs = useExportRuns({
    storage,
    session,
    addLog,
    logBreak,
    onRunStatus: onImportStatus,
  });

  // `busy` gates EVERY mode tab + export action. A live import counts: leaving
  // it out let one click detach the run and start a second paced job alongside it.
  const busy = runs.exporting || importRunning;

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
    docx: 'Rise to Docx',
    export: 'Export Data',
    import: 'Import Data',
  };

  return (
    <div className="app">
      {view === 'home' ? (
        <>
          <h1>Rise tools</h1>
          {sessionError && (
            <p className="hint" style={{ color: '#c00' }}>⚠ {sessionError}</p>
          )}
          <section className="card">
            <p className="hint">
              Archive folder: <b>{folderName ?? 'not connected'}</b>
            </p>
            <FolderControls
              folderName={folderName}
              pendingName={pendingHandle?.name ?? null}
              connected={!!storage}
              busy={busy}
              onPick={() => void pickFolder()}
              onReconnect={() => void reconnectFolder()}
              onForget={() => void forgetFolder()}
            />
          </section>
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
              An import is running — go back to <b>Import Data</b> to
              monitor or stop it.
            </p>
          )}
        </>
      )}

      {/* Setup card — shown in export/import views */}
      {(view === 'export' || view === 'import') && (
        <section className="card">
          <h2>Setup</h2>
          <SessionView
            session={session}
            sessionError={sessionError}
            totalCount={totalCount}
            onRefreshCount={refreshCount}
            refreshDisabled={busy}
          />
          <FolderControls
            folderName={folderName}
            pendingName={pendingHandle?.name ?? null}
            connected={!!storage}
            busy={busy}
            onPick={() => void pickFolder()}
            onReconnect={() => void reconnectFolder()}
            onForget={() => void forgetFolder()}
          />
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

      {/* Export Data view — steps A through D + reports */}
      {view === 'export' && ready && (
        <ArchiveView
          session={session}
          hasStorage={!!storage}
          busy={busy}
          totalCount={totalCount}
          runs={runs}
        />
      )}

      {/* Rise to Docx view */}
      {view === 'docx' && storage && (
        <ExportDocxPanel storage={storage} addLog={addLog} />
      )}

      {/* Log — always visible */}
      <LogCard
        log={log}
        copied={copied}
        copyLog={() => void copyLog()}
        clearLog={clearLog}
        status={importStatus}
        logRef={logRef}
        onLogScroll={onLogScroll}
      />
    </div>
  );
}
