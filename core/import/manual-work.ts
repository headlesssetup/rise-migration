// Phase 3 — manual-work resolver + consolidated run/report output.
//
// The executor emits ManualFlags carrying only ids/keys (sourceBlockId,
// sourceKey). For a human finishing the migration that's unreadable. Here we
// resolve each flag to a real location ("Lesson 2 \"How to Econ\" › block 4
// (Storyline/Mighty)") and a plain-English action, then build:
//   - a brief, human per-course report (markdown), issue-focused, real names;
//   - a noisier per-course machine report (json) that nests parity + the id map;
//   - one run-level CSV listing every course and the manual work remaining.
//
// Pure + deterministic — no network, no ids minted. Tested in manual-work.test.ts.

import type { Block, GetCourseDocument, Lesson } from '@/shared/types/rise';
import { isLocalizedStack, materializeLocale } from '@/core/l10n';
import { orderLessons } from './plan';
import type { ManualFlag } from './executor';
import { blockKey } from './executor-types';
import { fidelityStatus, type FidelityReport } from './fidelity';
import { l10nParityToMarkdown, type L10nParityReport, type ParityReport } from './verify';

/** Where a source block lives, in human (display-order, 1-based) terms. */
export interface BlockLocation {
  lessonNumber: number;
  lessonTitle: string;
  blockNumber: number;
  blockType: string;
}

/** A manual-handling item resolved to human terms (+ structured fields for json/csv). */
export interface ManualWorkItem {
  kind: ManualFlag['kind'];
  /** "Lesson 2 \"How to Econ\" › block 4 (Storyline/Mighty)" / "Theme / fonts" / … */
  location: string;
  /** Friendly category, e.g. "Storyline/Mighty block", "Missing media". */
  itemType: string;
  /** Plain-English instruction for whoever finishes the import. */
  action: string;
  // structured echoes (for the json + csv reference column)
  lessonNumber?: number;
  lessonTitle?: string;
  blockNumber?: number;
  blockType?: string;
  sourceBlockId?: string;
  sourceKey?: string;
}

function lessonTitleOf(l: Lesson): string {
  return typeof l.title === 'string' && l.title ? l.title : (l.id ?? 'untitled');
}

/** A friendly name for a block's family/variant. */
export function blockTypeLabel(b: Block): string {
  const fam = String(b.family ?? '');
  const variant = String(b.variant ?? b.type ?? '');
  const fv = `${fam}/${variant}`;
  if (fv === '360/storyline' || variant === 'storyline') return 'Storyline/Mighty';
  if (fv === 'knowledgeCheck/draw from question bank') return 'Draw-from-bank';
  return fv === '/' ? (b.type ?? 'block') : fv;
}

/** Map lessonId+blockId → BlockLocation using the SAME display ordering the plan
 *  and parity use (`course.lessons` id list, then block order within each
 *  lesson). A blockId-only fallback key is kept for flags without a lessonId,
 *  but only when the blockId is unique across the course (ambiguous → omitted).
 *  Stacks are MATERIALIZED first (F9: a raw stack's lesson title is a
 *  `{l10nId}` ref, which printed as an id instead of the title). */
export function buildBlockIndex(doc: GetCourseDocument): Map<string, BlockLocation> {
  const mat = isLocalizedStack(doc) ? materializeLocale(doc).doc : doc;
  const index = new Map<string, BlockLocation>();
  const byBlockIdOnly = new Map<string, BlockLocation | null>(); // null = ambiguous
  const lessons = orderLessons(
    Array.isArray(mat.lessons) ? mat.lessons : [],
    (mat.course as Record<string, unknown> | undefined)?.lessons,
  );
  lessons.forEach((lesson, li) => {
    const lessonId = typeof lesson.id === 'string' ? lesson.id : '';
    const blocks = (lesson.items ?? []) as Block[];
    blocks.forEach((b, bi) => {
      const id = typeof b.id === 'string' ? b.id : '';
      if (!id) return;
      const loc: BlockLocation = {
        lessonNumber: li + 1,
        lessonTitle: lessonTitleOf(lesson),
        blockNumber: bi + 1,
        blockType: blockTypeLabel(b),
      };
      index.set(blockKey(lessonId, id), loc);
      byBlockIdOnly.set(id, byBlockIdOnly.has(id) ? null : loc);
    });
  });
  for (const [id, loc] of byBlockIdOnly) {
    if (loc && !index.has(id)) index.set(id, loc);
  }
  return index;
}

/** Last path segment of an S3 key, with Rise's double-encoding undone (best-effort)
 *  so `…-seperator%2520(5).svg` reads as `seperator (5).svg`. */
