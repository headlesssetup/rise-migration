// Phase 3 — Import (write mode) panel. Deliberate, gated entry into writing:
// a write-mode banner, a target-account confirmation gate (shows the live tab's
// identity + plane), a Source ≠ Target guard (read from the archive manifest),
// then THREE ordered operations — each with its own dry-run + live run:
//   A) account settings (folders + custom fonts)
//   B) question banks (selectable, filterable)
//   C) courses (selectable, filterable)
// The archive stays read-only; outputs land under _import/.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  checkSourceNotTarget,
  describeTarget,
  summarizeFlags,
  type AccountIdentity,
} from '@/core/import';
import type { Storage } from '@/core/storage/storage';
import type { SessionState } from '@/shared/messaging';
import {
  importAccountSettings,
  importBanks,
  listLocalBanks,
  readArchiveInfo,
  readSourceIdentity,
  runImport,
  type AccountSettingsSummary,
  type ArchiveInfo,
  type BankImportOutcome,
  type CourseImportOutcome,
  type LocalBank,
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
  onStatus,
}: {
  storage: Storage | null;
  session: SessionState | null;
  addLog: (m: string) => void;
  /** Live import status for the log-header countdown. */
  onStatus?: (e: Extract<ProgressEvent, { kind: 'import-status' }>) => void;
}) {
  const [source, setSource] = useState<AccountIdentity | undefined>(undefined);
  const [confirmTarget, setConfirmTarget] = useState(false);
  const [override, setOverride] = useState(false);
  const [running, setRunning] = useState(false);

  const target: AccountIdentity | undefined = useMemo(
    () =>
      session
        ? {
            name: session.accountName ?? session.identity?.name ?? null,
            sub: session.identity?.sub ?? null,
            userId: session.userId ?? null,
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

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!storage) return;
      const s = await readSourceIdentity(storage);
      if (alive) setSource(s);
    })();
    return () => {
      alive = false;
    };
  }, [storage]);

  const onEvent = useCallback(
    (e: ProgressEvent) => {
      if (e.kind === 'log') addLog(e.message);
      else if (e.kind === 'course') addLog(`[${e.index + 1}/${e.total}] ${e.courseId}`);
      else if (e.kind === 'import-status') onStatus?.(e);
    },
    [addLog, onStatus],
  );

  // Live runs need an explicit target confirmation + the guard + a Rise tab.
  const liveOk = !!storage && !!session?.risePresent && confirmTarget && verdict.ok && !running;

  return (
    <section className="card" style={{ borderColor: '#b00', borderWidth: 2 }}>
      <h2 style={{ color: '#b00' }}>⚠ Import (write mode)</h2>
      <p className="hint">
        This mode <b>writes into a live Rise account</b>. Run the three steps in
        order: account settings → question banks → courses. Dry-run each first.
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

      <label>
        <input
          type="checkbox"
          checked={confirmTarget}
          onChange={(e) => setConfirmTarget(e.target.checked)}
        />{' '}
        I confirm writing into <b>{target?.name ?? 'this account'}</b>
      </label>

      <AccountSettingsSection
        storage={storage}
        target={target}
        override={override}
        liveOk={liveOk}
        running={running}
        setRunning={setRunning}
        onEvent={onEvent}
      />
      <BanksSection
        storage={storage}
        target={target}
        override={override}
        liveOk={liveOk}
        running={running}
        setRunning={setRunning}
        onEvent={onEvent}
      />
      <CoursesSection
        storage={storage}
        target={target}
        override={override}
        liveOk={liveOk}
        running={running}
        setRunning={setRunning}
        onEvent={onEvent}
      />
    </section>
  );
}

interface SectionProps {
  storage: Storage | null;
  target: AccountIdentity | undefined;
  override: boolean;
  liveOk: boolean;
  running: boolean;
  setRunning: (b: boolean) => void;
  onEvent: (e: ProgressEvent) => void;
}

const STEP_STYLE: React.CSSProperties = {
  border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
  borderRadius: 8,
  padding: 10,
  marginTop: 10,
};

