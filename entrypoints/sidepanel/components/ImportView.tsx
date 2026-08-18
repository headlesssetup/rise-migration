// Phase 3 — Import (write mode) panel. Deliberate, gated entry into writing:
// a write-mode banner, a target-account confirmation gate (shows the live tab's
// identity + plane), a Source ≠ Target guard (read from the archive manifest),
// then THREE ordered operations — each with its own dry-run + live run:
//   A) account settings (folders + custom fonts)
//   B) question banks (selectable, filterable)
//   C) courses (selectable, filterable)
// The archive stays read-only; outputs land under _import/.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  checkSourceNotTarget,
  describeTarget,
  summarizeFlags,
  type AccountIdentity,
} from '@/core/import';
import type { Storage } from '@/core/storage/storage';
import type { SessionState } from '@/shared/messaging';
import { inspectLocalArchive, type LocalArchiveInspection } from '@/core/local-archive';
import {
  importAccountSettings,
  importBanks,
  listLocalBanks,
  estimateCourses,
  readArchiveInfo,
  readSourceIdentity,
  runImport,
  uploadStorylineToReview360,
  type AccountSettingsSummary,
  type ArchiveInfo,
  type BankImportOutcome,
  type CourseImportOutcome,
  type LocalBank,
  type ProgressEvent,
} from '../orchestrator';
import { formatEstimate } from '@/core/import';
import { AccountSettingsSection } from './import/AccountSettingsSection';
import { BanksSection } from './import/BanksSection';
import { CoursesSection } from './import/CoursesSection';
import { StorylineUploadSection } from './import/StorylineUploadSection';
import { OutcomeTable } from './import/OutcomeTable';
import type { ArchiveCourse, StopController } from './import/step-shared';


