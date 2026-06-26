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
  /** Raw byte size (from the asset manifest) — used to PREDICT the relay-cap
   *  overflow in the plan (so a dry-run preview flags oversized media too). */
  size?: number;
  /** 403/404 at source (assets-summary `orphaned`): no bytes to upload. */
  orphaned?: boolean;
}

/** Upload size ceiling (as base64 length). The S3 PUT now goes DIRECT from the
 *  side panel (host_permissions exempt it from CORS), so the bytes no longer cross
 *  a 64MiB chrome.runtime message — the ceiling is memory (the base64 round-trip),
 *  not messaging. Set generously so large media (e.g. animated GIFs) migrate, while
 *  still flagging pathologically huge assets to avoid an out-of-memory crash.
 *  Shared by the PLANNER (predict overflow from the manifest size → dry-run flag)
 *  and the EXECUTOR (runtime backstop on the actual base64 length). */
export const MAX_UPLOAD_BASE64 = 350 * 1024 * 1024; // ≈ 262MB of raw bytes

/** Predict whether raw bytes of `size` exceed the upload ceiling once base64-encoded
 *  (base64 inflates ~4/3). Unknown/zero size → not predicted (executor backstops). */
export function exceedsUploadLimit(size: number | undefined): boolean {
  if (typeof size !== 'number' || size <= 0) return false;
  return Math.ceil(size / 3) * 4 > MAX_UPLOAD_BASE64;
}

/** ~MB for an oversize flag message. */
function approxMb(size: number): number {
  return Math.round(size / (1024 * 1024));
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
  /** Staged Storyline packages already uploaded to the TARGET Review 360, keyed
   *  by SOURCE block id → its `review/items/{leaf}` prefix + meta/title. When an
   *  entry exists for a storyline block, the plan emits an ATTACH (copy_review_item
   *  + media patch) instead of a manual flag. Built by the orchestrator from the
   *  course's storyline manifest (only entries whose package has been uploaded). */
  storylineAttach?: Map<string, { reviewPrefix: string; meta?: unknown; title?: string }>;
}

