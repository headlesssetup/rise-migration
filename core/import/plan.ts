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
  /** Recreate referenced question banks (POST→PUT) and bind draw-from-bank
   *  blocks to them. Default OFF: draw-from-bank blocks are created as unbound
   *  placeholders and flagged for manual handling (like Storyline/Mighty) — a
   *  course import does not silently spawn banks in the target account. */
  recreateBanks?: boolean;
  /** Banks already imported as a separate step (B): source bank id →
   *  { newBankId, questionIds }. When a draw-from-bank block's bank is here, the
   *  plan emits a bind step (auto-bind) WITHOUT creating the bank — the bank and
   *  its question ids already exist on the target. Supersedes `recreateBanks`. */
  boundBanks?: Map<string, { newBankId: string; questionIds: string[] }>;
}

export type PlanStep =
  | { kind: 'create-bank'; sourceBankId: string; title: string; summary: string }
  | { kind: 'put-bank'; sourceBankId: string; questionCount: number; summary: string }
  | { kind: 'create-course'; sourceCourseId: string; title: string; summary: string }
  | { kind: 'set-theme'; sourceCourseId: string; summary: string }
  | { kind: 'set-title'; sourceCourseId: string; title: string; summary: string }
  | {
      // Upload + set the course's user-uploaded cover / card image (course-level
      // media, not on a block) via UPDATE_COURSE coverImage/cardImage.
      kind: 'set-course-images';
      hasCover: boolean;
      hasCard: boolean;
      summary: string;
    }
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
      // ALL of a lesson's blocks created in ONE ordered CREATE_BLOCKS. A single
      // array insert preserves order deterministically; per-block previousBlockId
      // chaining (interleaved with media uploads) mis-ordered larger lessons.
      kind: 'create-blocks';
      sourceLessonId: string;
      blocks: { sourceBlockId: string; family: string; variant: string }[];
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
      // Draw-from-bank block created as an unbound placeholder (bank recreation
      // off) — flagged for manual handling, like Storyline/Mighty.
      kind: 'flag-draw-from-bank';
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
    }
  | {
      // Uploaded media that isn't attached to a recreatable content block —
      // course cover/card/theme images, lesson header images, bank question
      // media. The captured write path doesn't cover writing these, so they are
      // flagged for manual handling and NOT written as source keys (protocol §8).
      kind: 'flag-unsupported-media';
      sourceKey: string;
      location: string;
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

/** The uploaded media key of a course cover/card image object
 *  (`{media:{image:{key}}}`), or null if absent / not a course-bank upload. */
export function coverCardImageKey(img: unknown): string | null {
  const k = (img as { media?: { image?: { key?: unknown } } })?.media?.image?.key;
  return typeof k === 'string' && /^rise\/(?:courses|questionBanks)\//.test(k) ? k : null;
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
  // Keys attached to a recreatable block (uploaded or orphan-flagged). Anything
  // else (course/lesson/theme/bank media) is flagged unsupported at the end.
  const handledKeys = new Set<string>();

  // 1. Banks first (a draw-from-bank block needs the new bank id) — ONLY when
  // bank recreation is explicitly enabled. Default: draw-from-bank blocks become
  // unbound placeholders (see the block loop), so no bank is created.
  if (input.recreateBanks) {
    const referencedBanks = new Set<string>();
    for (const l of lessons) {
      for (const b of (l.items ?? []) as Block[]) {
        if (isDrawFromBank(b)) {
          const { bankId } = findBankRef(b);
          if (bankId) referencedBanks.add(bankId);
        }
      }
    }
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
      // Sequential 0-based slot in display order — NOT the raw source `position`.
      // We create lessons in this order, so slot == current length == an append;
      // sending the raw (possibly gappy/non-0-based) source position let the
      // server place lessons out of order. `idx` keeps each insert an append.
      position: idx,
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

    // 1. Create ALL blocks in one ordered batch (preserves order).
    steps.push({
      kind: 'create-blocks',
      sourceLessonId,
      blocks: blocks.map((b) => ({
        sourceBlockId: typeof b.id === 'string' ? b.id : '',
        family: String(b.family ?? ''),
        variant: String(b.variant ?? ''),
      })),
      summary: `Create ${blocks.length} block(s) in "${lTitle}"`,
    });

    // 2. Per-block follow-ups — run AFTER every block exists, addressed by id,
    //    so they never affect ordering: storyline/draw-from-bank flags + binds,
    //    media upload + patch, orphan flags.
    for (const block of blocks) {
      const sourceBlockId = typeof block.id === 'string' ? block.id : '';
      const family = String(block.family ?? '');
      const variant = String(block.variant ?? '');

      if (isStoryline(block)) {
        steps.push({
          kind: 'flag-storyline',
          sourceLessonId,
          sourceBlockId,
          summary: `⚠ Storyline/Mighty block needs manual Review-360 attach`,
        });
        continue;
      }

      if (isDrawFromBank(block)) {
        const { bankId, drawCount, questionDrawType } = findBankRef(block);
        // Bind when the bank was imported in step B (boundBanks) OR when this run
        // is recreating banks itself; otherwise leave an unbound placeholder.
        const isBound = bankId != null && (input.boundBanks?.has(bankId) ?? false);
        if (isBound || input.recreateBanks) {
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
        } else {
          steps.push({
            kind: 'flag-draw-from-bank',
            sourceLessonId,
            sourceBlockId,
            summary: `⚠ Draw-from-bank placeholder — attach a question bank manually`,
          });
        }
        continue;
      }

      // Uploaded media on this block → upload + patch (or flag orphans).
      const keys = collectAssetKeys(block, sourceCourseId);
      const uploadable: string[] = [];
      for (const ak of keys) {
        const entry = assetByKey.get(ak.key);
        if (entry?.orphaned || (entry && !entry.file)) {
          handledKeys.add(ak.key);
          steps.push({
            kind: 'flag-orphan-media',
            sourceLessonId,
            sourceBlockId,
            sourceKey: ak.key,
            summary: `⚠ Orphaned media (deleted at source): ${ak.key}`,
          });
          continue;
        }
        handledKeys.add(ak.key);
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
    }

    steps.push({
      kind: 'unlock-lesson',
      sourceLessonId,
      summary: `Unlock lesson "${lTitle}"`,
    });
  });

  // Course cover / card images (user-uploaded) — upload + set via UPDATE_COURSE.
  // Mark their keys handled so the flagger below skips them.
  const coverKey = coverCardImageKey(course.coverImage);
  const cardKey = coverCardImageKey(course.cardImage);
  if (coverKey || cardKey) {
    for (const img of [course.coverImage, course.cardImage]) {
      for (const ak of collectAssetKeys(img, sourceCourseId)) handledKeys.add(ak.key);
    }
    steps.push({
      kind: 'set-course-images',
      hasCover: !!coverKey,
      hasCard: !!cardKey,
      summary: `Set course ${[coverKey && 'cover', cardKey && 'card'].filter(Boolean).join(' + ')} image`,
    });
  }

  // Media that isn't on a recreatable block — theme images, lesson header
  // images, and bank question media. The captured write path doesn't cover
  // writing these, so flag them (manual) rather than silently shipping a source
  // key or failing the whole course.
  const flagUnsupported = (doc: unknown, ownerId: string, where: string): void => {
    for (const ak of collectAssetKeys(doc, ownerId)) {
      if (handledKeys.has(ak.key)) continue;
      handledKeys.add(ak.key);
      steps.push({
        kind: 'flag-unsupported-media',
        sourceKey: ak.key,
        location: where,
        summary: `⚠ Unsupported media location (${where}) — attach manually: ${ak.key}`,
      });
    }
  };
  flagUnsupported(input.course, sourceCourseId, 'course/lesson/theme');
  for (const [bankId, bank] of input.banksById) {
    flagUnsupported(bank, bankId, `bank ${bankId}`);
  }

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
  const blocks = steps.reduce(
    (n, s) => (s.kind === 'create-blocks' ? n + s.blocks.length : n),
    0,
  );
  return {
    total: steps.length,
    banks: count('create-bank'),
    lessons: count('create-lesson'),
    blocks,
    uploads: count('upload-asset'),
    storylineFlags: count('flag-storyline'),
    orphanFlags: count('flag-orphan-media'),
    drawFromBank: count('bind-draw-from-bank'),
  };
}
