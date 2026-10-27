// Step C · Courses — split out of ImportView.tsx (v0.9.0).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatEstimate } from '@/core/import';
import type { LocalArchiveInspection } from '@/core/local-archive';
import {
  checkImportPreconditions,
  estimateCourses,
  runImport,
  type CourseImportOutcome,
  type ImportPreflightWarning,
} from '../../orchestrator';
import { OutcomeTable } from './OutcomeTable';
import {
  CollapsibleStep,
  FilterRow,
  filterByName,
  selectAll,
  toggle,
  type ArchiveCourse,
  type SectionProps,
} from './step-shared';

export function CoursesSection({
  storage,
  target,
  override,
  liveOk,
  running,
  setRunning,
  onEvent,
  stop,
  logBreak,
  selected,
  setSelected,
  archiveInspection,
}: SectionProps & {
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  archiveInspection: LocalArchiveInspection | null;
}) {
  const [filter, setFilter] = useState('');
  const [outcomes, setOutcomes] = useState<CourseImportOutcome[]>([]);
  const [blocked, setBlocked] = useState<string | null>(null);
  // "Re-create folders" — ON: create/reuse just the selected courses' folder
  // chains on the target and place the courses there; OFF: courses land in root.
  const [recreateFolders, setRecreateFolders] = useState(false);
  const [rehostForeignTypefaces, setRehostForeignTypefaces] = useState(false);
  // "Ready to import?" — rough pre-run time estimate for the selection (local
  // archive reads + pure plans; debounced so rapid clicking doesn't churn disk).
  const [estimate, setEstimate] = useState<string | null>(null);
  // Ordering preflight (folders / step D / step B skipped?) awaiting the
  // operator's Continue anyway / Abort. Live runs only — a dry run just logs it.
  // The box carries a SNAPSHOT of what was checked (selection + folder toggle):
  // Continue anyway runs exactly that snapshot, and any change to the selection
  // or the toggle while the box is open discards it (the findings would be
  // stale for the new selection).
  const [pending, setPending] = useState<{
    warnings: ImportPreflightWarning[];
    courseIds: string[];
    recreateFolders: boolean;
  } | null>(null);
  // The preflight itself is seconds of archive reads on a big selection — both
  // buttons are disabled meanwhile so a second click cannot start a second scan.
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    setPending(null);
  }, [selected, recreateFolders]);

  useEffect(() => {
    if (!storage || selected.size === 0) {
      setEstimate(null);
      return;
    }
    let alive = true;
    setEstimate('estimating…');
    const t = setTimeout(async () => {
      try {
        const { estimate: e, stacks, missing, unreadable } = await estimateCourses(storage, [
          ...selected,
        ]);
        if (!alive) return;
        const estimable = selected.size - missing - unreadable;
        const parts = [
          `${selected.size} course(s)${stacks ? ` (${stacks} multi-language)` : ''}`,
          estimable > 0 ? `${formatEstimate(e.seconds)} (rough)` : 'estimate unavailable',
        ];
        if (missing) parts.push(`${missing} not in archive`);
        if (unreadable) parts.push(`${unreadable} unreadable/plan error`);
        setEstimate(parts.join(' · '));
      } catch {
        if (alive) setEstimate(null);
      }
    }, 500);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [storage, selected]);

  // ImportView already performs the strict archive inspection once. Re-running
  // it here doubled all checksum reads (589 courses in the current archive) and
  // left the picker showing a false "No courses" empty state while both scans
  // were still in flight. The inspection result is the single source of truth.
  const courses: ArchiveCourse[] = archiveInspection?.ready
    ? archiveInspection.courses
    : [];

  const shown = useMemo(
    () => filterByName(courses, (c) => c.title ?? c.id, filter),
    [courses, filter],
  );

  const run = useCallback(
    async (
      dryRun: boolean,
      courseIds: string[],
      recreateFoldersNow: boolean,
      acknowledged: ImportPreflightWarning[] = [],
    ) => {
      if (!storage) return;
      logBreak(`Courses — ${dryRun ? 'dry-run' : 'import'}`);
      stop.reset();
      setRunning(true);
      setBlocked(null);
      setOutcomes([]);
      for (const w of acknowledged) {
        onEvent({
          kind: 'log',
          message: `⚠ preflight${dryRun ? '' : ' (continuing anyway)'}: ${w.message}`,
        });
      }
      try {
        const res = await runImport(
          storage,
          courseIds,
          target,
          {
            dryRun,
            override,
            recreateFolders: recreateFoldersNow,
            rehostForeignTypefaces,
            shouldStop: stop.shouldStop,
          },
          onEvent,
        );
        if (res.blocked) setBlocked(res.blocked);
        setOutcomes(res.outcomes);
      } catch (e) {
        onEvent({
          kind: 'log',
          message: `FAILED — course import: ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        setRunning(false);
      }
    },
    [storage, target, override, rehostForeignTypefaces, onEvent, logBreak, setRunning, stop],
  );

  // Button entry: run the ordering preflight first. A live run with findings
  // waits for Continue anyway / Abort; a dry run proceeds and logs them.
  const start = useCallback(
    async (dryRun: boolean) => {
      if (!storage || checking) return;
      setPending(null);
      // Snapshot what is checked: the run (now or after Continue anyway) uses
      // exactly this, never whatever the selection has become meanwhile.
      const courseIds = [...selected];
      const recreateFoldersNow = recreateFolders;
      let warnings: ImportPreflightWarning[] = [];
      setChecking(true);
      try {
        warnings = await checkImportPreconditions(
          storage,
          courseIds,
          { recreateFolders: recreateFoldersNow },
          onEvent,
        );
      } catch (e) {
        onEvent({
          kind: 'log',
          message: `⚠ preflight check failed (${e instanceof Error ? e.message : String(e)}) — continuing without it`,
        });
      } finally {
        setChecking(false);
      }
      if (warnings.length && !dryRun) {
        setPending({ warnings, courseIds, recreateFolders: recreateFoldersNow });
        return;
      }
      await run(dryRun, courseIds, recreateFoldersNow, warnings);
    },
    [storage, checking, selected, recreateFolders, onEvent, run],
  );

  return (
    <CollapsibleStep title="C · Courses">
      {!archiveInspection ? (
        <p className="hint">Checking manifest and required files…</p>
      ) : !archiveInspection.ready ? (
        <p className="hint">
          Courses are unavailable until the archive errors above are resolved.
        </p>
      ) : courses.length === 0 ? (
        <p className="hint">No courses in this archive folder. Export some first.</p>
      ) : (
        <>
          <FilterRow
            value={filter}
            onChange={setFilter}
            placeholder="Filter courses by name…"
            selected={selected.size}
            shown={shown.length}
            total={courses.length}
            onSelectAll={() => setSelected((s) => selectAll(s, shown.map((c) => c.id)))}
            onClear={() => setSelected(new Set())}
          />
          <ul className="course-list">
            {shown.map((c) => (
              <li key={c.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => setSelected((s) => toggle(s, c.id))}
                  />{' '}
                  {c.title ?? c.id}
                </label>
              </li>
            ))}
          </ul>
          {estimate && (
            <p className="hint" style={{ marginBottom: 4 }}>
              Ready to import? {estimate}
            </p>
          )}
          <label title="On: recreate just the selected courses' folders on the target (existing folders with the same name are reused, never duplicated) and place the courses there. Off: courses are created in the root.">
            <input
              type="checkbox"
              checked={recreateFolders}
              onChange={(e) => setRecreateFolders(e.target.checked)}
            />{' '}
            Re-create folders (off = courses go to the root)
          </label>
          <label className="hint" style={{ display: 'block' }}>
            <input
              type="checkbox"
              checked={rehostForeignTypefaces}
              onChange={(e) => setRehostForeignTypefaces(e.target.checked)}
            />{' '}
            Re-host shared-in typefaces (fonts owned by another tenant that the export resolved per
            course — only if you may copy them; off = flagged as manual work)
          </label>
          {pending && !running && (
            <div
              style={{
                border: '2px solid #b00',
                borderRadius: 6,
                padding: 8,
                margin: '6px 0',
              }}
            >
              <b style={{ color: '#b00' }}>⚠ Before importing — a step looks skipped:</b>
              <ul style={{ margin: '4px 0 6px', paddingLeft: 18 }}>
                {pending.warnings.map((w) => (
                  <li key={w.kind} className="hint" style={{ color: '#8a5a00' }}>
                    {w.message}
                  </li>
                ))}
              </ul>
              <div className="row">
                <button onClick={() => setPending(null)}>Abort</button>
                <button
                  onClick={() => {
                    const snap = pending;
                    setPending(null);
                    void run(false, snap.courseIds, snap.recreateFolders, snap.warnings);
                  }}
                  style={{ background: '#b00', color: '#fff' }}
                >
                  Continue anyway →
                </button>
              </div>
            </div>
          )}
          <div className="row">
            <button
              onClick={() => start(true)}
              disabled={!storage || selected.size === 0 || running || checking}
            >
              {running ? 'Working…' : checking ? 'Checking…' : `Dry-run (${selected.size})`}
            </button>
            <button
              onClick={() => start(false)}
              disabled={!liveOk || selected.size === 0 || pending !== null || checking}
              style={
                liveOk && selected.size > 0 && pending === null && !checking
                  ? { background: '#b00', color: '#fff' }
                  : undefined
              }
            >
              Import courses →
            </button>
            {running && (
              <button onClick={stop.request} disabled={stop.requested}>
                {stop.requested ? 'Stopping…' : 'Stop'}
              </button>
            )}
          </div>
        </>
      )}
      {blocked && <p style={{ color: '#b00', fontWeight: 600 }}>BLOCKED: {blocked}</p>}
      {outcomes.length > 0 && <OutcomeTable outcomes={outcomes} />}
    </CollapsibleStep>
  );
}
