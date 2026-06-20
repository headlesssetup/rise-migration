// Phase 3 — the import PLAN: a deterministic, ordered list of write-step intents
// derived from a source archive. The same plan drives the DRY-RUN preview and the
// live executor (one source of ordering truth). Step ordering follows
// docs/rise-import-protocol.md §1: banks → course shell → theme → title →
// (per lesson) create → update → lock → (per block) create → media upload+patch
// or draw-from-bank bind → unlock.

import { collectAssetKeys } from '@/core/assets/keys';
import type { GetCourseDocument, Lesson, Block } from '@/shared/types/rise';

/** One source asset, as recorded in `courses/<id>.assets.json` (+ orphan flag). */
export interface AssetEntry {
  key: string;
  kind: string;
  /** Archive path `assets/<hash>.<ext>` — absent for orphaned keys. */
  file?: string;
  ext?: string;
  /** 403/404 at source (assets-summary `orphaned`): no bytes to upload. */
  orphaned?: boolean;
}

/** A referenced reusable question bank (from `question-banks/<id>.json`). */
export interface SourceBank {
  id: string;
  title?: string;
  questions?: unknown[];
  folder_id?: string | null;
}

export interface PlanInput {
  /** Parsed GET_COURSE payload: `{course, lessons}`. */
  course: GetCourseDocument;
  /** The course's asset manifest entries (downloaded + orphaned). */
  assets: AssetEntry[];
  /** Banks referenced by draw-from-bank blocks, keyed by source bank id. */
  banksById: Map<string, SourceBank>;
  /** Target account user id (author of created lessons/locks). */
  author: string;
  /** Mapped target folder id for the course, or null/'all' for the root. */
  targetFolderId?: string | null;
}

export type PlanStep =
  | { kind: 'create-bank'; sourceBankId: string; title: string; summary: string }
  | { kind: 'put-bank'; sourceBankId: string; questionCount: number; summary: string }
  | { kind: 'create-course'; sourceCourseId: string; title: string; summary: string }
  | { kind: 'set-theme'; sourceCourseId: string; summary: string }
  | { kind: 'set-title'; sourceCourseId: string; title: string; summary: string }
  | {
      kind: 'create-lesson';
      sourceLessonId: string;
      position: number;
      title: string;
      lessonType: string | null;
      summary: string;
    }
  | {
      kind: 'update-lesson';
      sourceLessonId: string;
      lessonType: string;
      icon: string | null;
      summary: string;
    }
  | { kind: 'lock-lesson'; sourceLessonId: string; summary: string }
  | {
      kind: 'create-block';
      sourceLessonId: string;
      sourceBlockId: string;
      family: string;
      variant: string;
      previousSourceBlockId: string | null;
      summary: string;
    }
  | {
      kind: 'bind-draw-from-bank';
      sourceLessonId: string;
      sourceBlockId: string;
      sourceBankId: string | null;
      drawCount: number;
      questionDrawType: string;
      summary: string;
    }
  | {
      kind: 'upload-asset';
      sourceLessonId: string;
      sourceBlockId: string;
      sourceKey: string;
      mediaKind: string;
      filename: string;
      summary: string;
    }
  | {
      kind: 'patch-block-media';
      sourceLessonId: string;
      sourceBlockId: string;
      sourceKeys: string[];
      summary: string;
    }
  | { kind: 'unlock-lesson'; sourceLessonId: string; summary: string }
  | {
      kind: 'flag-storyline';
      sourceLessonId: string;
      sourceBlockId: string;
      summary: string;
    }
  | {
      kind: 'flag-orphan-media';
      sourceLessonId: string;
      sourceBlockId: string;
      sourceKey: string;
      summary: string;
    };

const STORYLINE = new Set(['360/storyline']);
const DRAW_FROM_BANK = 'knowledgeCheck/draw from question bank';

function lessonTitle(l: Lesson): string {
  return typeof l.title === 'string' ? l.title : (l.id ?? 'untitled');
}

function fileBasename(key: string): string {
  return key.split('/').pop() || 'asset';
}

/** Is this block a Storyline / Mighty block (conditional, flagged manual)? */
function isStoryline(b: Block): boolean {
  return STORYLINE.has(`${b.family}/${b.variant}`) || b.variant === 'storyline';
}

function isDrawFromBank(b: Block): boolean {
  return `${b.family}/${b.variant}` === DRAW_FROM_BANK;
}

