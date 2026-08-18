// Step A · Account settings — split out of ImportView.tsx (v0.9.0).

import { useCallback, useEffect, useState } from 'react';
import {
  importAccountSettings,
  readArchiveInfo,
  type AccountSettingsSummary,
  type ArchiveInfo,
} from '../../orchestrator';
import { CollapsibleStep, type SectionProps } from './step-shared';

export function AccountSettingsSection({
  storage,
  target,
  override,
  liveOk,
  running,
  setRunning,
  onEvent,
  logBreak,
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
      logBreak(`Account settings — ${dryRun ? 'dry-run' : 'import'}`);
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
      } catch (e) {
        onEvent({
          kind: 'log',
          message: `FAILED — account settings: ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        setRunning(false);
      }
    },
    [storage, target, override, onEvent, logBreak, setRunning],
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

