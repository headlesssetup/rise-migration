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

// --- Timestamps ---------------------------------------------------------------
// Operations that take real time (an operation header, a course fetch, a
// Storyline build/upload) carry a leading `HH:MM:SS ` wall-clock stamp so the
// operator can tell when a step started and how long it took. Per-asset lines
// (sub-second) are deliberately unstamped. The stamp is a presentation prefix:
// the classifier strips it before looking for status markers.
const TIME_STAMP = /^\s*\d\d:\d\d:\d\d\s+/;

/** Current wall-clock time as `HH:MM:SS` (local), for operation-start lines. */
export function nowStamp(now: Date = new Date()): string {
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

/** Elapsed duration (ms) as `Xs` / `Xm Ys` / `Xh Ym` for end-of-run lines. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Status markers only count in "status position" — at the start of the line
// (after an optional `[i/N …]` progress prefix) or straight after a `label: `.
// Those are the two shapes every emitter uses (`[3/20 folders] OK   created "X"`,
// `[2/5] Course title: FAILED — …`). Matching a bare substring anywhere painted a
// course titled "Error handling" red and one titled "Done Deal" green.
// Prefixes may nest (`[2/120] [9/26 assets] OK …` — owner-of-total, then
// item-of-total within it), so strip every leading one.
const PROGRESS_PREFIX = /^\s*(?:\[\d+\/\d+[^\]]*\]\s*)*/;

const RULES: Array<[RegExp, string]> = [
  // Leading marker — the emitter's own classification, so it wins outright.
  [/^(?:FAILED|BLOCKED|ERROR|Failed|Aborting|Unauthorized)\b|^[⛔✗]/, 'log-error'],
  // OPTIONAL = capture-confirmed authoring provenance that could not be
  // fetched; it is blanked without a flag at import, so its HTTP status is a
  // warning, never a failure (the later `HTTP 4xx` rule must not see it).
  [/^(?:WARN|PARTIAL|STOPPED|OPTIONAL)\b|^⚠/, 'log-warn'],
  // `Planned` is a dry run's per-course outcome — grey like every other DRY
  // line, never green (it looked like a real import success).
  [/^(?:DRY|Planned)\b/, 'log-dry'],
  [/^(?:OK|Done|Imported)\b|^✓/, 'log-ok'],
  // `<label>: MARKER` — the per-course/per-item form.
  [/:[ \t](?:FAILED|BLOCKED|ERROR)\b|:[ \t][⛔✗]/, 'log-error'],
  [/:[ \t](?:WARN|PARTIAL|STOPPED)\b|:[ \t]⚠/, 'log-warn'],
  [/:[ \t](?:DRY|Planned)\b/, 'log-dry'],
  [/:[ \t](?:OK|Imported)\b|:[ \t]✓/, 'log-ok'],
  // `List error: …`, `Folders unavailable: …` — the word labels the failure.
  [/\b(?:error|failed|unauthorized|unavailable):/i, 'log-error'],
  // A quoted HTTP failure status anywhere is a failure, whoever emitted it.
  [/\bHTTP [45]\d\d\b/, 'log-error'],
  // `Search OK (HTTP 200)`, `storyline read-back OK — …` — an OK marker inside
  // the leading label text, which (letters/spaces/hyphens only, no colon) can't
  // be a `Saved: <course title>` tail.
  [/^[A-Za-z -]{0,24}\bOK\b/, 'log-ok'],
];

/** Classify a log line for colorization (CSS in style.css). */
export function logLineClass(line: string): string {
  const unstamped = line.replace(TIME_STAMP, '');
  // Operation/course headers are emitted with a leading ▶ marker — render bold.
  if (/^\s*▶/.test(unstamped)) return 'log-line log-head';
  const body = unstamped.replace(PROGRESS_PREFIX, '');
  for (const [re, cls] of RULES) if (re.test(body)) return `log-line ${cls}`;
  return 'log-line';
}

// --- Filtering ----------------------------------------------------------------

/** Log view filter: everything, only warnings+errors, or only errors. */
export type LogFilter = 'all' | 'problems' | 'errors';

const KEEP: Record<LogFilter, ReadonlySet<string>> = {
  all: new Set(),
  problems: new Set(['log-line log-error', 'log-line log-warn']),
  errors: new Set(['log-line log-error']),
};

/**
 * Reduce the log to the lines a filter keeps. A `▶` header survives only when
 * at least one kept line follows it (before the next header) — otherwise a
 * 170-course import would show 170 bold headers with nothing under them. A
 * surviving header is preceded by a gap, as in the unfiltered log.
 */
export function filterLogLines(lines: readonly string[], filter: LogFilter): string[] {
  if (filter === 'all') return [...lines];
  const keep = KEEP[filter];
  const out: string[] = [];
  let pendingHead: string | null = null;
  for (const line of lines) {
    if (line === '') continue;
    const cls = logLineClass(line);
    if (cls === 'log-line log-head') {
      pendingHead = line;
      continue;
    }
    if (!keep.has(cls)) continue;
    if (pendingHead !== null) {
      if (out.length > 0) out.push('');
      out.push(pendingHead);
      pendingHead = null;
    }
    out.push(line);
  }
  return out;
}