/** Best-effort extraction of the source bank id referenced by a draw-from-bank
 *  block. ⚠️ Field name unconfirmed against an export fixture (protocol §4b);
 *  we probe the documented/likely locations and return null if none found (the
 *  executor loud-fails rather than guessing a bank). */
export function findBankRef(b: Block): {
  bankId: string | null;
  drawCount: number;
  questionDrawType: string;
} {
  const probe = (o: unknown): string | null => {
    if (!o || typeof o !== 'object') return null;
    const r = o as Record<string, unknown>;
    for (const k of ['questionBankId', 'bankId', 'questionBankID', 'bank_id']) {
      if (typeof r[k] === 'string') return r[k] as string;
    }
    return null;
  };
  let bankId = probe(b);
  let drawCount = typeof (b as Record<string, unknown>).drawCount === 'number'
    ? ((b as Record<string, unknown>).drawCount as number)
    : 1;
  let questionDrawType =
    typeof (b as Record<string, unknown>).questionDrawType === 'string'
      ? ((b as Record<string, unknown>).questionDrawType as string)
      : 'random';
  for (const it of (b.items ?? []) as Record<string, unknown>[]) {
    bankId = bankId ?? probe(it);
    if (typeof it.drawCount === 'number') drawCount = it.drawCount;
    if (typeof it.questionDrawType === 'string') {
      questionDrawType = it.questionDrawType;
    }
  }
  return { bankId, drawCount, questionDrawType };
}

/**
 * Build the ordered import plan. Pure + deterministic — no ids minted, no
 * network. (Server-assigned ids are resolved at execution time.)
 */
