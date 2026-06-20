// Phase 3 — Import (write mode) panel. Deliberate, gated entry into writing:
// a write-mode banner, a target-account confirmation gate (shows the live tab's
// identity + plane), a Source ≠ Target guard (read from the archive manifest),
// a dry-run plan preview, and only then a live import. The archive stays
// read-only; outputs land under _import/.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  checkSourceNotTarget,
  describeTarget,
  type AccountIdentity,
} from '@/core/import';
import type { Storage } from '@/core/storage/storage';
import type { SessionState } from '@/shared/messaging';
import {
  readSourceIdentity,
  runImport,
  type CourseImportOutcome,
  type ProgressEvent,
} from '../orchestrator';

interface ArchiveCourse {
  id: string;
  title?: string;
}

export function ImportView({
  storage,
  session,
  addLog,
}: {
  storage: Storage | null;
  session: SessionState | null;
  addLog: (m: string) => void;
}) {
  const [courses, setCourses] = useState<ArchiveCourse[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [source, setSource] = useState<AccountIdentity | undefined>(undefined);
  const [confirmTarget, setConfirmTarget] = useState(false);
  const [override, setOverride] = useState(false);
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<CourseImportOutcome[]>([]);
  const [blocked, setBlocked] = useState<string | null>(null);

  const target: AccountIdentity | undefined = useMemo(
    () =>
      session
        ? {
            name: session.accountName ?? session.identity?.name ?? null,
            sub: session.identity?.sub ?? null,
            email: session.identity?.email ?? null,
            plane: session.plane ?? null,
          }
        : undefined,
    [session],
  );

  const verdict = useMemo(
    () => checkSourceNotTarget(source, target, override),
    [source, target, override],
  );
  const sameAccount = !verdict.ok && 'sameAccount' in verdict && verdict.sameAccount;

  // Load the archive's saved courses + the recorded source identity.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!storage) {
        setCourses([]);
        return;
      }
      setSource(await readSourceIdentity(storage));
      const raw = await storage.readManifest();
      let list: ArchiveCourse[] = [];
      if (raw) {
        try {
          const m = JSON.parse(raw) as { courses?: ArchiveCourse[] };
          if (Array.isArray(m.courses)) list = m.courses;
        } catch {
          /* fall through to listSaved */
        }
      }
      if (list.length === 0) {
        const ids = await storage.listSaved();
        list = ids.map((id) => ({ id }));
      }
      if (alive) setCourses(list);
    })();
    return () => {
      alive = false;
    };
  }, [storage]);

  const onEvent = useCallback(
    (e: ProgressEvent) => {
      if (e.kind === 'log') addLog(e.message);
      else if (e.kind === 'course')
        addLog(`[${e.index + 1}/${e.total}] ${e.courseId}`);
    },
    [addLog],
  );

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const run = useCallback(
    async (dryRun: boolean) => {
      if (!storage) return;
      setRunning(true);
      setBlocked(null);
      setOutcomes([]);
      try {
        const res = await runImport(
          storage,
          [...selected],
          target,
          { dryRun, override },
          onEvent,
        );
        if (res.blocked) setBlocked(res.blocked);
        setOutcomes(res.outcomes);
      } finally {
        setRunning(false);
      }
    },
    [storage, selected, target, override, onEvent],
  );

  const canLive =
    !!storage &&
    !!session?.risePresent &&
    selected.size > 0 &&
    confirmTarget &&
    verdict.ok &&
    !running;

  return (
    <section className="card" style={{ borderColor: '#b00', borderWidth: 2 }}>
      <h2 style={{ color: '#b00' }}>⚠ Import (write mode)</h2>
      <p className="hint">
        This mode <b>writes into a live Rise account</b>. It rebuilds courses from
        the archive into the account on your current Rise tab. Dry-run first.
      </p>

      {/* Target-account confirmation gate */}
      <div className="row">
        <span>
          Target: <b>{describeTarget(target)}</b>
        </span>
      </div>
      {!session?.risePresent && (
        <p className="hint">Open + log into the TARGET Rise tab; the panel writes into it.</p>
      )}

      {/* Source ≠ Target guard */}
      <p
        className="hint"
        style={sameAccount ? { color: '#b00', fontWeight: 600 } : undefined}
      >
        {source
          ? `Source: ${source.name ?? source.sub ?? 'unknown'}${source.plane ? ` (${source.plane.toUpperCase()})` : ''} — ${verdict.reason}`
          : 'Source identity not recorded in this archive — verify the target manually.'}
      </p>
      {sameAccount && (
        <label style={{ color: '#b00' }}>
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
          />{' '}
          Override: I really mean to write into the same account
        </label>
      )}

      {/* Course selection (from the archive) */}
      {courses.length === 0 ? (
        <p className="hint">No courses in this archive folder. Export some first.</p>
      ) : (
        <>
          <p className="hint">{selected.size} selected of {courses.length} archived</p>
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

      <div className="row">
        <button onClick={() => run(true)} disabled={!storage || selected.size === 0 || running}>
          {running ? 'Working…' : `Dry-run plan (${selected.size})`}
        </button>
        <label>
          <input
            type="checkbox"
            checked={confirmTarget}
            onChange={(e) => setConfirmTarget(e.target.checked)}
          />{' '}
          I confirm writing into <b>{target?.name ?? 'this account'}</b>
        </label>
        <button onClick={() => run(false)} disabled={!canLive} style={{ background: canLive ? '#b00' : undefined, color: canLive ? '#fff' : undefined }}>
          Import live →
        </button>
      </div>

      {blocked && (
        <p style={{ color: '#b00', fontWeight: 600 }}>BLOCKED: {blocked}</p>
      )}

      {outcomes.length > 0 && <OutcomeTable outcomes={outcomes} />}
    </section>
  );
}

function OutcomeTable({ outcomes }: { outcomes: CourseImportOutcome[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>course</th>
          <th>status</th>
          <th>lessons</th>
          <th>blocks</th>
          <th>uploads</th>
          <th>flags</th>
          <th>survivingKeys</th>
        </tr>
      </thead>
      <tbody>
        {outcomes.map((o) => (
          <tr key={o.courseId}>
            <td>{o.title ?? o.courseId}</td>
            <td style={{ color: o.report.ok ? undefined : '#b00', fontWeight: 600 }}>
              {o.report.dryRun ? 'planned' : o.report.ok ? 'imported' : 'FAILED'}
            </td>
            <td>{o.report.planned.lessons}</td>
            <td>{o.report.planned.blocks}</td>
            <td>{o.report.planned.uploads}</td>
            <td>{o.report.flags.length}</td>
            <td style={{ color: o.report.survivingSourceKeys.length ? '#b00' : undefined }}>
              {o.report.survivingSourceKeys.length}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
