// Step B · Question banks — split out of ImportView.tsx (v0.9.0).

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  importBanks,
  listLocalBanks,
  type BankImportOutcome,
  type LocalBank,
} from '../../orchestrator';
import {
  CollapsibleStep,
  FilterRow,
  filterByName,
  selectAll,
  toggle,
  type SectionProps,
} from './step-shared';

export function BanksSection({
  storage,
  target,
  override,
  liveOk,
  running,
  setRunning,
  onEvent,
  stop,
  logBreak,
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
      logBreak(`Question banks — ${dryRun ? 'dry-run' : 'import'}`);
      stop.reset();
      setRunning(true);
      setOutcomes([]);
      try {
        const res = await importBanks(
          storage,
          target,
          [...selected],
          { dryRun, override, shouldStop: stop.shouldStop },
          onEvent,
        );
        setOutcomes(res.outcomes);
      } catch (e) {
        onEvent({
          kind: 'log',
          message: `FAILED — question banks: ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        setRunning(false);
      }
    },
    [storage, target, override, selected, onEvent, logBreak, setRunning, stop],
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
            {running && (
              <button onClick={stop.request} disabled={stop.requested}>
                {stop.requested ? 'Stopping…' : 'Stop'}
              </button>
            )}
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

