// Phase 3 — fidelity report. After an import (dry or live) we summarize parity:
// what the plan intended vs what executed, the manual-handling flags, and the
// hard invariant (no source media key survived, protocol §8/§12). This is the
// operator's "did it round-trip?" view + a persisted record beside the archive.

import { planStats, type PlanStep } from './plan';
import type { ExecResult } from './executor';

export interface FidelityReport {
  generatedAt: string;
  dryRun: boolean;
  ok: boolean;
  sourceCourseId?: string;
  /** Human-readable course title — so a report file names the course, not just ids. */
  title?: string;
  newCourseId?: string;
  /** Planned vs executed counts. */
  planned: ReturnType<typeof planStats>;
  /** Manual-handling items (storyline, orphaned media, missing bank refs). */
  flags: ExecResult['flags'];
  /** Loud-fail invariant: keys that survived from the source space (must be []). */
  survivingSourceKeys: string[];
  /** Size of the old→new id map (resumable job log). */
  idMappings: number;
  error?: string;
}

export function buildFidelityReport(
  steps: PlanStep[],
  result: ExecResult,
  sourceCourseId?: string,
  title?: string,
  generatedAt: string = new Date().toISOString(),
): FidelityReport {
  return {
    generatedAt,
    dryRun: result.dryRun,
    ok: result.ok,
    sourceCourseId,
    title,
    newCourseId: result.newCourseId,
    planned: planStats(steps),
    flags: result.flags,
    survivingSourceKeys: result.survivingKeys,
    idMappings: Object.keys(result.idMap).length,
    error: result.error,
  };
}

export function fidelityReportToJson(r: FidelityReport): string {
  return JSON.stringify(r, null, 2);
}

/** A short human-readable summary for the panel + the migration log. */
export function fidelityReportToMarkdown(r: FidelityReport): string {
  const lines: string[] = [];
  lines.push(`# Import fidelity report${r.title ? ` — ${r.title}` : ''}${r.dryRun ? ' (DRY RUN)' : ''}`);
  lines.push('');
  if (r.title) lines.push(`- Course: **${r.title}**`);
  lines.push(`- Status: **${r.ok ? 'OK' : 'FAILED'}**${r.error ? ` — ${r.error}` : ''}`);
  if (r.sourceCourseId) lines.push(`- Source course: \`${r.sourceCourseId}\``);
  if (r.newCourseId) lines.push(`- Target course: \`${r.newCourseId}\``);
  lines.push(`- Lessons: ${r.planned.lessons} · Blocks: ${r.planned.blocks} · ` +
    `Banks: ${r.planned.banks} · Uploads: ${r.planned.uploads} · ` +
    `Draw-from-bank: ${r.planned.drawFromBank}`);
  lines.push(`- Id mappings recorded: ${r.idMappings}`);
  lines.push(
    `- Source media keys surviving (must be 0): **${r.survivingSourceKeys.length}**`,
  );
  if (r.survivingSourceKeys.length) {
    for (const k of r.survivingSourceKeys.slice(0, 10)) lines.push(`  - \`${k}\``);
  }
  if (r.flags.length) {
    lines.push('');
    lines.push(`## Manual handling (${r.flags.length})`);
    for (const f of r.flags) {
      lines.push(`- **${f.kind}**${f.sourceBlockId ? ` block \`${f.sourceBlockId}\`` : ''}` +
        `${f.sourceKey ? ` key \`${f.sourceKey}\`` : ''} — ${f.detail}`);
    }
  } else {
    lines.push('');
    lines.push('## Manual handling');
    lines.push('- none');
  }
  return lines.join('\n');
}