/** A step card whose body collapses when its heading is clicked. */
function CollapsibleStep({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={STEP_STYLE}>
      <h3
        onClick={() => setOpen((o) => !o)}
        role="button"
        aria-expanded={open}
        style={{
          marginTop: 0,
          marginBottom: open ? undefined : 0,
          cursor: 'pointer',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span style={{ fontSize: '0.7em', opacity: 0.7, width: '0.9em', display: 'inline-block' }}>
          {open ? '▾' : '▸'}
        </span>
        {title}
      </h3>
      {open && children}
    </div>
  );
}

// --- A) Account settings ------------------------------------------------------

function AccountSettingsSection({
  storage,
  target,
  override,
  liveOk,
  running,
  setRunning,
  onEvent,
}: SectionProps) {
  const [info, setInfo] = useState<ArchiveInfo | null>(null);
  const [summary, setSummary] = useState<AccountSettingsSummary | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!storage) return;
      const i = await readArchiveInfo(storage);
      if (alive) setInfo(i);
    })();
    return () => {
      alive = false;
    };
  }, [storage]);

  const run = useCallback(
    async (dryRun: boolean) => {
      if (!storage) return;
      setRunning(true);
      setSummary(null);
      try {
        const res = await importAccountSettings(
          storage,
          target,
          { dryRun, override },
          onEvent,
        );
        if (res.summary) setSummary(res.summary);
      } finally {
        setRunning(false);
      }
    },
    [storage, target, override, onEvent, setRunning],
  );

  return (
    <CollapsibleStep title="A · Account settings">
      {info ? (
        <p className="hint">
          Archive{info.sourceName ? ` (${info.sourceName})` : ''}: {info.folders} folder(s),{' '}
          {info.customFonts} custom font(s) of {info.totalFonts}, {info.banks} bank(s),{' '}
          {info.courses} course(s).
        </p>
      ) : (
        <p className="hint">Reading archive…</p>
      )}
      <p className="hint">
        Imports the folder tree + custom fonts (account-level, once). Folder
        ownership/sharing stays a manual step.
      </p>
      <div className="row">
        <button onClick={() => run(true)} disabled={!storage || running}>
          {running ? 'Working…' : 'Dry-run'}
        </button>
        <button
          onClick={() => run(false)}
          disabled={!liveOk}
          style={liveOk ? { background: '#b00', color: '#fff' } : undefined}
        >
          Import account settings →
        </button>
      </div>
      {summary && (
        <p className="hint">
          Folders mapped: {summary.folders.mapped}. Fonts — {summary.fonts.matched} matched,{' '}
          {summary.fonts.created} created, {summary.fonts.unresolved} unresolved.
        </p>
      )}
    </CollapsibleStep>
  );
}

// --- B) Question banks --------------------------------------------------------