export function buildPlan(input: PlanInput): PlanStep[] {
  const steps: PlanStep[] = [];
  const course = input.course.course ?? {};
  const sourceCourseId = typeof course.id === 'string' ? course.id : 'course';
  const title = typeof course.title === 'string' ? course.title : sourceCourseId;
  const lessons = Array.isArray(input.course.lessons) ? input.course.lessons : [];

  const assetByKey = new Map(input.assets.map((a) => [a.key, a]));

  // Which banks are actually referenced by draw-from-bank blocks (dedup).
  const referencedBanks = new Set<string>();
  for (const l of lessons) {
    for (const b of (l.items ?? []) as Block[]) {
      if (isDrawFromBank(b)) {
        const { bankId } = findBankRef(b);
        if (bankId) referencedBanks.add(bankId);
      }
    }
  }

  // 1. Banks first (a draw-from-bank block needs the new bank id).
  for (const bankId of referencedBanks) {
    const bank = input.banksById.get(bankId);
    const bTitle = bank?.title ?? bankId;
    const qCount = Array.isArray(bank?.questions) ? bank!.questions!.length : 0;
    steps.push({
      kind: 'create-bank',
      sourceBankId: bankId,
      title: bTitle,
      summary: `Create question bank "${bTitle}"`,
    });
    steps.push({
      kind: 'put-bank',
      sourceBankId: bankId,
      questionCount: qCount,
      summary: `Write ${qCount} question(s) to bank "${bTitle}"`,
    });
  }

  // 2. Course shell → theme → title.
  steps.push({
    kind: 'create-course',
    sourceCourseId,
    title,
    summary: `Create course "${title}"`,
  });
  if (course.theme && typeof course.theme === 'object') {
    steps.push({
      kind: 'set-theme',
      sourceCourseId,
      summary: 'Apply course theme (verbatim round-trip)',
    });
  }
  steps.push({
    kind: 'set-title',
    sourceCourseId,
    title,
    summary: `Set course title "${title}"`,
  });

  // 3. Lessons in ascending position; blocks chained by previousBlockId.
  const ordered = [...lessons].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  );
  ordered.forEach((lesson, idx) => {
    const sourceLessonId = typeof lesson.id === 'string' ? lesson.id : `lesson-${idx}`;
    const lType = typeof lesson.type === 'string' ? lesson.type : 'blocks';
    const icon = typeof lesson.icon === 'string' ? lesson.icon : null;
    const lTitle = lessonTitle(lesson);

    steps.push({
      kind: 'create-lesson',
      sourceLessonId,
      position: typeof lesson.position === 'number' ? lesson.position : idx,
      title: lTitle,
      lessonType: lType === 'section' ? 'section' : null, // type set on update
      summary: `Create lesson "${lTitle}" (${lType})`,
    });
    steps.push({
      kind: 'update-lesson',
      sourceLessonId,
      lessonType: lType,
      icon,
      summary: `Configure lesson "${lTitle}" (type=${lType})`,
    });
    // A `section` (module header) has no blocks — skip the lock/block churn.
    const blocks = (lesson.items ?? []) as Block[];
    if (lType === 'section' || blocks.length === 0) return;

    steps.push({
      kind: 'lock-lesson',
      sourceLessonId,
      summary: `Lock lesson "${lTitle}" for editing`,
    });

    let prev: string | null = null;
    for (const block of blocks) {
      const sourceBlockId = typeof block.id === 'string' ? block.id : '';
      const family = String(block.family ?? '');
      const variant = String(block.variant ?? '');

      if (isStoryline(block)) {
        // Created empty + flagged manual (Review-360 reachability, §9).
        steps.push({
          kind: 'create-block',
          sourceLessonId,
          sourceBlockId,
          family,
          variant,
          previousSourceBlockId: prev,
          summary: `Create block ${family}/${variant}`,
        });
        steps.push({
          kind: 'flag-storyline',
          sourceLessonId,
          sourceBlockId,
          summary: `⚠ Storyline/Mighty block needs manual Review-360 attach`,
        });
        prev = sourceBlockId;
        continue;
      }

      steps.push({
        kind: 'create-block',
        sourceLessonId,
        sourceBlockId,
        family,
        variant,
        previousSourceBlockId: prev,
        summary: `Create block ${family}/${variant}`,
      });

      if (isDrawFromBank(block)) {
        const { bankId, drawCount, questionDrawType } = findBankRef(block);
        steps.push({
          kind: 'bind-draw-from-bank',
          sourceLessonId,
          sourceBlockId,
          sourceBankId: bankId,
          drawCount,
          questionDrawType,
          summary: bankId
            ? `Bind draw-from-bank → bank ${bankId} (draw ${drawCount})`
            : `⚠ draw-from-bank block missing a bank reference`,
        });
        prev = sourceBlockId;
        continue;
      }

      // Uploaded media on this block → upload + patch (or flag orphans).
      const keys = collectAssetKeys(block, sourceCourseId);
      const uploadable: string[] = [];
      for (const ak of keys) {
        const entry = assetByKey.get(ak.key);
        if (entry?.orphaned || (entry && !entry.file)) {
          steps.push({
            kind: 'flag-orphan-media',
            sourceLessonId,
            sourceBlockId,
            sourceKey: ak.key,
            summary: `⚠ Orphaned media (deleted at source): ${ak.key}`,
          });
          continue;
        }
        steps.push({
          kind: 'upload-asset',
          sourceLessonId,
          sourceBlockId,
          sourceKey: ak.key,
          mediaKind: ak.kind,
          filename: fileBasename(ak.key),
          summary: `Upload ${ak.kind} ${fileBasename(ak.key)}`,
        });
        uploadable.push(ak.key);
      }
      if (uploadable.length > 0) {
        steps.push({
          kind: 'patch-block-media',
          sourceLessonId,
          sourceBlockId,
          sourceKeys: uploadable,
          summary: `Patch block media (${uploadable.length} key(s))`,
        });
      }
      prev = sourceBlockId;
    }

    steps.push({
      kind: 'unlock-lesson',
      sourceLessonId,
      summary: `Unlock lesson "${lTitle}"`,
    });
  });

  return steps;
}

/** A flat, human-readable preview of the plan (the dry-run output). */
export function summarizePlan(steps: PlanStep[]): string[] {
  return steps.map((s, i) => `${String(i + 1).padStart(3, ' ')}. ${s.summary}`);
}

/** Plan rollup for the dry-run header + fidelity preview. */
export interface PlanStats {
  total: number;
  banks: number;
  lessons: number;
  blocks: number;
  uploads: number;
  storylineFlags: number;
  orphanFlags: number;
  drawFromBank: number;
}

export function planStats(steps: PlanStep[]): PlanStats {
  const count = (k: PlanStep['kind']): number =>
    steps.filter((s) => s.kind === k).length;
  return {
    total: steps.length,
    banks: count('create-bank'),
    lessons: count('create-lesson'),
    blocks: count('create-block'),
    uploads: count('upload-asset'),
    storylineFlags: count('flag-storyline'),
    orphanFlags: count('flag-orphan-media'),
    drawFromBank: count('bind-draw-from-bank'),
  };
}
