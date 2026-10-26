import { describe, expect, it } from 'vitest';
import {
  LOG_MAX_LINES,
  appendLogLines,
  filterLogLines,
  fmtElapsed,
  logLineClass,
  nowStamp,
} from './log-lines';

describe('appendLogLines', () => {
  it('appends untouched while under the cap', () => {
    expect(appendLogLines(['a'], ['b', 'c'], 5)).toEqual(['a', 'b', 'c']);
    expect(appendLogLines([], ['a'])).toEqual(['a']);
  });

  it('caps the log and marks how many lines were dropped', () => {
    const out = appendLogLines(['1', '2', '3', '4', '5'], ['6'], 5);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe('… 2 earlier line(s) trimmed');
    expect(out.slice(1)).toEqual(['3', '4', '5', '6']);
  });

  it('accumulates the dropped count across successive trims', () => {
    let log = ['1', '2', '3', '4', '5'];
    log = appendLogLines(log, ['6'], 5); // drops 1,2
    log = appendLogLines(log, ['7'], 5); // drops 3
    expect(log).toHaveLength(5);
    expect(log[0]).toBe('… 3 earlier line(s) trimmed');
    expect(log.slice(1)).toEqual(['4', '5', '6', '7']);
    // dropped + retained accounts for every line ever appended
    expect(3 + (log.length - 1)).toBe(7);
  });

  it('handles a burst bigger than the cap', () => {
    const out = appendLogLines(['a'], ['b', 'c', 'd', 'e', 'f'], 3);
    expect(out).toEqual(['… 4 earlier line(s) trimmed', 'e', 'f']);
  });

  it('defaults to LOG_MAX_LINES', () => {
    const many = Array.from({ length: LOG_MAX_LINES + 10 }, (_, i) => `l${i}`);
    const out = appendLogLines([], many);
    expect(out).toHaveLength(LOG_MAX_LINES);
    expect(out[0]).toBe('… 11 earlier line(s) trimmed');
  });
});

describe('logLineClass', () => {
  const cls = (line: string) => logLineClass(line).replace(/^log-line ?/, '');

  it('marks ▶ operation headers, with or without a timestamp', () => {
    expect(cls('▶ Fetch courses')).toBe('log-head');
    expect(cls('14:03:22 ▶ Fetch courses')).toBe('log-head');
  });

  it('sees through a leading HH:MM:SS stamp to the status marker', () => {
    expect(cls('14:03:22 [3/170] ✓ Saved: Course')).toBe('log-ok');
    expect(cls('14:03:22 [3/170] FAILED "Course" (abc): boom')).toBe('log-error');
    expect(cls('14:03:22 [3/170] Fetching "Course"…')).toBe('');
  });

  it('paints a dry-run outcome grey, not green', () => {
    expect(cls('Planned "Course" — 12 block(s), 0 flag(s)')).toBe('log-dry');
    expect(cls('[2/5] Course: Planned')).toBe('log-dry');
  });

  it('accepts an OK marker after a hyphenated label', () => {
    expect(cls('[1/3] storyline read-back OK — review/items/x/story.html')).toBe('log-ok');
    expect(cls('Language parity OK — 12 cell(s) match')).toBe('log-ok');
  });

  it('keeps an expected retry poll white even though it quotes the status', () => {
    expect(cls('[1/3] …    GET_COURSE not ready yet (attempt 2/3, status 404 — retrying)')).toBe('');
  });

  it('classifies leading markers, incl. after an [i/N] prefix', () => {
    expect(cls('FAILED "Course": boom')).toBe('log-error');
    expect(cls('BLOCKED: source is the target')).toBe('log-error');
    expect(cls('⛔ Aborting: auth/session failure')).toBe('log-error');
    expect(cls('[3/20 folders] WARN create failed')).toBe('log-warn');
    expect(cls('PARTIAL "Course": kept')).toBe('log-warn');
    expect(cls('STOPPED "Course" mid-course')).toBe('log-warn');
    expect(cls('[2/9] DRY  would create typeface "X"')).toBe('log-dry');
    expect(cls('[3/20 folders] OK   created "Name"')).toBe('log-ok');
    expect(cls('Imported "Course" — 12 block(s)')).toBe('log-ok');
    expect(cls('Done — saved 3, skipped 0, failed 0.')).toBe('log-ok');
  });

  it('classifies a marker after a `label: ` (the per-course form)', () => {
    expect(cls('[2/5] Course title: FAILED — boom')).toBe('log-error');
    expect(cls('[2/5] leaf-abc: FAILED — package zip missing')).toBe('log-error');
  });

  it('treats a failure word used as a label, or an HTTP 4xx/5xx, as an error', () => {
    expect(cls('List error: relay closed')).toBe('log-error');
    expect(cls('Folders unavailable: no user id')).toBe('log-error');
    expect(cls('Search failed (HTTP 403)')).toBe('log-error');
  });

  it('sees through nested progress prefixes (owner-of-total, then item-of-total)', () => {
    expect(cls('[2/120] [9/26 assets] OK x.png (deduped)')).toBe('log-ok');
    expect(cls('[2/120] [9/26 assets] OPTIONAL x.mp4: HTTP 403')).toBe('log-warn');
    expect(cls('[2/120] [9/26 assets] FAILED x.mp4: HTTP 500')).toBe('log-error');
    expect(cls('[2/120] ⚠ owner FAILED abc: boom')).toBe('log-warn');
  });

  it('renders an unavailable OPTIONAL asset as a warning even with an HTTP status', () => {
    expect(cls('[9/49 assets] OPTIONAL Fq8f-Eksport.mp4: HTTP 403')).toBe('log-warn');
    expect(cls('[9/49 assets] OPTIONAL Fq8f-Eksport.mp4 (unavailable, not retried)')).toBe('log-warn');
    // a REQUIRED miss stays red
    expect(cls('[9/49 assets] FAILED Fq8f-Eksport.mp4: HTTP 500')).toBe('log-error');
  });

  it('does NOT colorize on words inside course titles (the M/LOW bug)', () => {
    // Titles are user data; only the emitter's markers may set the color.
    expect(cls('Saved: Error handling')).toBe('');
    expect(cls('[1/3] Error handling: 12 block(s)')).not.toBe('log-error');
    expect(cls('Saved: Done Deal')).toBe('');
    expect(cls('Saved: A course about OK signals')).toBe('');
    expect(cls('Saved: Unauthorized access — a primer')).toBe('');
  });

  it('leaves plain progress lines unstyled', () => {
    expect(logLineClass('Fetching course list — page 2…')).toBe('log-line');
    expect(logLineClass('… 12 earlier line(s) trimmed')).toBe('log-line');
  });
});