export function prettyFilename(key: string): string {
  let name = key.split('/').pop() ?? key;
  // Drop the leading random id prefix Rise prepends (e.g. `64EwqLFGVG84dOlK-`).
  name = name.replace(/^[A-Za-z0-9_-]{12,}-/, '');
  for (let i = 0; i < 2; i++) {
    try {
      const dec = decodeURIComponent(name);
      if (dec === name) break;
      name = dec;
    } catch {
      break;
    }
  }
  return name;
}

function describe(kind: ManualFlag['kind'], file: string): { itemType: string; action: string } {
  switch (kind) {
    case 'storyline':
      return {
        itemType: 'Storyline/Mighty block',
        action:
          'Rebuild this block manually — a placeholder was imported; attach the Review 360 item in the Rise editor.',
      };
    case 'draw-from-bank':
      return {
        itemType: 'Draw-from-bank block',
        action: 'Attach a question bank to this draw-from-bank block.',
      };
    case 'orphan-media':
      return {
        itemType: 'Missing media',
        action: `Re-add the media "${file}" — it was deleted at the source, so it could not be migrated.`,
      };
    case 'unsupported-media':
      return {
        itemType: 'Media not migrated',
        action: `Upload this media manually: "${file}".`,
      };
    case 'missing-bank-ref':
      return {
        itemType: 'Unresolved question bank',
        action: 'Could not find the source question bank for this block — attach the correct bank manually.',
      };
    case 'orphan-bank':
      return {
        itemType: 'Empty question bank',
        action: 'An empty question bank was left on the target — finish populating it or remove it manually.',
      };
    case 'title':
      return { itemType: 'Course title', action: 'Set the course title manually in the Rise editor.' };
    case 'typeface':
      return { itemType: 'Missing font', action: 'Provision or select this font manually on the target account.' };
    case 'locale-selector':
      return {
        itemType: 'Language selector',
        action:
          'Enable the learner language selector manually (the source course shows it; the toggle has no captured envelope yet).',
      };
    case 'builtin-asset':
      return {
        itemType: 'Built-in Rise asset',
        action:
          'A Rise library/CDN image (theme cover, sample-course art, block default) was copied as-is because there is nothing to re-upload, but the target plane is not confirmed to serve it. Open the course and check the image; if it is missing, pick a replacement or upload the file as course media.',
      };
    case 'l10n-storyline':
      return {
        itemType: 'Storyline in a multi-language course',
        action:
          'This block\u2019s Storyline package is language-specific in the source. Attach it in Review 360 for each language listed \u2014 the source package reference was deliberately not copied (it points at the source account).',
      };
    case 'l10n-ref':
      return {
        itemType: 'Localized course field',
        action:
          'A course-level localized value (e.g. cover/logo/description) had no counterpart on the target — set it manually in each language.',
      };
    case 'l10n-locale':
      return {
        itemType: 'Untransferable language data',
        action:
          'The source holds translation data for a language that is archived (or has no locale row), so the target cannot have it. To migrate it, restore the language on the source course, re-export, and re-import.',
      };
    default:
      return { itemType: String(kind), action: 'Manual handling required.' };
  }
}

function categoryLocation(kind: ManualFlag['kind']): string {
  if (kind === 'title') return 'Course-level';
  if (kind === 'typeface') return 'Theme / fonts';
  if (kind === 'orphan-bank') return 'Question banks';
  if (
    kind === 'locale-selector' ||
    kind === 'l10n-ref' ||
    kind === 'l10n-storyline' ||
    kind === 'l10n-locale'
  ) {
    return 'Languages';
  }
  if (kind === 'builtin-asset') return 'Built-in assets';
  return 'Course-level';
}

/** Resolve executor flags into human manual-work items. */
export function resolveManualWork(
  flags: ManualFlag[],
  index: Map<string, BlockLocation>,
): ManualWorkItem[] {
  return flags.map((f) => {
    const file = f.sourceKey ? prettyFilename(f.sourceKey) : '';
    const { itemType, action } = describe(f.kind, file);
    // Prefer the unambiguous lessonId+blockId key (F9); fall back to the
    // blockId-only key (set only when the id is unique across the course).
    const loc = f.sourceBlockId
      ? (f.sourceLessonId ? index.get(blockKey(f.sourceLessonId, f.sourceBlockId)) : undefined) ??
        index.get(f.sourceBlockId)
      : undefined;
    let location: string;
    if (loc) {
      location = `Lesson ${loc.lessonNumber} "${loc.lessonTitle}" › block ${loc.blockNumber} (${loc.blockType})`;
    } else if (f.sourceBlockId) {
      location = `block ${f.sourceBlockId}`;
    } else {
      location = categoryLocation(f.kind);
    }
    return {
      kind: f.kind,
      location,
      itemType,
      action,
      lessonNumber: loc?.lessonNumber,
      lessonTitle: loc?.lessonTitle,
      blockNumber: loc?.blockNumber,
      blockType: loc?.blockType,
      sourceBlockId: f.sourceBlockId,
      sourceKey: f.sourceKey,
    };
  });
}

