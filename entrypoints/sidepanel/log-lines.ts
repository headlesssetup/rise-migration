// Log presentation helpers, kept out of App.tsx so they can be unit-tested (the
// panel has no React test harness).

/** Retained log lines. A multi-hour run emits tens of thousands of lines and the
 *  log view is unvirtualized, so the oldest are dropped instead of re-rendering
 *  everything on every append (and on every 1 Hz countdown tick). */
export const LOG_MAX_LINES = 4000;

const TRIM_MARKER = /^… (\d+) earlier line\(s\) trimmed$/;

function trimMarker(dropped: number): string {
  return `… ${dropped} earlier line(s) trimmed`;
}

/**
 * Append lines to the log, keeping at most `max` of them. Once the cap is hit
 * the first retained line is a marker carrying the RUNNING total of dropped
 * lines, so the operator can see the log is truncated (and by how much) instead
 * of silently losing the head of a long run.
 */
export function appendLogLines(
  prev: readonly string[],
  added: readonly string[],
  max: number = LOG_MAX_LINES,
): string[] {
  const next = [...prev, ...added];
  if (next.length <= max) return next;

  // A marker already at the head carries what earlier appends dropped.
  const head = next[0] ?? '';
  const m = TRIM_MARKER.exec(head);
  const dropped = m ? Number(m[1]) : 0;
  const body = m ? next.slice(1) : next;

  const keep = Math.max(0, max - 1); // one slot reserved for the marker
  const overflow = Math.max(0, body.length - keep);
  return [trimMarker(dropped + overflow), ...body.slice(overflow)];
}

// Status markers only count in "status position" — at the start of the line
// (after an optional `[i/N …]` progress prefix) or straight after a `label: `.
// Those are the two shapes every emitter uses (`[3/20 folders] OK   created "X"`,
// `[2/5] Course title: FAILED — …`). Matching a bare substring anywhere painted a
// course titled "Error handling" red and one titled "Done Deal" green.
const PROGRESS_PREFIX = /^\s*(?:\[\d+\/\d+[^\]]*\]\s*)?/;

const RULES: Array<[RegExp, string]> = [
  // Leading marker — the emitter's own classification, so it wins outright.
  [/^(?:FAILED|BLOCKED|ERROR|Failed|Aborting|Unauthorized)\b|^[⛔✗]/, 'log-error'],
  [/^(?:WARN|PARTIAL|STOPPED)\b|^⚠/, 'log-warn'],
  [/^DRY\b/, 'log-dry'],
  [/^(?:OK|Done|Imported|Planned)\b|^✓/, 'log-ok'],
  // `<label>: MARKER` — the per-course/per-item form.
  [/:[ \t](?:FAILED|BLOCKED|ERROR)\b|:[ \t][⛔✗]/, 'log-error'],
  [/:[ \t](?:WARN|PARTIAL|STOPPED)\b|:[ \t]⚠/, 'log-warn'],
  [/:[ \t]DRY\b/, 'log-dry'],
  [/:[ \t](?:OK|Imported|Planned)\b|:[ \t]✓/, 'log-ok'],
  // `List error: …`, `Folders unavailable: …` — the word labels the failure.
  [/\b(?:error|failed|unauthorized|unavailable):/i, 'log-error'],
  // A quoted HTTP failure status anywhere is a failure, whoever emitted it.
  [/\bHTTP [45]\d\d\b/, 'log-error'],
  // `Search OK (HTTP 200)` — an OK marker inside the leading label text, which
  // (letters/spaces only, no colon) can't be a `Saved: <course title>` tail.
  [/^[A-Za-z ]{0,20}\bOK\b/, 'log-ok'],
];

/** Classify a log line for colorization (CSS in style.css). */
export function logLineClass(line: string): string {
  // Operation/course headers are emitted with a leading ▶ marker — render bold.
  if (/^\s*▶/.test(line)) return 'log-line log-head';
  const body = line.replace(PROGRESS_PREFIX, '');
  for (const [re, cls] of RULES) if (re.test(body)) return `log-line ${cls}`;
  return 'log-line';
}