export type PlanStep =
  | { kind: 'create-bank'; sourceBankId: string; title: string; summary: string }
  | { kind: 'put-bank'; sourceBankId: string; questionCount: number; summary: string }
  | {
      kind: 'create-course';
      sourceCourseId: string;
      title: string;
      /** Source course `type` (e.g. `"onePage"` for a microlearning) — passed to
       *  POST /content so the target course is the same kind. null/absent → standard. */
      courseType: string | null;
      summary: string;
    }
  | { kind: 'set-theme'; sourceCourseId: string; summary: string }
  | { kind: 'set-title'; sourceCourseId: string; title: string; summary: string }
  | {
      // Upload + set the course's user-uploaded cover / card / logo image
      // (course-level media, not on a block) via UPDATE_COURSE
      // coverImage/cardImage/media (logo).
      kind: 'set-course-images';
      hasCover: boolean;
      hasCard: boolean;
      /** Course-level `media` object — the cover-page logo. */
      hasMedia: boolean;
      /** Course-level `lessonHeaderImage` object (may nest `originalImage`). */
      hasLessonHeader: boolean;
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
      // Lesson-level uploaded media (header image + any lesson `media`) — uploaded
      // BEFORE the lesson's UPDATE_LESSON so the payload carries the remapped key
      // instead of blanking it. Same upload chain as block media.
      kind: 'upload-lesson-media';
      sourceLessonId: string;
      sourceKey: string;
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
      // Storyline/Mighty block whose package is staged + uploaded to the target
      // Review 360: copy_review_item into the course, then patch media.storyline.
      kind: 'attach-storyline';
      sourceLessonId: string;
      sourceBlockId: string;
      /** `review/items/{leaf}` on the target account (from the upload). */
      reviewPrefix: string;
      meta?: unknown;
      title?: string;
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

/** Order the lesson OBJECTS by the course's authoritative ordered lesson-id list
 *  (`course.lessons` — a list of ids, or objects with `id`). Falls back to the
 *  objects' own array order when no usable id list is present. Any object missing
 *  from the id list is appended (never dropped). */
export function orderLessons(objs: Lesson[], orderField: unknown): Lesson[] {
  const ids = Array.isArray(orderField)
    ? orderField
        .map((x) =>
          typeof x === 'string'
            ? x
            : x && typeof x === 'object'
              ? String((x as { id?: unknown }).id ?? '')
              : '',
        )
        .filter(Boolean)
    : [];
  if (ids.length === 0) return objs;
  const byId = new Map(objs.map((l) => [typeof l.id === 'string' ? l.id : '', l]));
  const seen = new Set<string>();
  const out: Lesson[] = [];
  for (const id of ids) {
    const l = byId.get(id);
    if (l && !seen.has(id)) {
      seen.add(id);
      out.push(l);
    }
  }
  for (const l of objs) {
    const id = typeof l.id === 'string' ? l.id : '';
    if (!seen.has(id)) out.push(l);
  }
  return out;
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

/** The uploaded media key of the course-level `media` object — the cover-page
 *  LOGO. Capture-confirmed shape is `{image:{key}}` (NO `media` wrapper, unlike
 *  coverImage/cardImage). Null if absent / not a course-bank upload. */
export function courseMediaImageKey(img: unknown): string | null {
  const k = (img as { image?: { key?: unknown } })?.image?.key;
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
  // Display order comes from the course's authoritative ordered lesson-id list
  // (`course.lessons`, protocol §2) — NOT the top-level lesson-objects array order
  // and NOT the `position` field (both were observed to scramble a real course).
  const lessons = orderLessons(
    Array.isArray(input.course.lessons) ? input.course.lessons : [],
    (course as Record<string, unknown>).lessons,
  );

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

  // 2. Course shell. The bare POST /content shell is only a CATALOG row; it
  // becomes a real course when the FIRST CREATE_LESSON materializes its runtime
  // document. So we emit the first lesson as the very next write after the shell —
  // nothing failable in between — to shrink the "never-born phantom" window to a
  // single hop (the executor rolls back an un-materialized shell if even that
  // fails). Title is best-effort and NOT the materializer, so it no longer comes
  // first; it (and the theme) are applied AFTER the lessons exist — Rise also
  // rejects theming a lesson-less course ("add a lesson before theming").
  steps.push({
    kind: 'create-course',
    sourceCourseId,
    title,
    courseType: typeof (course as Record<string, unknown>).type === 'string'
      ? ((course as Record<string, unknown>).type as string)
      : null,
    summary: `Create course "${title}"`,
  });

  // 3. Lessons in DISPLAY ORDER (already applied above via `course.lessons`,
  // the authoritative ordered id list — §2). CREATE_LESSON honors `position`, so
  // we send a sequential 0-based slot (idx) and each create appends in this exact
  // order — no reorder pass needed.
  const ordered = lessons;
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

    // Lesson-level media (header image + any lesson `media`) — uploaded BEFORE
    // UPDATE_LESSON so the lesson payload carries the remapped key instead of a
    // blank. Same orphan/oversize handling as block media; oversize is PREDICTED
    // from the manifest size so dry-run previews the manual flag too.
    const lessonMedia = {
      headerImage: (lesson as Record<string, unknown>).headerImage,
      media: (lesson as Record<string, unknown>).media,
    };
    for (const ak of collectAssetKeys(lessonMedia, sourceCourseId)) {
      const entry = assetByKey.get(ak.key);
      handledKeys.add(ak.key);
      if (entry?.orphaned || (entry && !entry.file)) {
        steps.push({
          kind: 'flag-orphan-media',
          sourceLessonId,
          sourceBlockId: '',
          sourceKey: ak.key,
          summary: `⚠ Orphaned lesson media (deleted at source): ${ak.key}`,
        });
        continue;
      }
      if (exceedsUploadLimit(entry?.size)) {
        steps.push({
          kind: 'flag-unsupported-media',
          sourceKey: ak.key,
          location: `lesson "${lTitle}" header/media`,
          summary: `⚠ Lesson media ~${approxMb(entry!.size!)}MB too large to upload via the extension — attach manually: ${ak.key}`,
        });
        continue;
      }
      steps.push({
        kind: 'upload-lesson-media',
        sourceLessonId,
        sourceKey: ak.key,
        filename: fileBasename(ak.key),
        summary: `Upload lesson media ${fileBasename(ak.key)}`,
      });
    }

    steps.push({
      kind: 'update-lesson',
      sourceLessonId,
      lessonType: lType,
      icon,
      summary: `Configure lesson "${lTitle}" (type=${lType})`,
    });
    // A `section` (module header) has no blocks — skip the block churn.
    const blocks = (lesson.items ?? []) as Block[];
    if (lType === 'section' || blocks.length === 0) return;

    // No PUT_LOCK/DEL_LOCK: the edit lock is a collaboration guard only; a
    // single-author import doesn't need it, and skipping it removes two paced
    // writes per lesson (protocol §2).

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
        const attach = input.storylineAttach?.get(sourceBlockId);
        if (attach) {
          steps.push({
            kind: 'attach-storyline',
            sourceLessonId,
            sourceBlockId,
            reviewPrefix: attach.reviewPrefix,
            meta: attach.meta,
            title: attach.title,
            summary: `Attach Storyline from ${attach.reviewPrefix}`,
          });
        } else {
          steps.push({
            kind: 'flag-storyline',
            sourceLessonId,
            sourceBlockId,
            summary: `⚠ Storyline/Mighty block needs manual Review-360 attach`,
          });
        }
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
        // Predict the 64MB relay-cap overflow from the manifest size — so a dry-run
        // flags it too. Oversize keys aren't uploaded; the executor blanks them
        // (keyMap → '') so no dead source key survives on the block.
        if (exceedsUploadLimit(entry?.size)) {
          steps.push({
            kind: 'flag-unsupported-media',
            sourceKey: ak.key,
            location: `block ${sourceBlockId}`,
            summary: `⚠ Media ~${approxMb(entry!.size!)}MB too large to upload via the extension — attach manually: ${ak.key}`,
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
    }
    // (no unlock — we never locked)
  });

  // Title now — best-effort, AFTER the course has been materialized by its first
  // lesson (the shell on its own is a catalog row, not a real course).
  steps.push({
    kind: 'set-title',
    sourceCourseId,
    title,
    summary: `Set course title "${title}"`,
  });

  // Theme AFTER the lessons exist — Rise rejects theming a lesson-less course
  // ("add a lesson to your course before theming"). Applied once, course-level.
  if (course.theme && typeof course.theme === 'object') {
    steps.push({
      kind: 'set-theme',
      sourceCourseId,
      summary: 'Apply course theme + typefaces (verbatim round-trip)',
    });
  }

  // Course cover / card / logo images (user-uploaded) — upload + set via
  // UPDATE_COURSE. Mark their keys handled so the flagger below skips them.
  // `media` is the cover-page logo (capture-confirmed; `{image:{key,…}}`).
  const coverKey = coverCardImageKey(course.coverImage);
  const cardKey = coverCardImageKey(course.cardImage);
  const mediaKey = courseMediaImageKey(course.media);
  // lessonHeaderImage uses the same `{media:{image:{key}}}` shape as cover/card
  // (it may also nest an uncropped `originalImage` with its own key/crushedKey —
  // all handled keys are marked below so none survives as a source key).
  const headerKey = coverCardImageKey(course.lessonHeaderImage);
  if (coverKey || cardKey || mediaKey || headerKey) {
    for (const img of [course.coverImage, course.cardImage, course.media, course.lessonHeaderImage]) {
      for (const ak of collectAssetKeys(img, sourceCourseId)) handledKeys.add(ak.key);
    }
    steps.push({
      kind: 'set-course-images',
      hasCover: !!coverKey,
      hasCard: !!cardKey,
      hasMedia: !!mediaKey,
      hasLessonHeader: !!headerKey,
      summary: `Set course ${[coverKey && 'cover', cardKey && 'card', mediaKey && 'logo', headerKey && 'lesson-header'].filter(Boolean).join(' + ')} image`,
    });
  }

  // Media that isn't on a recreatable block OR an uploaded lesson header — theme
  // images and bank question media (lesson headers are handled per-lesson above).
  // The captured write path doesn't cover these, so flag them (manual) rather than
  // silently shipping a source key or failing the whole course.
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
    uploads: count('upload-asset') + count('upload-lesson-media'),
    storylineFlags: count('flag-storyline'),
    orphanFlags: count('flag-orphan-media'),
    drawFromBank: count('bind-draw-from-bank'),
  };
}