export function ImportView({
  storage,
  session,
  addLog,
  logBreak,
  onStatus,
  running,
  setRunning,
}: {
  storage: Storage | null;
  session: SessionState | null;
  addLog: (m: string) => void;
  /** Start a new log section: a blank line + optional bold ▶ header. */
  logBreak: (label?: string) => void;
  /** Live import status for the log-header countdown. */
  onStatus?: (e: Extract<ProgressEvent, { kind: 'import-status' }>) => void;
  /** A run is in flight. Owned by App (not this component) so an accidental
   *  mode-tab click can't unmount a live run into a detached closure — App gates
   *  the mode tabs and every export action on it. */
  running: boolean;
  setRunning: (b: boolean) => void;
}) {
  const [source, setSource] = useState<AccountIdentity | undefined>(undefined);
  const [archiveInspection, setArchiveInspection] =
    useState<LocalArchiveInspection | null>(null);
  const [confirmTarget, setConfirmTarget] = useState(false);
  const [override, setOverride] = useState(false);
  // Course selection lives here, not in CoursesSection: step D scopes the
  // Review-360 upload to the same courses the operator picked for import.
  const [courseSelection, setCourseSelection] = useState<Set<string>>(new Set());

  // Graceful Stop: a ref (read synchronously by the orchestrator's shouldStop)
  // plus a state mirror so the Stop button can show "Stopping…". `reset()` is
  // called by each run() at start; `request()` flips it when Stop is pressed.
  const stopFlag = useRef(false);
  const [stopRequested, setStopRequested] = useState(false);
  const stop: StopController = useMemo(
    () => ({
      shouldStop: () => stopFlag.current,
      request: () => {
        stopFlag.current = true;
        setStopRequested(true);
      },
      reset: () => {
        stopFlag.current = false;
        setStopRequested(false);
      },
      requested: stopRequested,
    }),
    [stopRequested],
  );

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

  const unoverriddenVerdict = useMemo(
    () => checkSourceNotTarget(source, target, false),
    [source, target],
  );
  const verdict = useMemo(
    () => checkSourceNotTarget(source, target, override),
    [source, target, override],
  );
  // Derive visibility from the verdict BEFORE override. Otherwise checking the
  // override makes the verdict pass and immediately hides the checkbox, leaving
  // an irreversible-looking "explicitly overridden" state in the UI.
  const sameAccount =
    !unoverriddenVerdict.ok &&
    'sameAccount' in unoverriddenVerdict &&
    unoverriddenVerdict.sameAccount;

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

  useEffect(() => {
    let alive = true;
    setArchiveInspection(null);
    void (async () => {
      if (!storage) return;
      const inspected = await inspectLocalArchive(storage);
      if (alive) setArchiveInspection(inspected);
    })();
    return () => {
      alive = false;
    };
  }, [storage]);

  const onEvent = useCallback(
    (e: ProgressEvent) => {
      if (e.kind === 'log') addLog(e.message);
      else if (e.kind === 'course') {
        // Bold, named header per course, set off by a blank line so each course's
        // run is easy to find when scanning a long import log.
        const name = e.title ? `${e.title} (${e.courseId})` : e.courseId;
        logBreak(`[${e.index + 1}/${e.total}] ${name}`);
      } else if (e.kind === 'import-status') onStatus?.(e);
    },
    [addLog, logBreak, onStatus],
  );

  // Live runs need an explicit target confirmation + the guard + a Rise tab.
  const liveOk =
    !!storage &&
    archiveInspection?.ready === true &&
    !!session?.risePresent &&
    confirmTarget &&
    verdict.ok &&
    !running;

  return (
    <section className="card" style={{ borderColor: '#b00', borderWidth: 2 }}>
      <h2 style={{ color: '#b00' }}>⚠ Import (write mode)</h2>
      <p className="hint">
        This mode <b>writes into a live Rise account</b>. Run the three steps in
        order: account settings → question banks → courses. Dry-run each first.
      </p>

      {storage && !archiveInspection && <p className="hint">Checking archive file list…</p>}
      {archiveInspection && (
        <div
          style={{
            border: `1px solid ${archiveInspection.ready ? '#39844a' : '#b00'}`,
            borderRadius: 6,
            padding: 8,
            marginBottom: 10,
          }}
        >
          <b>
            Archive: {archiveInspection.ready ? 'READY' : 'NOT READY'} ·{' '}
            {archiveInspection.kind === 'v1'
              ? `${archiveInspection.origin ?? 'unknown'} v1`
              : archiveInspection.kind}
          </b>
          <div className="hint">
            {archiveInspection.courses.length} course(s)
            {archiveInspection.toolVersion
              ? ` · created by ${archiveInspection.toolVersion}`
              : ''}
          </div>
          {archiveInspection.issues.map((i, index) => (
            <div
              className="hint"
              style={{ color: i.severity === 'error' ? '#b00' : '#8a5a00' }}
              key={`${i.code}-${i.path}-${index}`}
            >
              {i.severity === 'error' ? '✖' : '⚠'} {i.path}: {i.message}
            </div>
          ))}
        </div>
      )}

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
          : archiveInspection?.origin === 'creator'
            ? 'Creator package — built locally, no source account. Confirm the target account below.'
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
        logBreak={logBreak}
        stop={stop}
      />
      <BanksSection
        storage={storage}
        target={target}
        override={override}
        liveOk={liveOk}
        running={running}
        setRunning={setRunning}
        onEvent={onEvent}
        logBreak={logBreak}
        stop={stop}
      />
      <CoursesSection
        storage={storage}
        target={target}
        override={override}
        liveOk={liveOk}
        running={running}
        setRunning={setRunning}
        onEvent={onEvent}
        logBreak={logBreak}
        stop={stop}
        selected={courseSelection}
        setSelected={setCourseSelection}
        archiveInspection={archiveInspection}
      />
      <StorylineUploadSection
        storage={storage}
        liveOk={liveOk}
        running={running}
        setRunning={setRunning}
        onEvent={onEvent}
        logBreak={logBreak}
        selected={courseSelection}
      />
    </section>
  );
}

