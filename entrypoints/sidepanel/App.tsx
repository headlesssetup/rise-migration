import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildCensus, type Census } from '@/core/census/aggregate';
import { censusToCsv, censusToJson } from '@/core/census/export';
import {
  buildInventory,
  inventoryToCsv,
  inventoryToJson,
} from '@/core/census/inventory';
import { FileSystemStorage } from '@/core/storage/fs';
import type { Storage } from '@/core/storage/storage';
import type { SessionState } from '@/shared/messaging';
import type { SearchResultItem } from '@/shared/types/rise';
import {
  clearDirHandle,
  loadDirHandle,
  saveDirHandle,
  verifyPermission,
} from './folder-store';
import {
  countCourses,
  exportCourses,
  listAllCourses,
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
    setProgress({ done: 0, total: selectedCourses.length });

    const { scans, saved, skipped, failed } = await exportCourses(
      selectedCourses,
      storage,
      onEvent,
    );

    const built = buildCensus(scans);
    await storage.writeCensus(censusToJson(built), censusToCsv(built));
    await storage.writeManifest({
      generatedAt: new Date().toISOString(),
      courseCount: scans.length,
      saved,
      skipped,
      failed,
      courses: selectedCourses.map((c) => ({ id: c.id, title: c.title })),
    });
    setCensus(built);
    setPhase('done');
    addLog(
      `Done — saved ${saved}, skipped ${skipped}, failed ${failed.length}. Census written.`,
    );
  }, [storage, selectedCourses, onEvent, addLog]);

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

      {progress && (
        <section className="card">
          <h2>Progress</h2>
          <p>
            {progress.done} / {progress.total}
          </p>
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

function SessionView({
  session,
  totalCount,
}: {
  session: SessionState | null;
  totalCount: number | null;
}) {
  if (!session) return <p className="hint">Connecting…</p>;
  const id = session.identity;
  const who = session.accountName ?? id?.email ?? id?.name;
  return (
    <ul className="kv">
      <li>
        Rise tab: <b>{session.risePresent ? 'detected' : 'not detected'}</b>
      </li>
      <li>
        Token: <b>{session.hasToken ? 'captured' : 'none yet'}</b>
      </li>
      <li>
        Logged in as: <b>{who ?? id?.sub ?? '—'}</b>
        {!who && id?.sub && <span className="hint"> (user id)</span>}
      </li>
      <li>
        Courses: <b>{totalCount ?? '—'}</b>
      </li>
    </ul>
  );
}

function CensusView({ census }: { census: Census }) {
  return (
    <div className="census">
      <p>
        {census.courseCount} course(s) · {census.variants.length} distinct
        family/variant · {census.refs.length} ref shape(s)
      </p>
      <h3>family / variant</h3>
      <table>
        <thead>
          <tr>
            <th>key</th>
            <th>count</th>
            <th>courses</th>
          </tr>
        </thead>
        <tbody>
          {census.variants.map((v) => (
            <tr key={v.key}>
              <td>{v.key}</td>
              <td>{v.count}</td>
              <td>{v.courseCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>reference shapes</h3>
      <table>
        <thead>
          <tr>
            <th>kind</th>
            <th>count</th>
            <th>courses</th>
          </tr>
        </thead>
        <tbody>
          {census.refs.map((r) => (
            <tr key={r.kind}>
              <td>{r.kind}</td>
              <td>{r.count}</td>
              <td>{r.courseCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {census.versions.length > 0 && (
        <p className="hint">
          versions: {census.versions.map((v) => v.signal).join(', ')}
        </p>
      )}
    </div>
  );
}