function parityLine(parity?: ParityReport): string {
  if (!parity) return 'not verified';
  if (parity.ok) {
    const exp = parity.expectedDivergences.length;
    return `OK ${parity.blocks.compared}/${parity.blocks.source}${exp ? ` (${exp} expected)` : ''}`;
  }
  return `DIVERGENCES — ${parity.issues.length} unexpected`;
}

/** The truthful pending-translation read-back (F5): the SET of pending
 *  (l10nId, locale) entries from `…/translations/updates`, not a count. */
export interface PendingSetReport {
  count: number;
  /** "l10nId locale" keys (first ~50 kept for the report). */
  keys: string[];
  /** The decorative badge tally the endpoint also returns (segment-ish). */
  updateCount: number | null;
  inProgress: boolean;
}

/** Brief, human, issue-focused per-course report. Uses real names. */
export function buildCourseReportMarkdown(args: {
  report: FidelityReport;
  parity?: ParityReport;
  /** Multi-language stack: translation-table parity + the standing warning. */
  l10nParity?: L10nParityReport;
  /** Per-language `pendingChangesCount` (stackItems) — LAZY and segment-ish;
   *  recorded as decoration only, never compared (F5). */
  l10nPending?: Record<string, number>;
  /** The truth: the pending SET read from `…/translations/updates`. After a
   *  full-course-first import the expected set is EMPTY (the conversion stamps
   *  every cell; we never touch a default row after it). */
  l10nPendingSet?: PendingSetReport;
  /** Default-only TEXT cells (l10nId per locale) where the conversion's AI text
   *  PERSISTS on the target (the source serves those locales by default-language
   *  fallback; media lands in the source's exact state, text cannot). */
  aiTextCells?: string[];
  manual: ManualWorkItem[];
}): string {
  const { report: r, parity, l10nParity, l10nPending, l10nPendingSet, aiTextCells, manual } = args;
  const status = fidelityStatus(r);
  const resumable = status === 'PARTIAL' || status === 'STOPPED';
  const lines: string[] = [];
  lines.push(`# ${r.title ?? r.sourceCourseId ?? 'Course'} — ${status}${resumable ? ' (resumable — re-run to continue)' : ''}`);
  if (r.error) lines.push(`- Error: ${r.error}`);
  lines.push(
    `- Source \`${r.sourceCourseId ?? '—'}\` → Target \`${r.newCourseId ?? '—'}\``,
  );
  lines.push(
    `- Lessons: ${r.planned.lessons} · Blocks: ${r.planned.blocks} · Parity: ${parityLine(parity)}`,
  );
  lines.push(`- Source media keys surviving (must be 0): ${r.survivingSourceKeys.length}`);
  for (const k of r.survivingSourceKeys.slice(0, 10)) lines.push(`  - \`${k}\``);
  if (r.orphanedCourseId) {
    lines.push(`- Orphaned shell left in place (delete manually if needed): \`${r.orphanedCourseId}\``);
  }

  lines.push('');
  if (manual.length) {
    lines.push(`## Manual work (${manual.length})`);
    for (const m of manual) lines.push(`- **${m.location}** — ${m.itemType}: ${m.action}`);
  } else {
    lines.push('## Manual work');
    lines.push('- none — nothing left to do');
  }

  if (parity && !parity.ok && parity.issues.length) {
    lines.push('');
    lines.push(`## Parity divergences (${parity.issues.length})`);
    for (const x of parity.issues.slice(0, 25)) {
      lines.push(`- [${x.kind}] ${x.path}${x.detail ? ` — ${x.detail}` : ''}`);
    }
  }

  if (l10nParity) {
    lines.push('');
    lines.push(l10nParityToMarkdown(l10nParity));
    if (l10nPendingSet) {
      if (l10nPendingSet.count === 0) {
        lines.push(
          '- Pending translations: **0** — the conversion stamped every cell and no default row ' +
            'was written after it. "Update translation" would find nothing to do.',
        );
      } else {
        lines.push(
          `- ⚠ Pending translations: **${l10nPendingSet.count} cell(s)**` +
            `${l10nPendingSet.updateCount !== null ? ` (badge tally ${l10nPendingSet.updateCount} — segment-ish, ignore)` : ''}` +
            ' — expected 0 after this import shape. The signal can also materialize LAZILY,' +
            ' so re-check Manage languages later; investigate before any AI run.',
        );
        for (const k of l10nPendingSet.keys.slice(0, 15)) lines.push(`  - \`${k}\``);
        if (l10nPendingSet.count > 15) lines.push(`  - … ${l10nPendingSet.count - 15} more`);
        lines.push(
          '> ⚠ Do **not** click "Update translation" while cells are pending — it would ' +
            'AI-overwrite exactly those cells. Resolve/understand the list first.',
        );
      }
      if (l10nPendingSet.inProgress) {
        lines.push('- ⚠ A translation run was IN PROGRESS at read-back — re-check when it settles.');
      }
    }
    if (l10nPending && Object.keys(l10nPending).length) {
      lines.push(
        `- (decorative) per-language pendingChangesCount at read-back: ${Object.entries(l10nPending)
          .map(([c, n]) => `${c}: ${n}`)
          .join(' · ')} — lazy + segment-based, never compared (F5).`,
      );
    }
    if (aiTextCells?.length) {
      lines.push(
        `- AI text persists in ${aiTextCells.length} default-only TEXT cell(s) (the source serves ` +
          'these languages by default-language fallback; the conversion translated them). Review or ' +
          'leave as-is:',
      );
      for (const k of aiTextCells.slice(0, 15)) lines.push(`  - \`${k}\``);
      if (aiTextCells.length > 15) lines.push(`  - … ${aiTextCells.length - 15} more`);
    }
  }
  return lines.join('\n');
}

