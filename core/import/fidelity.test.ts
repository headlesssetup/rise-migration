import { describe, it, expect } from 'vitest';
import { buildPlan, type PlanInput } from './plan';
import { executePlan } from './executor';
import { IdMap } from './ids';
import { buildFidelityReport, fidelityReportToMarkdown, fidelityReportToJson } from './fidelity';

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
    const report = buildFidelityReport(steps, res, 'SRC', '2026-06-20T00:00:00Z');
    expect(report.dryRun).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.sourceCourseId).toBe('SRC');
    expect(report.flags.some((f) => f.kind === 'storyline')).toBe(true);
    expect(report.survivingSourceKeys).toEqual([]);

    const md = fidelityReportToMarkdown(report);
    expect(md).toContain('DRY RUN');
    expect(md).toContain('storyline');
    expect(md).toContain('surviving');

    const json = JSON.parse(fidelityReportToJson(report));
    expect(json.planned.storylineFlags).toBe(1);
  });
});
