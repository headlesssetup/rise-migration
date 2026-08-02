// Read-back verifiers for the NON-course surfaces (STATUS: "read-back coverage
// audit"). Courses are verified by verify.ts (3 stages); these close the gaps
// where the import previously trusted the write response alone:
//
//   - question banks   → GET the bank back, compare title + questions
//   - folders          → re-list the tree, confirm every mapped folder exists
//   - typeface identity→ resolve binding slots to FONT NAMES on both sides
//                        (course.typefaces maps id → name in every GET_COURSE)
//
// All pure: the orchestrator supplies the fetched documents. Comparisons reuse
// verify.ts's canonicalize so remapped ids never read as divergences.

import type { GetCourseDocument } from '@/shared/types/rise';
import { canonicalize } from './verify';
import type { SourceBank } from './plan';

export interface ReadbackIssue {
  kind:
    | 'bank-title-changed'
    | 'bank-question-count'
    | 'bank-question-changed'
    | 'folder-missing'
    | 'folder-renamed'
    | 'typeface-binding-changed'
    | 'typeface-unresolved';
  path: string;
  detail: string;
}

export interface ReadbackReport {
  ok: boolean;
  issues: ReadbackIssue[];
}

// --- Question banks ----------------------------------------------------------

/**
 * Compare an archived source bank to the bank read back from the target after
 * the PUT. Questions are canonicalized (client ids → #id, media → tokens), and
 * compared IN ORDER — bank question order is authored order and must survive.
 */
export function verifyBankParity(source: SourceBank, target: unknown): ReadbackReport {
  const issues: ReadbackIssue[] = [];
  const t = (target ?? {}) as Record<string, unknown>;
  const label = source.title ?? source.id;

  const tTitle = typeof t.title === 'string' ? t.title : '';
  if ((source.title ?? '') !== tTitle) {
    issues.push({
      kind: 'bank-title-changed',
      path: `bank "${label}"`,
      detail: `title "${source.title ?? ''}" → "${tTitle}"`,
    });
  }

  const sq = Array.isArray(source.questions) ? source.questions : [];
  const tq = Array.isArray(t.questions) ? (t.questions as unknown[]) : [];
  if (sq.length !== tq.length) {
    issues.push({
      kind: 'bank-question-count',
      path: `bank "${label}"`,
      detail: `${sq.length} question(s) in the archive, ${tq.length} on the target`,
    });
  }
  const n = Math.min(sq.length, tq.length);
  for (let i = 0; i < n; i++) {
    const a = JSON.stringify(canonicalize(sq[i]));
    const b = JSON.stringify(canonicalize(tq[i]));
    if (a !== b) {
      issues.push({
        kind: 'bank-question-changed',
        path: `bank "${label}" question ${i + 1}`,
        detail: `content differs after canonicalization`,
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

// --- Folders -----------------------------------------------------------------

export interface FolderRow {
  id: string;
  name?: string;
  parentFolderId?: string | null;
}

/**
 * Confirm every source→target folder mapping against a FRESH listing of the
 * target tree: the target folder must exist, and its name must match the source
 * folder's (folders are created by name). Root/pseudo targets ('all', 'private',
 * '' or null) are placement defaults, not created folders — skipped.
 */
export function verifyFolderMap(
  folderIdMap: ReadonlyMap<string, string>,
  sourceFolders: FolderRow[],
  targetListing: FolderRow[],
): ReadbackReport {
  const issues: ReadbackIssue[] = [];
  const srcById = new Map(sourceFolders.map((f) => [f.id, f]));
  const tgtById = new Map(targetListing.map((f) => [f.id, f]));
  const PSEUDO = new Set(['', 'all', 'private', 'shared']);

  for (const [srcId, tgtId] of folderIdMap) {
    if (!tgtId || PSEUDO.has(tgtId)) continue;
    const src = srcById.get(srcId);
    const name = src?.name ?? srcId;
    const tgt = tgtById.get(tgtId);
    if (!tgt) {
      issues.push({
        kind: 'folder-missing',
        path: `folder "${name}"`,
        detail: `mapped target folder ${tgtId} is not in the target listing`,
      });
      continue;
    }
    if (src?.name && tgt.name && src.name !== tgt.name) {
      issues.push({
        kind: 'folder-renamed',
        path: `folder "${name}"`,
        detail: `target folder ${tgtId} is named "${tgt.name}"`,
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

// --- Typeface identity -------------------------------------------------------

const TYPEFACE_SLOTS = ['headingTypefaceId', 'bodyTypefaceId', 'uiTypefaceId'] as const;

function typefaceName(course: Record<string, unknown>, slot: string): string | null {
  const id = course[slot];
  if (typeof id !== 'string' || !id) return null;
  const map = course.typefaces;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    const name = (map as Record<string, unknown>)[id];
    if (typeof name === 'string' && name) return name;
  }
  return null; // bound to an id the course's own typeface map can't name
}

/**
 * Compare the three binding slots by FONT NAME (ids are remapped, names must
 * survive). A slot the source leaves unbound is skipped. `flaggedTypefaces`
 * (the import's `typeface` manual flags) downgrades a divergence to expected —
 * the operator was already told that font could not be migrated.
 */
export function verifyTypefaceBindings(
  source: GetCourseDocument,
  target: GetCourseDocument,
  flaggedTypefaces = false,
): ReadbackReport & { expected: ReadbackIssue[] } {
  const issues: ReadbackIssue[] = [];
  const expected: ReadbackIssue[] = [];
  const sc = (source.course ?? {}) as Record<string, unknown>;
  const tc = (target.course ?? {}) as Record<string, unknown>;
  for (const slot of TYPEFACE_SLOTS) {
    const sName = typefaceName(sc, slot);
    if (!sName) continue; // source unbound or unnameable — nothing to hold the target to
    const tName = typefaceName(tc, slot);
    if (!tName) {
      (flaggedTypefaces ? expected : issues).push({
        kind: 'typeface-unresolved',
        path: `course.${slot}`,
        detail: `source font "${sName}" — target binding missing or not in course.typefaces`,
      });
      continue;
    }
    if (sName.trim().toLowerCase() !== tName.trim().toLowerCase()) {
      (flaggedTypefaces ? expected : issues).push({
        kind: 'typeface-binding-changed',
        path: `course.${slot}`,
        detail: `font "${sName}" → "${tName}"`,
      });
    }
  }
  return { ok: issues.length === 0, issues, expected };
}