describe('nowStamp / fmtElapsed', () => {
  it('formats HH:MM:SS zero-padded', () => {
    expect(nowStamp(new Date(2026, 9, 26, 9, 5, 7))).toBe('09:05:07');
  });

  it('formats an elapsed duration coarsely', () => {
    expect(fmtElapsed(4_200)).toBe('4s');
    expect(fmtElapsed(125_000)).toBe('2m 5s');
    expect(fmtElapsed(3_900_000)).toBe('1h 5m');
  });
});

describe('filterLogLines', () => {
  const log = [
    '14:00:00 ▶ Fetch courses',
    '[1/3] ✓ Saved: A',
    '[2/3] FAILED "B" (b1): boom',
    '[3/3] ⚠ Skipped unreadable course: "C" (c1)',
    '',
    '14:10:00 ▶ Download assets',
    '[1/2] ✓ Assets "A": 3 new',
    '[2/2] ✓ Assets "B": 0 new',
    '',
    '14:20:00 ▶ Courses — import',
    'Imported "A" — 12 block(s), 0 flag(s)',
  ];

  it('returns everything for "all"', () => {
    expect(filterLogLines(log, 'all')).toEqual(log);
  });

  it('keeps warnings + errors and only the headers they sit under', () => {
    expect(filterLogLines(log, 'problems')).toEqual([
      '14:00:00 ▶ Fetch courses',
      '[2/3] FAILED "B" (b1): boom',
      '[3/3] ⚠ Skipped unreadable course: "C" (c1)',
    ]);
  });

  it('keeps only errors for "errors"', () => {
    expect(filterLogLines(log, 'errors')).toEqual([
      '14:00:00 ▶ Fetch courses',
      '[2/3] FAILED "B" (b1): boom',
    ]);
  });

  it('separates surviving sections with a gap', () => {
    const two = [...log, '⚠ flags: storyline:1'];
    expect(filterLogLines(two, 'problems')).toEqual([
      '14:00:00 ▶ Fetch courses',
      '[2/3] FAILED "B" (b1): boom',
      '[3/3] ⚠ Skipped unreadable course: "C" (c1)',
      '',
      '14:20:00 ▶ Courses — import',
      '⚠ flags: storyline:1',
    ]);
  });

  it('is empty when nothing matches', () => {
    expect(filterLogLines(['▶ Op', '✓ fine'], 'problems')).toEqual([]);
  });
});
