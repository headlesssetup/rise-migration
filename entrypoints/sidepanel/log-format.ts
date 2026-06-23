// Pure log-formatting helpers for the side panel, split out of App.tsx so that
// frequently-read file stays focused on composition. No React — just string work.

/** Classify a log line for colorization (CSS in style.css). */
export function logLineClass(line: string): string {
  // Operation/course headers are emitted with a leading ▶ marker — render bold.
  if (/^\s*▶/.test(line)) return 'log-line log-head';
  if (/^\s*(FAILED|BLOCKED|✗)|\berror\b|Unauthorized|HTTP [45]\d\d/i.test(line))
    return 'log-line log-error';
  if (/^\s*(\[\d+\/\d+\]\s*)?WARN|⚠/i.test(line)) return 'log-line log-warn';
  if (/\bOK\b|✓|Imported|Planned|done\b/i.test(line)) return 'log-line log-ok';
  if (/^\s*(\[\d+\/\d+\]\s*)?DRY\b/i.test(line)) return 'log-line log-dry';
  return 'log-line';
}

/** Format a remaining-duration (ms) as HH:MM:SS for the log-header countdown. */
export function fmtRemaining(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
}