function BanksSection({
  storage,
  target,
  override,
  liveOk,
  running,
  setRunning,
  onEvent,
}: SectionProps) {
  const [banks, setBanks] = useState<LocalBank[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [outcomes, setOutcomes] = useState<BankImportOutcome[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!storage) return;
      const list = await listLocalBanks(storage);
      if (alive) setBanks(list);
    })();
    return () => {
      alive = false;
    };
  }, [storage]);

  const shown = useMemo(() => filterByName(banks, (b) => b.title, filter), [banks, filter]);

  const run = useCallback(
    async (dryRun: boolean) => {
      if (!storage) return;
      setRunning(true);
      setOutcomes([]);
      try {
        const res = await importBanks(storage, target, [...selected], { dryRun, override }, onEvent);
        setOutcomes(res.outcomes);
      } finally {
        setRunning(false);
      }
    },
    [storage, target, override, selected, onEvent, setRunning],
  );

  return (
    <CollapsibleStep title="B · Question banks">
      {banks.length === 0 ? (
        <p className="hint">No question banks in this archive.</p>
      ) : (
        <>
          <FilterRow
            value={filter}
            onChange={setFilter}
            placeholder="Filter banks by name…"
            selected={selected.size}
            shown={shown.length}
            total={banks.length}
            onSelectAll={() => setSelected((s) => selectAll(s, shown.map((b) => b.id)))}
            onClear={() => setSelected(new Set())}
          />
          <ul className="course-list">
            {shown.map((b) => (
              <li key={b.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(b.id)}
                    onChange={() => setSelected((s) => toggle(s, b.id))}
                  />{' '}
                  {b.title}{' '}
                  <span className="hint">
                    [{b.questionCount} question{b.questionCount === 1 ? '' : 's'}]
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="row">
            <button onClick={() => run(true)} disabled={!storage || selected.size === 0 || running}>
              {running ? 'Working…' : `Dry-run (${selected.size})`}
            </button>
            <button
              onClick={() => run(false)}
              disabled={!liveOk || selected.size === 0}
              style={liveOk && selected.size > 0 ? { background: '#b00', color: '#fff' } : undefined}
            >
              Import banks →
            </button>
          </div>
          {outcomes.length > 0 && (
            <p className="hint">
              {outcomes.filter((o) => o.ok).length} ok, {outcomes.filter((o) => !o.ok).length} failed.
            </p>
          )}
        </>
      )}
    </CollapsibleStep>
  );
}

// --- C) Courses ---------------------------------------------------------------

function CoursesSection({
  storage,
  target,
  override,
  liveOk,
  running,
  setRunning,
  onEvent,
}: SectionProps) {
  const [courses, setCourses] = useState<ArchiveCourse[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [outcomes, setOutcomes] = useState<CourseImportOutcome[]>([]);
  const [blocked, setBlocked] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!storage) {
        setCourses([]);
        return;
      }
      const raw = await storage.readManifest();
      let list: ArchiveCourse[] = [];
      if (raw) {
        try {
          const m = JSON.parse(raw) as { courses?: ArchiveCourse[] };
          if (Array.isArray(m.courses)) list = m.courses;
        } catch {
          /* fall through */
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

  const shown = useMemo(
    () => filterByName(courses, (c) => c.title ?? c.id, filter),
    [courses, filter],
  );

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
    [storage, target, override, selected, onEvent, setRunning],
  );

  return (
    <CollapsibleStep title="C · Courses">
      {courses.length === 0 ? (
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
          </div>
        </>
      )}
      {blocked && <p style={{ color: '#b00', fontWeight: 600 }}>BLOCKED: {blocked}</p>}
      {outcomes.length > 0 && <OutcomeTable outcomes={outcomes} />}
    </CollapsibleStep>
  );
}

// --- Shared bits --------------------------------------------------------------

function FilterRow({
  value,
  onChange,
  placeholder,
  selected,
  shown,
  total,
  onSelectAll,
  onClear,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  selected: number;
  shown: number;
  total: number;
  /** Select all currently-visible (filtered) rows. */
  onSelectAll: () => void;
  onClear: () => void;
}) {
  return (
    <>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '4px 8px',
          margin: '4px 0',
          font: 'inherit',
          borderRadius: 6,
          border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
          background: 'transparent',
          color: 'inherit',
        }}
      />
      <div className="row" style={{ margin: '4px 0' }}>
        <span className="hint">
          {selected} selected · {value ? `${shown} of ${total} shown` : `${total} total`}
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button onClick={onSelectAll} disabled={shown === 0}>
            {value ? `Select ${shown} shown` : 'Select all'}
          </button>
          <button onClick={onClear} disabled={selected === 0}>
            Clear
          </button>
        </span>
      </div>
    </>
  );
}

function filterByName<T>(items: T[], name: (t: T) => string, q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((it) => name(it).toLowerCase().includes(needle));
}

function toggle(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  next.has(id) ? next.delete(id) : next.add(id);
  return next;
}

/** Add every id in `ids` (the currently-visible rows) to the selection. */
function selectAll(set: Set<string>, ids: string[]): Set<string> {
  const next = new Set(set);
  for (const id of ids) next.add(id);
  return next;
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
          <th>parity</th>
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
            <td title={o.report.flags.map((f) => f.detail).join('\n')}>
              {o.report.flags.length === 0 ? '0' : summarizeFlags(o.report.flags)}
            </td>
            <td style={{ color: o.report.survivingSourceKeys.length ? '#b00' : undefined }}>
              {o.report.survivingSourceKeys.length}
            </td>
            <td
              style={
                o.parity && !o.parity.ok ? { color: '#b00', fontWeight: 600 } : undefined
              }
            >
              {o.parity ? (o.parity.ok ? '✓' : `${o.parity.issues.length} diff`) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
