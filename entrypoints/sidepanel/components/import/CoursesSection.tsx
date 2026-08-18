// Step C · Courses — split out of ImportView.tsx (v0.9.0).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatEstimate } from '@/core/import';
import type { LocalArchiveInspection } from '@/core/local-archive';
import {
  estimateCourses,
  runImport,
  type CourseImportOutcome,
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
  // "Ready to import?" — rough pre-run time estimate for the selection (local
  // archive reads + pure plans; debounced so rapid clicking doesn't churn disk).
  const [estimate, setEstimate] = useState<string | null>(null);

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
        const parts = [
          `${selected.size} course(s)${stacks ? ` (${stacks} multi-language)` : ''}`,
          `${formatEstimate(e.seconds)} (rough)`,
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
    async (dryRun: boolean) => {
      if (!storage) return;
      logBreak(`Courses — ${dryRun ? 'dry-run' : 'import'}`);
      stop.reset();
      setRunning(true);
      setBlocked(null);
      setOutcomes([]);
      try {
        const res = await runImport(
          storage,
          [...selected],
          target,
          { dryRun, override, shouldStop: stop.shouldStop },
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
    [storage, target, override, selected, onEvent, logBreak, setRunning, stop],
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
          <div className="row">
            <button onClick={() => run(true)} disabled={!storage || selected.size === 0 || running}>
              {running ? 'Working…' : `Dry-run (${selected.size})`}
            </button>
            <button
              onClick={() => run(false)}
              disabled={!liveOk || selected.size === 0}
              style={liveOk && selected.size > 0 ? { background: '#b00', color: '#fff' } : undefined}
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

