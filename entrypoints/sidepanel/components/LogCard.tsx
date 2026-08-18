// The always-visible log card — split out of App.tsx (v0.9.0 restructure).
// Renders in EVERY view: paced jobs must be watchable from anywhere.
import type { RefObject } from 'react';
import { LogLines } from './LogLines';

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
        <span style={{ display: 'flex', gap: 6 }}>
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
        <LogLines lines={log} />
      </div>
    </section>
  );
}
