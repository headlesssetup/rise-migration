// Stage A of the Storyline pipeline: OFFLINE archive scan + the inventory
// importability column — split out of storyline.ts (v0.9.0 restructure;
// storyline.ts re-exports this surface, so './storyline' and the orchestrator
// barrel are unchanged). No network, no Rise tab.

import type { Storage } from '@/core/storage/storage';
import { findStorylineBlocks, type StorylineBlockRef } from '@/core/storyline/detect';
import {
  isKnownLegacyStorylineMeta,
  LEGACY_STORYLINE_IMPORTABILITY,
} from '@/core/storyline/compatibility';
import {
  inventoryToCsv,
  inventoryToJson,
  withImportability,
  type InventoryRow,
} from '@/core/census/inventory';
import { unwrap, type ProgressEvent } from './shared';

export interface StorylineCourseScan {
  courseId: string;
  title?: string;
  blocks: StorylineBlockRef[];
  /** Packages in the capture-confirmed legacy-incompatible generation. */
  legacyBlocks: StorylineBlockRef[];
}

/** Read `course.title` from a saved doc, tolerant of nesting. */
function courseTitle(doc: unknown): string | undefined {
  const c = (doc as { course?: { title?: unknown } })?.course;
  return typeof c?.title === 'string' ? c.title : undefined;
}

/**
 * OFFLINE scan: which saved courses contain Storyline blocks. Drives the
 * Export-D inventory display + the export work-list. Per-course [i/N] progress.
 */
export async function scanSavedCoursesForStoryline(
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
  /** Restrict the scan to these course ids (the operator's selection). When
   *  omitted, scans every saved course. */
  onlyCourseIds?: Set<string>,
): Promise<StorylineCourseScan[]> {
  const saved = await storage.listSaved();
  const ids = onlyCourseIds ? saved.filter((id) => onlyCourseIds.has(id)) : saved;
  onEvent({
    kind: 'log',
    message: onlyCourseIds
      ? `Scanning ${ids.length} selected course(s) for Storyline blocks…`
      : `Scanning ${ids.length} saved course(s) for Storyline blocks…`,
  });
  const out: StorylineCourseScan[] = [];
  for (let i = 0; i < ids.length; i++) {
    const courseId = ids[i]!;
    const raw = await storage.readCourse(courseId);
    if (!raw) continue;
    let doc: unknown;
    try {
      doc = unwrap(raw);
    } catch {
      onEvent({ kind: 'log', message: `[${i + 1}/${ids.length}] ${courseId}: unreadable, skipped` });
      continue;
    }
    const blocks = findStorylineBlocks(doc);
    if (blocks.length) {
      const legacyBlocks = blocks.filter((block) => isKnownLegacyStorylineMeta(block.meta));
      out.push({ courseId, title: courseTitle(doc), blocks, legacyBlocks });
      onEvent({
        kind: 'log',
        // A STACK yields one ref PER LANGUAGE for the same block (each language
        // can carry its own package), so count distinct blocks separately from
        // the per-language packages — "2 blocks" for a 1-block stack misleads.
        message:
          `[${i + 1}/${ids.length}] ${courseTitle(doc) ?? courseId}: ` +
          `${new Set(blocks.map((b) => b.blockId)).size} storyline block(s)` +
          (blocks.some((b) => b.locale)
            ? `, ${blocks.filter((b) => b.locale).length} language-specific package(s)`
            : '') +
          (legacyBlocks.length
            ? `; ⚠ ${legacyBlocks.length} legacy package(s) require manual replacement`
            : ''),
      });
    }
  }
  onEvent({
    kind: 'log',
    message: `Storyline scan: ${out.length}/${ids.length} course(s) contain storyline blocks.`,
  });
  return out;
}

function inventoryRows(raw: string): InventoryRow[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const value = Array.isArray(parsed)
      ? parsed
      : (parsed as { items?: unknown } | null)?.items;
    return Array.isArray(value)
      ? value.filter(
          (row): row is InventoryRow =>
            !!row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

/** Fold the content-aware legacy finding into the general course inventory. */
export async function updateStorylineImportability(
  storage: Storage,
  scans: StorylineCourseScan[],
  onEvent: (e: ProgressEvent) => void,
): Promise<void> {
  if (
    typeof storage.readInventory !== 'function' ||
    typeof storage.writeInventory !== 'function'
  ) return;
  const raw = await storage.readInventory();
  // Inventory writes are operator-explicit since v0.9.0 — a missing inventory
  // is a real possibility, and a silent no-op here would drop the legacy
  // flags without a trace.
  if (!raw) {
    onEvent({
      kind: 'log',
      message:
        'No saved inventory — legacy-Storyline flags not recorded. Save the course list (Export Data → C) and re-run D to record them.',
    });
    return;
  }
  const rows = inventoryRows(raw);
  if (!rows.length) return;
  const existingById = new Map(rows.map((row) => [row.id, row.importability ?? '']));
  const comments = new Map(
    scans.map((scan) => {
      const existing = existingById.get(scan.courseId) ?? '';
      if (scan.legacyBlocks.length) {
        return [
          scan.courseId,
          existing.includes(LEGACY_STORYLINE_IMPORTABILITY)
            ? existing
            : [existing, LEGACY_STORYLINE_IMPORTABILITY].filter(Boolean).join(' | '),
        ];
      }
      return [
        scan.courseId,
        existing
          .replace(` | ${LEGACY_STORYLINE_IMPORTABILITY}`, '')
          .replace(`${LEGACY_STORYLINE_IMPORTABILITY} | `, '')
          .replace(LEGACY_STORYLINE_IMPORTABILITY, ''),
      ];
    }),
  );
  const updated = withImportability(rows, comments);
  await storage.writeInventory(inventoryToJson(updated), inventoryToCsv(updated));
  const affected = scans.filter((scan) => scan.legacyBlocks.length).length;
  onEvent({
    kind: 'log',
    message: `Inventory importability updated: ${affected} course(s) flagged for legacy Storyline manual review.`,
  });
}
