import { describe, it, expect } from 'vitest';
import { buildPlan, type PlanInput } from './plan';
import { executePlan } from './executor';
import { IdMap } from './ids';
import {
  buildFidelityReport,
  fidelityReportToMarkdown,
  fidelityReportToJson,
  fidelityStatus,
  type FidelityReport,
} from './fidelity';
import { summarizeFlags } from './executor';

describe('summarizeFlags', () => {
  it('groups by kind, most-frequent first', () => {
    expect(
      summarizeFlags([
        { kind: 'unsupported-media', detail: '' },
        { kind: 'storyline', detail: '' },
        { kind: 'unsupported-media', detail: '' },
        { kind: 'unsupported-media', detail: '' },
      ]),
    ).toBe('3 unsupported-media, 1 storyline');
  });

  it('is empty for no flags', () => {
    expect(summarizeFlags([])).toBe('');
  });
});

function dryInput(): PlanInput {
  return {
    author: 'auth0|t',
    assets: [],
    banksById: new Map(),
    course: {
      course: { id: 'SRC', title: 'C', theme: { themeId: 'x' } },
      lessons: [
        {
          id: 'L1',
          position: 0,
          type: 'blocks',
          title: 'L',
          items: [
            { id: 'cb1aaaaaaaaaaaaaaaaaaaaaa', family: '360', variant: 'storyline', items: [{ id: 'ci1aaaaaaaaaaaaaaaaaaaaaa' }] },
          ],
        },
      ],
    },
  };
}

describe('buildFidelityReport', () => {
  it('summarizes a dry run with a storyline flag', async () => {
    const input = dryInput();
    const steps = buildPlan(input);
    const res = await executePlan(steps, {
      input,
      relay: async () => ({ ok: true, status: 200, text: '{}' }),
      readAsset: async () => null,
      dryRun: true,
      ids: new IdMap(),
    });
    const report = buildFidelityReport(steps, res, 'SRC', 'My Course', '2026-06-20T00:00:00Z');
    expect(report.dryRun).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.sourceCourseId).toBe('SRC');
    expect(report.title).toBe('My Course');
    expect(report.flags.some((f) => f.kind === 'storyline')).toBe(true);
    expect(report.survivingSourceKeys).toEqual([]);

    const md = fidelityReportToMarkdown(report);
    expect(md).toContain('DRY RUN');
    expect(md).toContain('My Course');
    expect(md).toContain('storyline');
    expect(md).toContain('surviving');

    const json = JSON.parse(fidelityReportToJson(report));
    expect(json.planned.storylineFlags).toBe(1);
  });
});

describe('fidelityStatus', () => {
  const base: FidelityReport = {
    generatedAt: 't',
    dryRun: false,
    ok: false,
    planned: { total: 0, banks: 0, lessons: 0, blocks: 0, uploads: 0, storylineFlags: 0, orphanFlags: 0, drawFromBank: 0 },
    flags: [],
    survivingSourceKeys: [],
    idMappings: 0,
  };

  it('DRY RUN takes precedence', () => {
    expect(fidelityStatus({ ...base, dryRun: true })).toBe('DRY RUN');
  });
  it('OK when the import succeeded', () => {
    expect(fidelityStatus({ ...base, ok: true })).toBe('OK');
  });
  it('STOPPED when halted mid-course', () => {
    expect(fidelityStatus({ ...base, stopped: true, newCourseId: 'C' })).toBe('STOPPED');
  });
  it('PARTIAL when a confirmed course failed mid-build (resumable, kept)', () => {
    expect(fidelityStatus({ ...base, newCourseId: 'C' })).toBe('PARTIAL');
  });
  it('FAILED when an unconfirmed shell was left orphaned', () => {
    expect(fidelityStatus({ ...base, newCourseId: 'C', orphanedCourseId: 'C' })).toBe('FAILED');
  });
  it('FAILED when nothing was created', () => {
    expect(fidelityStatus({ ...base })).toBe('FAILED');
  });

  it('markdown shows a resumable note for PARTIAL + the orphaned-shell line', () => {
    const partial = fidelityReportToMarkdown({ ...base, newCourseId: 'C', error: 'boom' });
    expect(partial).toContain('PARTIAL');
    expect(partial).toContain('resumable');

    const orphaned = fidelityReportToMarkdown({ ...base, newCourseId: 'C', orphanedCourseId: 'C' });
    expect(orphaned).toContain('Orphaned shell left in place');
  });
});
