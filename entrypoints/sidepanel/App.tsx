import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildCensus, type Census } from '@/core/census/aggregate';
import { censusToCsv, censusToJson } from '@/core/census/export';
import { FileSystemStorage } from '@/core/storage/fs';
import type { Storage } from '@/core/storage/storage';
import type { SessionState } from '@/shared/messaging';
import type { SearchResultItem } from '@/shared/types/rise';
import { exportCourses, listAllCourses, type ProgressEvent } from './orchestrator';
import { rpc } from './rpc';

type DirPicker = (opts?: {
  mode?: 'read' | 'readwrite';
}) => Promise<FileSystemDirectoryHandle>;

type Phase = 'idle' | 'listing' | 'listed' | 'exporting' | 'done';

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
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

  // Poll session state (identity + token + Rise tab presence).
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

  const pickFolder = useCallback(async () => {
    const picker = (window as unknown as { showDirectoryPicker?: DirPicker })
      .showDirectoryPicker;
    if (!picker) {
      addLog('File System Access API unavailable in this browser.');
      return;
    }
    try {
      const handle = await picker({ mode: 'readwrite' });
      setStorage(new FileSystemStorage(handle));
      setFolderName(handle.name);
      addLog(`Folder selected: ${handle.name}`);
    } catch {
      /* user cancelled */
    }
  }, [addLog]);

  const list = useCallback(async () => {
    setPhase('listing');
    setCourses([]);
    const result = await listAllCourses(onEvent);
    setCourses(result);
    setSelected(new Set(result.map((c) => c.id)));
    setPhase('listed');
    addLog(`Found ${result.length} courses.`);
  }, [onEvent, addLog]);

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

  return (
    <div className="app">
      <h1>Rise Explorer · Phase 0</h1>

      <section className="card">
        <h2>Session</h2>
        <SessionView session={session} />
      </section>

      <section className="card">
        <h2>Destination folder</h2>
        <button onClick={pickFolder} disabled={busy}>
          {folderName ? `Folder: ${folderName}` : 'Pick folder…'}
        </button>
      </section>

      <section className="card">
        <h2>Courses</h2>
        <button onClick={list} disabled={busy || !session?.hasToken}>
          {phase === 'listing' ? 'Listing…' : 'List courses (paced)'}
        </button>
        {!session?.hasToken && (
          <p className="hint">
            Waiting for a Rise token — open and interact with a logged-in
            rise.articulate.com tab.
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
                disabled={busy || !storage || selected.size === 0}
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

function SessionView({ session }: { session: SessionState | null }) {
  if (!session) return <p className="hint">Connecting…</p>;
  const who =
    session.identity?.email ?? session.identity?.name ?? session.identity?.sub;
  return (
    <ul className="kv">
      <li>
        Rise tab: <b>{session.risePresent ? 'detected' : 'not detected'}</b>
      </li>
      <li>
        Token: <b>{session.hasToken ? 'captured' : 'none yet'}</b>
      </li>
      <li>
        Logged in as: <b>{who ?? '—'}</b>
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