/** Noisier machine report: the fidelity report + parity + resolved manual work +
 *  the resumable id map, all in ONE json (replaces the separate joblog file). */
export function buildCourseReportJson(args: {
  report: FidelityReport;
  parity?: ParityReport;
  l10nParity?: L10nParityReport;
  l10nPending?: Record<string, number>;
  l10nPendingSet?: PendingSetReport;
  aiTextCells?: string[];
  manual: ManualWorkItem[];
  idMap: Record<string, string>;
}): string {
  return JSON.stringify(
    {
      ...args.report,
      parity: args.parity ?? null,
      l10nParity: args.l10nParity ?? null,
      l10nPending: args.l10nPending ?? null,
      l10nPendingSet: args.l10nPendingSet ?? null,
      aiTextCells: args.aiTextCells ?? null,
      manualWork: args.manual,
      idMap: args.idMap,
    },
    null,
    2,
  );
}

// --- Run-level CSV ----------------------------------------------------------

export interface RunCsvCourse {
  title?: string;
  /** Source course id. */
  courseId: string;
  targetCourseId?: string;
  status: string;
  manual: ManualWorkItem[];
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const RUN_CSV_HEADER = ['Course', 'Status', 'Target course', 'Location', 'Issue', 'What to do', 'Reference'];

function statusGuidance(status: string): { issue: string; action: string } {
  switch (status) {
    case 'imported':
      return { issue: '(none)', action: 'Nothing to do' };
    case 'planned':
      return { issue: '(dry run)', action: 'Run live to import' };
    case 'partial':
      return { issue: 'Partially imported', action: 'Re-run to continue (resumable)' };
    case 'stopped':
      return { issue: 'Stopped mid-course', action: 'Re-run to continue (resumable)' };
    case 'failed':
      return { issue: 'Failed', action: 'Investigate and re-run' };
    case 'not-started':
      return { issue: 'Not started', action: 'Re-run to import' };
    default:
      return { issue: status, action: 'Review' };
  }
}

/** One CSV for the whole run: a row per manual item, plus a summary row for any
 *  course with no manual work (so every course is accounted for). */
export function buildRunCsv(courses: RunCsvCourse[]): string {
  const rows: string[][] = [RUN_CSV_HEADER];
  for (const c of courses) {
    const name = c.title ?? c.courseId;
    const tgt = c.targetCourseId ?? '';
    if (c.manual.length === 0) {
      const g = statusGuidance(c.status);
      rows.push([name, c.status, tgt, '', g.issue, g.action, c.courseId]);
      continue;
    }
    for (const m of c.manual) {
      const ref = m.sourceKey ?? m.sourceBlockId ?? c.courseId;
      rows.push([name, c.status, tgt, m.location, m.itemType, m.action, ref]);
    }
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}
