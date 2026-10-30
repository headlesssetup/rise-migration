// Run-level MANUAL-ACTIONS checklist (mig30oct 2026-10-30). The run CSV lists
// one row per course × item, mixing real work with information; finishing a
// migration meant re-reading it and writing the checklist by hand. This builds
// that checklist: grouped by ACTION (fonts, labels, quiz, Storyline…), each
// course a ticket line with a direct editor link, tiered required → verify.
// Pure + deterministic — tested in manual-actions.test.ts.

import type { ManualFlag } from './executor-types';
import type { ManualWorkItem, RunCsvCourse } from './manual-work';

type Tier = 'required' | 'verify';

/** Items an operator must act on vs. ones they only need to look at. */
const TIER: Partial<Record<ManualFlag['kind'], Tier>> = {
  'builtin-asset': 'verify',
  'orphan-bank': 'verify',
};

/** Where each kind is fixed in Rise — the group heading's "where" hint. */
const WHERE: Partial<Record<ManualFlag['kind'], string>> = {
  typeface: 'Theme → Fonts',
  'label-set': 'Settings → Labels',
  'export-settings': 'Publish → LMS → Tracking',
  storyline: 'the block (Review 360 item)',
  'draw-from-bank': 'the block (question bank)',
  'lesson-link': 'the block (button destination)',
  'locale-selector': 'Settings → Languages',
};

function editorUrl(plane: 'us' | 'eu' | null | undefined, targetCourseId?: string, page = ''): string | null {
  if (!targetCourseId || !plane) return null;
  const host = plane === 'eu' ? 'rise.eu.articulate.com' : 'rise.articulate.com';
  return `https://${host}/authoring/${encodeURIComponent(targetCourseId)}${page}`;
}

function courseLink(c: RunCsvCourse, plane: 'us' | 'eu' | null | undefined, kind?: ManualFlag['kind']): string {
  const name = c.title ?? c.courseId;
  const url = editorUrl(plane, c.targetCourseId, kind === 'export-settings' ? '/export' : '');
  return url ? `[${name}](${url})` : `${name}${c.targetCourseId ? ` (\`${c.targetCourseId}\`)` : ''}`;
}

/** Markdown checklist for one run. Courses without a target id (dry run,
 *  failed) are listed by name only. Returns '' when nothing needs doing. */
export function buildManualActionsMarkdown(
  courses: RunCsvCourse[],
  opts: { plane?: 'us' | 'eu' | null; dryRun?: boolean; generatedAt?: string } = {},
): string {
  const groups = new Map<string, { tier: Tier; where?: string; lines: string[] }>();
  const add = (key: string, tier: Tier, line: string, where?: string): void => {
    const g = groups.get(key) ?? { tier, where, lines: [] };
    g.lines.push(line);
    groups.set(key, g);
  };

  for (const c of courses) {
    // Collapse identical actions per course (e.g. two missing fonts that read
    // the same) — one checkbox per distinct thing to do.
    const seen = new Set<string>();
    for (const m of c.manual as ManualWorkItem[]) {
      const tier = TIER[m.kind] ?? 'required';
      const what = m.location && !m.location.startsWith('Theme') && !m.location.startsWith('Course-level') && !m.location.startsWith('Settings')
        ? `${m.location}: ${m.action}`
        : m.action;
      const sig = `${m.itemType}|${what}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      add(m.itemType, tier, `- [ ] ${courseLink(c, opts.plane, m.kind)} — ${what}`, WHERE[m.kind]);
    }
    for (const issue of c.parity?.issues ?? []) {
      add(
        'Read-back differences (investigate)',
        'required',
        `- [ ] ${courseLink(c, opts.plane)} — \`${issue.path}\`${issue.detail ? `: ${issue.detail}` : ''}`,
      );
    }
    if (c.status === 'failed' || c.status === 'partial' || c.status === 'stopped') {
      add(
        'Courses not fully imported',
        'required',
        `- [ ] ${courseLink(c, opts.plane)} — status **${c.status}**: see \`_import/${c.courseId}.report.md\``,
      );
    }
  }

  if (groups.size === 0) return '';
  const order = (t: Tier): number => (t === 'required' ? 0 : 1);
  const sorted = [...groups.entries()].sort(
    (a, b) => order(a[1].tier) - order(b[1].tier) || b[1].lines.length - a[1].lines.length,
  );
  const out: string[] = [
    `# Manual actions${opts.dryRun ? ' (dry run — predicted)' : ''}`,
    '',
    `${opts.generatedAt ? `Generated ${opts.generatedAt}. ` : ''}One checkbox per thing to do, grouped by action. ` +
      'Informational read-back notes (legacy fields, unused image slots, stale archive ids) are left out — they need nothing.',
  ];
  let tier: Tier | null = null;
  for (const [title, g] of sorted) {
    if (g.tier !== tier) {
      tier = g.tier;
      out.push('', tier === 'required' ? '## Required' : '## Verify (look, fix only if wrong)');
    }
    out.push('', `### ${title} (${g.lines.length})${g.where ? ` — in ${g.where}` : ''}`, '', ...g.lines);
  }
  return out.join('\n') + '\n';
}
