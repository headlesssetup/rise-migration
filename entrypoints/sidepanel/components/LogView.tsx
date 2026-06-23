// The Log card — a self-contained presentational view split out of App.tsx.
// Renders the colorized log lines, the live import countdown, and copy/clear
// controls. All state (the log array, scroll stickiness, copied flash, import
// status) is owned by App and passed in.
import type { Ref } from 'react';
import { fmtRemaining, logLineClass } from '../log-format';

export interface ImportStatus {
  label: string;
  finishAt: number | null;
}

export interface LogViewProps {
  log: string[];
  importStatus: ImportStatus | null;
  copied: boolean;
  onCopy: () => void;
  onClear: () => void;
  logRef: Ref<HTMLDivElement>;
  onScroll: () => void;
}

export function LogView({
  log,
  importStatus,
  copied,
  onCopy,
  onClear,
  logRef,
  onScroll,
}: LogViewProps) {
  return (
    <section className="card log-card">
      <div className="log-header">
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
          <h2>Log</h2>
          {importStatus && (
            <span className="hint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {importStatus.label}
              {importStatus.finishAt != null
                ? ` · ${fmtRemaining(importStatus.finishAt - Date.now())} remaining`
                : ''}
            </span>
          )}
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button
            className="copy-btn"
            onClick={onCopy}
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
            onClick={onClear}
            disabled={log.length === 0}
            title="Clear log"
            aria-label="Clear log"
          >
            Clear
          </button>
        </span>
      </div>
      <div className="log" ref={logRef} onScroll={onScroll}>
        {log.map((line, i) =>
          line === '' ? (
            <div key={i} className="log-line log-gap" />
          ) : (
            <div key={i} className={logLineClass(line)}>
              {line}
            </div>
          ),
        )}
      </div>
    </section>
  );
}
