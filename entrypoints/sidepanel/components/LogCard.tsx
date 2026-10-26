// The always-visible log card — split out of App.tsx (v0.9.0 restructure).
// Renders in EVERY view: paced jobs must be watchable from anywhere.
import { useMemo, useState, type RefObject } from 'react';
import { filterLogLines, type LogFilter } from '../log-lines';
import { LogLines } from './LogLines';

const FILTERS: Array<[LogFilter, string, string]> = [
  ['all', 'All', 'Show every line'],
  ['problems', 'Problems', 'Only warnings and errors (plus the headers they sit under)'],
  ['errors', 'Errors', 'Only errors (plus the headers they sit under)'],
];

/** Live run status for the log-header countdown (import/export/upload). */
export interface RunStatus {
  label: string;
  finishAt: number | null;
  done: boolean;
}

/** Format a remaining-duration (ms) as HH:MM:SS for the log-header countdown. */
function fmtRemaining(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
}

interface Props {
  log: string[];
  copied: boolean;
  copyLog: () => void;
  clearLog: () => void;
  status: RunStatus | null;
  logRef: RefObject<HTMLDivElement | null>;
  onLogScroll: () => void;
}

export function LogCard({
  log,
  copied,
  copyLog,
  clearLog,
  status,
  logRef,
  onLogScroll,
}: Props) {
  // View filter — presentation only; the stored log is untouched, and Copy
  // always copies the full log. Filtering re-classifies every retained line
  // (≤ LOG_MAX_LINES regex passes), memoized on the line array like LogLines.
  const [filter, setFilter] = useState<LogFilter>('all');
  const shown = useMemo(() => filterLogLines(log, filter), [log, filter]);
  return (
    <section className="card log-card">
      <div className="log-header">
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
          <h2>Log</h2>
          {status && (
            <span className="hint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {status.label}
              {status.finishAt != null
                ? ` · ${fmtRemaining(status.finishAt - Date.now())} remaining`
                : status.done
                  ? ''
                  : ' · estimating…'}
            </span>
          )}
        </span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="log-filter" role="group" aria-label="Log filter">
            {FILTERS.map(([key, label, title]) => (
              <button
                key={key}
                className={`log-filter-btn${filter === key ? ' active' : ''}`}
                onClick={() => setFilter(key)}
                title={title}
                aria-pressed={filter === key}
              >
                {label}
              </button>
            ))}
            {filter !== 'all' && (
              <span className="hint" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                {shown.filter((l) => l !== '').length} of {log.length}
              </span>
            )}
          </span>
          <button
            className="copy-btn"
            onClick={copyLog}
            disabled={log.length === 0}
            title="Copy log to clipboard"
            aria-label="Copy log to clipboard"
          >
            {copied ? (
              '✓ Copied'
            ) : (
              <>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>{' '}
                Copy
              </>
            )}
          </button>
          <button
            className="copy-btn"
            onClick={clearLog}
            disabled={log.length === 0}
            title="Clear log"
            aria-label="Clear log"
          >
            Clear
          </button>
        </span>
      </div>
      <div className="log" ref={logRef} onScroll={onLogScroll}>
        {filter !== 'all' && shown.length === 0 && log.length > 0 ? (
          <div className="log-line hint">
            {filter === 'errors' ? 'No errors.' : 'No warnings or errors.'}
          </div>
        ) : (
          <LogLines lines={shown} />
        )}
      </div>
    </section>
  );
}
