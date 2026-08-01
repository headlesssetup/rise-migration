import { describe, expect, it } from 'vitest';
import { LOG_MAX_LINES, appendLogLines, logLineClass } from './log-lines';

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

  it('marks ▶ operation headers', () => {
    expect(cls('▶ Fetch courses')).toBe('log-head');
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
