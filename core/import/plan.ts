// Phase 3 — the import PLAN: a deterministic, ordered list of write-step intents
// derived from a source archive. The same plan drives the DRY-RUN preview and the
// live executor (one source of ordering truth). Step ordering follows
// docs/rise-import-protocol.md §1: banks → course shell → theme → title →
// (per lesson) create → update → lock → (per block) create → media upload+patch
// or draw-from-bank bind → unlock.

import { collectAssetKeys } from '@/core/assets/keys';
import { courseImageKind } from './builtin-assets';
// Type-only imports back from executor-types keep this cycle-free at runtime.
import { blockKey } from './executor-types';
import {
  cellKey,
  collectCells,
  formalityGroups,
  inlineTranslationChanges,
  isL10nRef,
  isLocalizedStack,
  materializeLocale,
  orphanLocaleTables,
  planCellWrites,
  requireDefaultLocale,
  resolveStackTitle,
  stackLocales,
  storylineCells,
  writableLocaleCodes,
} from '@/core/l10n';
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
   *  by `blockKey(sourceLessonId, sourceBlockId)` → its `review/items/{leaf}`
   *  prefix + meta/title. When an entry exists for a storyline block, the plan
   *  emits an ATTACH (copy_review_item + media patch) instead of a manual flag.
   *  Built by the orchestrator from the course's storyline manifest (only
   *  entries whose package has been uploaded). Lesson+block keyed — block ids
   *  repeat across lessons (v0.6.3), so a blockId-only key would attach one
   *  package to every same-id block. */
  storylineAttach?: Map<string, { reviewPrefix: string; meta?: unknown; title?: string }>;
  /** STACK only (docs/rise-multilang.md §4.3b):
   *  `${blockKey(sourceLessonId, sourceBlockId)}|${locale}` → the uploaded
   *  package for THAT language. Each entry becomes a copy_review_item + a
   *  storyline cell write; languages with no uploaded package are flagged
   *  instead. */
  storylineAttachL10n?: Map<
    string,
    { locale: string; l10nId?: string; reviewPrefix: string; meta?: unknown; title?: string }
  >;
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
  | {
      // Early write carries a `!importing:`-prefixed provisional title so a
      // hard-crashed partial is unmistakably identifiable in the dashboard; the
      // `final` write (the plan's LAST step) sets the clean title + description.
      kind: 'set-title';
      sourceCourseId: string;
      title: string;
      final?: boolean;
      summary: string;
    }
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
      /** Stack content lesson: create with the SOURCE title ref ({l10nId}) +
       *  an inline translationChanges add carrying the default-locale title.
       *  Absent on monolingual lessons and on the pre-conversion placeholder
       *  (which must be plain — the conversion extracts it into a cell). */
      l10nTitleRef?: string;
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
    }
  // --- Multi-language stacks (docs/rise-multilang.md) ------------------------
  | {
      // Pre-conversion placeholder description ('.') so the conversion creates
      // a description cell/ref we can fill per locale (there is no captured
      // envelope for ADDING a description to an already-converted stack).
      kind: 'set-course-description';
      value: string;
      summary: string;
    }
  | {
      // POST …/translations — the "stack-shape factory": converts the minimal
      // placeholder course and creates locale rows. One step per formality
      // group (formality is a per-call parameter). AI runs only on the
      // placeholder strings; every cell is overwritten from the source later.
      kind: 'convert-stack';
      sourceLanguage: string;
      targetLanguages: string[];
      formality: string | null;
      summary: string;
    }
  | {
      // Poll GET …/translations until every expected language is `complete`,
      // then GET_COURSE the target to learn its course-level l10n refs
      // (title/description/cover…) for the cell writes.
      kind: 'await-stack';
      expectedLocales: string[];
      summary: string;
    }
  | {
      // Media referenced ONLY from the translation tables (most stack media
      // lives there, incl. per-language overrides) — same upload chain as
      // block media; the keys are remapped inside cell values at write time.
      kind: 'upload-l10n-asset';
      sourceKey: string;
      locale: string;
      mediaKind: string;
      filename: string;
      summary: string;
    }
  | {
      // One UPDATE_L10N_BATCH envelope: the listed source cells of ONE locale
      // (values resolved from the archive at execution; media keys remapped;
      // course-level ids mapped to the target's own refs). Batches are ordered
      // DEFAULT LOCALE FIRST — the pending-flag write-order invariant.
      kind: 'write-l10n';
      locale: string;
      l10nIds: string[];
      batchIndex: number;
      batchTotal: number;
      summary: string;
    }
  | {
      // Recreate a custom per-language label set on the target account
      // (CREATE_LABEL_SET → UPDATE_LABELS(diff) → UPDATE_LOCALE bind).
      // Account-scoped: the executor dedupes via deps.labelSetCache.
      kind: 'set-locale-labelset';
      locale: string;
      iso639Code: string;
      name: string;
      /** Labels that differ from the language's built-in default set (or the
       *  full set when no default was archived). */
      labels: Record<string, unknown>;
      sourceLabelSetId: string;
      summary: string;
    }
  | {
      // Delete placeholder-era cells the conversion created that map to nothing
      // in the source (computed at runtime from the await-stack snapshot;
      // usually empty — every placeholder cell is normally reused via the ref
      // map). `delete` removes an id across ALL locales, so only provably-ours
      // ids qualify.
      kind: 'cleanup-l10n';
      summary: string;
    }
  | {
      // FINAL step of a stack plan (replaces the monolingual final set-title,
      // preserving the `!importing:` partial-marker invariant): write the clean
      // title + description cells for EVERY locale (default first) onto the
      // target's own refs.
      kind: 'set-stack-titles';
      summary: string;
    }
  | {
      // Source stack shows the learner language selector; the toggle envelope
      // (TOGGLE_LOCALE_SELECTOR) is not capture-proven → manual flag.
      kind: 'flag-locale-selector';
      summary: string;
    }
  | {
      // A stack cell holds a Storyline package reference (docs/rise-multilang.md
      // §4.3b). NEVER copied verbatim — its contentPrefix points at the SOURCE
      // course's S3 prefix and storyline keys are exempt from the foreign-key
      // invariant, so a verbatim copy would ship a dead reference silently.
      // v0.6.0: the block is recreated bare and every language is flagged for a
      // manual Review-360 attach (per-language attach automation → v0.6.1).
      kind: 'flag-l10n-storyline';
      l10nId: string;
      locales: string[];
      title?: string;
      summary: string;
    }
  | {
      // A source translation table exists for a locale the target can never
      // have: the locale row is ARCHIVED (deletedAt — convert-stack recreates
      // live languages only) or the table has no locale row at all. Writing
      // its cells would send UPDATE_L10N_BATCH for a locale unknown to the
      // target course (untested server behavior), so the data is skipped and
      // flagged loudly instead — restore the language at the source and
      // re-export to migrate it.
      kind: 'flag-l10n-locale';
      locale: string;
      reason: 'archived' | 'no-locale-row';
      cells: number;
      summary: string;
    }
  | {
      // STACK per-language Storyline attach (docs/rise-multilang.md §4.3b):
      // copy_review_item for THIS language's package, then write the storyline
      // cell for that locale. The block itself already carries the {l10nId} ref
      // (copy-faithful), so no block patch — patching would clobber the ref.
      kind: 'attach-storyline-l10n';
      sourceLessonId: string;
      sourceBlockId: string;
      /** The cell to write (source l10nId, kept verbatim on the target). */
      l10nId: string;
      locale: string;
      reviewPrefix: string;
      meta?: unknown;
      title?: string;
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
/** The l10n cell id behind a STACK storyline block's `items[0].media` ref. */
function storylineCellId(b: Block): string | null {
  const items = Array.isArray(b.items) ? b.items : [];
  const first = items.find((i) => i && typeof i === 'object') as
    | { media?: unknown }
    | undefined;
  const media = first?.media;
  return isL10nRef(media) ? media.l10nId : null;
}

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
  // Multi-language stack: the doc is l10n-ified ({l10nId} refs + per-locale
  // tables) — plan the stack sequence (docs/rise-multilang.md). Title/summary
  // strings and course-image objects come from the MATERIALIZED default locale.
  const stack = isLocalizedStack(input.course);
  const mat = stack ? materializeLocale(input.course).doc : input.course;
  const matCourse = (mat.course ?? {}) as Record<string, unknown>;
  const title = stack
    ? resolveStackTitle(input.course) || sourceCourseId
    : typeof course.title === 'string'
      ? course.title
      : sourceCourseId;
  // Display order comes from the course's authoritative ordered lesson-id list
  // (`course.lessons`, protocol §2) — NOT the top-level lesson-objects array order
  // and NOT the `position` field (both were observed to scramble a real course).
  const lessons = orderLessons(
    Array.isArray(input.course.lessons) ? input.course.lessons : [],
    (course as Record<string, unknown>).lessons,
  );
  // Materialized twins (same order) for display titles on a stack.
  const matLessons = orderLessons(
    Array.isArray(mat.lessons) ? mat.lessons : [],
    (matCourse as Record<string, unknown>).lessons,
  );
  const matTitle = (idx: number): string => lessonTitle(matLessons[idx] ?? lessons[idx] ?? {});

  // STACK Storyline bookkeeping (docs/rise-multilang.md §4.3b): which locales
  // hold a package per cell, and which of those the plan actually attaches —
  // the rest are flagged. Filled by the block loop, read by the flag sweep.
  const stackStorylineCells = new Map<string, string[]>();
  const stackStorylineAttached = new Map<string, Set<string>>();
  if (stack) {
    for (const cell of storylineCells(input.course)) {
      const locales = stackStorylineCells.get(cell.l10nId) ?? [];
      locales.push(cell.locale);
      stackStorylineCells.set(cell.l10nId, locales);
      if (!stackStorylineAttached.has(cell.l10nId)) {
        stackStorylineAttached.set(cell.l10nId, new Set());
      }
    }
  }
  const storylineCellLocales = (l10nId: string): string[] =>
    stackStorylineCells.get(l10nId) ?? [];

  const assetByKey = new Map(input.assets.map((a) => [a.key, a]));
  // Keys attached to a recreatable block (uploaded or orphan-flagged). Anything
  // else (course/lesson/theme/bank media) is flagged unsupported at the end.
  const handledKeys = new Set<string>();

  // Course cover / card / logo images (user-uploaded) — upload + set via
  // UPDATE_COURSE. Marks their keys handled so the final flagger skips them.
  // `media` is the cover-page logo (capture-confirmed; `{image:{key,…}}`).
  // Monolingual: called with the raw course near the end of the plan. Stack:
  // called with the MATERIALIZED course BEFORE the conversion (the conversion
  // turns the plain image objects into refs + default-locale cells itself).
  const planCourseImages = (c: Record<string, unknown>): void => {
    const coverKey = coverCardImageKey(c.coverImage);
    const cardKey = coverCardImageKey(c.cardImage);
    const mediaKey = courseMediaImageKey(c.media);
    // lessonHeaderImage uses the same `{media:{image:{key}}}` shape as cover/card
    // (it may also nest an uncropped `originalImage` with its own key/crushedKey —
    // all handled keys are marked below so none survives as a source key).
    const headerKey = coverCardImageKey(c.lessonHeaderImage);
    // BUILT-IN (library/CDN) images have no uploadable key but are perfectly
    // copyable — the sample courses' covers are `assets/rise/…` library keys.
    // Treating "no uploaded key" as "no image" silently DROPPED them (the target
    // kept whatever random built-in cover Rise assigned, and on a stack the
    // conversion then had no ref to localize). Ship those objects verbatim.
    const builtinCover = !coverKey && courseImageKind(c.coverImage) === 'builtin';
    const builtinCard = !cardKey && courseImageKind(c.cardImage) === 'builtin';
    const builtinMedia = !mediaKey && courseImageKind(c.media) === 'builtin';
    const builtinHeader = !headerKey && courseImageKind(c.lessonHeaderImage) === 'builtin';
    const anyBuiltin = builtinCover || builtinCard || builtinMedia || builtinHeader;
    if (!coverKey && !cardKey && !mediaKey && !headerKey && !anyBuiltin) return;
    // Orphaned course-image keys (deleted at source, no archived bytes) are
    // flagged BEFORE the set-course-images step, mirroring block/lesson media:
    // the executor blanks them (keyMap → '') so UPDATE_COURSE ships without the
    // image and the course still succeeds — with a flag, not a late hard-fail.
    const flaggedImgKeys = new Set<string>();
    const courseImages: [unknown, string][] = [
      [c.coverImage, 'course cover image'],
      [c.cardImage, 'course card image'],
      [c.media, 'course logo'],
      [c.lessonHeaderImage, 'course lesson-header image'],
    ];
    for (const [img, where] of courseImages) {
      for (const ak of collectAssetKeys(img, sourceCourseId)) {
        handledKeys.add(ak.key);
        const entry = assetByKey.get(ak.key);
        if ((entry?.orphaned || (entry && !entry.file)) && !flaggedImgKeys.has(ak.key)) {
          flaggedImgKeys.add(ak.key);
          steps.push({
            kind: 'flag-orphan-media',
            sourceLessonId: '',
            sourceBlockId: '',
            sourceKey: ak.key,
            summary: `⚠ Orphaned ${where} (deleted at source): ${ak.key}`,
          });
        }
      }
    }
    const has = {
      cover: !!coverKey || builtinCover,
      card: !!cardKey || builtinCard,
      media: !!mediaKey || builtinMedia,
      header: !!headerKey || builtinHeader,
    };
    const label = [
      has.cover && `cover${builtinCover ? ' (built-in)' : ''}`,
      has.card && `card${builtinCard ? ' (built-in)' : ''}`,
      has.media && `logo${builtinMedia ? ' (built-in)' : ''}`,
      has.header && `lesson-header${builtinHeader ? ' (built-in)' : ''}`,
    ]
      .filter(Boolean)
      .join(' + ');
    steps.push({
      kind: 'set-course-images',
      hasCover: has.cover,
      hasCard: has.card,
      hasMedia: has.media,
      hasLessonHeader: has.header,
      summary: `Set course ${label} image`,
    });
  };

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

  // Everything a lesson needs AFTER its CREATE_LESSON: lesson media uploads,
  // UPDATE_LESSON, blocks + per-block follow-ups. Shared by the monolingual
  // loop and the stack sequence (identical either way — a stack's block JSON is
  // copy-faithful too, its refs are just one more value shape).
  const planLessonBody = (
    lesson: Lesson,
    sourceLessonId: string,
    lTitle: string,
    lType: string,
    icon: string | null,
  ): void => {
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
        const attach = input.storylineAttach?.get(blockKey(sourceLessonId, sourceBlockId));
        // On a STACK the block's media is an {l10nId} ref and each language's
        // package lives in its own cell (docs/rise-multilang.md §4.3b). Attach
        // per language: copy_review_item + a storyline cell write. NEVER patch
        // the block's media — that would overwrite the ref and destroy every
        // language's binding. Languages with no staged package are flagged by
        // the flag-l10n-storyline sweep (which skips the ones attached here).
        if (stack) {
          const cellId = storylineCellId(block);
          const attached = cellId ? stackStorylineAttached.get(cellId) : undefined;
          const cellLocales = cellId ? storylineCellLocales(cellId) : [];
          for (const locale of cellLocales) {
            const pkg = input.storylineAttachL10n?.get(
              `${blockKey(sourceLessonId, sourceBlockId)}|${locale}`,
            );
            if (!pkg || !cellId) continue;
            steps.push({
              kind: 'attach-storyline-l10n',
              sourceLessonId,
              sourceBlockId,
              l10nId: cellId,
              locale,
              reviewPrefix: pkg.reviewPrefix,
              meta: pkg.meta,
              title: pkg.title,
              summary: `Attach Storyline [${locale}] from ${pkg.reviewPrefix}`,
            });
            attached?.add(locale);
          }
          // No package in ANY language (an empty/never-attached block, or a ref
          // we could not resolve): the flag-l10n-storyline sweep has nothing to
          // report for it, so flag the block itself — never stay silent about a
          // storyline block.
          if (cellLocales.length === 0) {
            steps.push({
              kind: 'flag-storyline',
              sourceLessonId,
              sourceBlockId,
              summary: `⚠ Storyline/Mighty block (multi-language) has no package to copy — check it manually`,
            });
          }
          continue;
        }
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
        // Key already handled by an earlier sweep (the stack's table-media
        // pass, or course images): no second upload step — but the block still
        // needs its media PATCH, so the key stays in `uploadable` (the
        // executor's keyMap already carries the remap by then).
        const problematic =
          entry?.orphaned || (entry && !entry.file) || exceedsUploadLimit(entry?.size);
        if (!problematic && handledKeys.has(ak.key)) {
          uploadable.push(ak.key);
          continue;
        }
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
  };

  const lessonMeta = (
    lesson: Lesson,
    idx: number,
  ): { sourceLessonId: string; lType: string; icon: string | null } => ({
    sourceLessonId: typeof lesson.id === 'string' ? lesson.id : `lesson-${idx}`,
    lType: typeof lesson.type === 'string' ? lesson.type : 'blocks',
    icon: typeof lesson.icon === 'string' ? lesson.icon : null,
  });

  if (!stack) {
    ordered.forEach((lesson, idx) => {
      const { sourceLessonId, lType, icon } = lessonMeta(lesson, idx);
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

      // Set a PROVISIONAL course title right after the FIRST lesson materializes
      // the course (the bare shell is a title-less catalog row, and Rise rejects
      // titling a lesson-less course). The `!importing:` prefix makes a
      // hard-crashed partial unmistakable in the dashboard — the clean title is
      // written by the final set-title step only when the import completes (a
      // graceful Stop renames to `!unfinished:` instead).
      if (idx === 0) {
        steps.push({
          kind: 'set-title',
          sourceCourseId,
          title: `!importing: ${title}`,
          summary: `Set provisional course title "!importing: ${title}"`,
        });
      }

      planLessonBody(lesson, sourceLessonId, lTitle, lType, icon);
    });

    // Fallback provisional title for a lesson-less course (the per-first-lesson
    // title above never fired). A confirmed bare shell is a real course, so
    // titling it is safe; the final set-title below still writes the clean title.
    if (ordered.length === 0) {
      steps.push({
        kind: 'set-title',
        sourceCourseId,
        title: `!importing: ${title}`,
        summary: `Set provisional course title "!importing: ${title}"`,
      });
    }
  } else {
    // ------ STACK SEQUENCE (docs/rise-multilang.md §"import algorithm") ------
    const doc = input.course;
    // Loud failure: a stack whose default locale can't be resolved is malformed
    // — silently guessing would break the write-order invariant for every cell.
    const defLocale = requireDefaultLocale(doc);
    const locales = stackLocales(doc);
    const localeCodes = locales
      .map((l) => String(l.locale ?? ''))
      .filter(Boolean);

    // 3a. PLACEHOLDER first lesson (pre-conversion, so the shell can convert and
    // the conversion has something to extract). It IS the future lesson 1: its
    // sourceLessonId is the real first lesson's id, so every later step (update,
    // blocks) addresses it transparently through the id map. Plain-string title
    // (the conversion turns it into the lesson's title cell, which the cell
    // writes then fill per locale via the target ref).
    const first = ordered[0];
    const firstMeta = first ? lessonMeta(first, 0) : null;
    const placeholderTitle = first ? matTitle(0) : 'Content';
    steps.push({
      kind: 'create-lesson',
      sourceLessonId: firstMeta?.sourceLessonId ?? '__l10n_placeholder__',
      position: 0,
      title: placeholderTitle,
      lessonType: firstMeta?.lType === 'section' ? 'section' : null,
      summary: `Create placeholder lesson "${placeholderTitle}" (becomes lesson 1)`,
    });

    // 3b. Provisional `!importing:` title (plain — the course is not converted
    // yet), then a placeholder description so the conversion creates a
    // description ref/cell we can fill (no captured envelope adds one later).
    steps.push({
      kind: 'set-title',
      sourceCourseId,
      title: `!importing: ${title}`,
      summary: `Set provisional course title "!importing: ${title}"`,
    });
    if (isL10nRef(course.description)) {
      steps.push({
        kind: 'set-course-description',
        value: '.',
        summary: 'Set placeholder description (conversion creates its l10n ref)',
      });
    }

    // 3c. Course images BEFORE conversion (plain objects; the conversion turns
    // them into refs + default-locale cells itself — capture-proven shape; AI
    // never touches media). Keys come from the MATERIALIZED course object.
    planCourseImages(matCourse);

    // 3d. Convert to a stack: one POST per formality group; then poll to
    // completion. Localization is free on every subscription; the orchestrator
    // sanity-checks the locale codes against available-languages pre-write.
    for (const g of formalityGroups(doc)) {
      steps.push({
        kind: 'convert-stack',
        sourceLanguage: defLocale,
        targetLanguages: g.locales,
        formality: g.formality,
        summary: `Add language(s) ${g.locales.join(', ')}${g.formality ? ` (formality: ${g.formality})` : ''} — AI runs on the placeholder only`,
      });
    }
    steps.push({
      kind: 'await-stack',
      expectedLocales: localeCodes,
      summary: `Wait for the stack shape (${localeCodes.join(', ')}) to finish`,
    });

    // Tables for locales the target can never have (archived rows / row-less
    // tables) are not transferable — skipped from every write and flagged
    // loudly so nothing leaves the archive unseen.
    const orphanLocales = orphanLocaleTables(doc);
    for (const o of orphanLocales) {
      steps.push({
        kind: 'flag-l10n-locale',
        locale: o.locale,
        reason: o.reason,
        cells: o.cells,
        summary: `⚠ ${o.cells} cell(s) for locale "${o.locale}" cannot be migrated (${o.reason === 'archived' ? 'language is archived at the source' : 'no locale row'}) — restore the language and re-export to migrate it`,
      });
    }
    const writableCodes = writableLocaleCodes(doc);

    // 3e. Table-only media (the bulk of a stack's media lives in the l10n
    // tables, incl. per-language overrides) — upload BEFORE any cell write so
    // values carry remapped keys. Block-embedded media (e.g. attachments) rides
    // the normal per-block loop below. Orphan-locale tables are excluded: their
    // cells are never written, so their media would be unreferenced uploads.
    const allTables = doc.l10n?.translations ?? {};
    const tables = Object.fromEntries(
      Object.entries(allTables).filter(([code]) => writableCodes.has(code)),
    );
    for (const [locale, table] of Object.entries(tables)) {
      for (const ak of collectAssetKeys(table, sourceCourseId)) {
        if (handledKeys.has(ak.key)) continue;
        handledKeys.add(ak.key);
        const entry = assetByKey.get(ak.key);
        if (entry?.orphaned || (entry && !entry.file)) {
          steps.push({
            kind: 'flag-orphan-media',
            sourceLessonId: '',
            sourceBlockId: '',
            sourceKey: ak.key,
            summary: `⚠ Orphaned media in translations (${locale}) (deleted at source): ${ak.key}`,
          });
          continue;
        }
        if (exceedsUploadLimit(entry?.size)) {
          steps.push({
            kind: 'flag-unsupported-media',
            sourceKey: ak.key,
            location: `translations (${locale})`,
            summary: `⚠ Media ~${approxMb(entry!.size!)}MB too large to upload via the extension — attach manually: ${ak.key}`,
          });
          continue;
        }
        steps.push({
          kind: 'upload-l10n-asset',
          sourceKey: ak.key,
          locale,
          mediaKind: ak.kind,
          filename: fileBasename(ak.key),
          summary: `Upload ${ak.kind} ${fileBasename(ak.key)} (translations ${locale})`,
        });
      }
    }

    // 3f. Content, copy-faithful with the SOURCE l10nId refs kept verbatim.
    // Lesson 1 reuses the placeholder (update + blocks only); later lessons are
    // created with their source title ref + an inline default-locale title cell.
    ordered.forEach((lesson, idx) => {
      const { sourceLessonId, lType, icon } = lessonMeta(lesson, idx);
      const lTitle = matTitle(idx);
      if (idx > 0) {
        const titleRef = isL10nRef(lesson.title) ? lesson.title.l10nId : undefined;
        steps.push({
          kind: 'create-lesson',
          sourceLessonId,
          position: idx,
          title: lTitle,
          lessonType: lType === 'section' ? 'section' : null,
          ...(titleRef ? { l10nTitleRef: titleRef } : {}),
          summary: `Create lesson "${lTitle}" (${lType})`,
        });
      }
      planLessonBody(lesson, sourceLessonId, lTitle, lType, icon);
    });

    // 3g. Fill every language: batched cell writes, DEFAULT LOCALE FIRST
    // (write-order invariant — a default row written after its target rows
    // would flag every cell "new content, untranslated"). Cells shipped inline
    // at create time are skipped; the course title/description cells are
    // reserved for the FINAL set-stack-titles step (partial-title invariant).
    const inlineSkip = new Set<string>();
    ordered.forEach((lesson, idx) => {
      if (idx > 0 && isL10nRef(lesson.title)) {
        const t = doc.l10n?.translations?.[defLocale]?.[lesson.title.l10nId];
        if (t !== undefined) inlineSkip.add(cellKey(lesson.title.l10nId, defLocale));
      }
      // Items ride inline ONLY when planLessonBody actually emits create-blocks
      // (it returns early for sections and empty lessons) — skipping their
      // default cells here without an inline write would leave them unwritten,
      // inverting the pending rule for every cell of that lesson.
      const lType = typeof lesson.type === 'string' ? lesson.type : 'blocks';
      if (lType === 'section' || (lesson.items ?? []).length === 0) return;
      for (const ch of inlineTranslationChanges(lesson.items ?? [], doc)) {
        inlineSkip.add(cellKey(ch.l10nId, defLocale));
      }
    });
    const titleDescIds = [course.title, course.description]
      .filter(isL10nRef)
      .map((r) => r.l10nId);
    for (const id of titleDescIds) {
      for (const code of Object.keys(tables)) inlineSkip.add(cellKey(id, code));
    }
    // Storyline cells are NEVER shipped verbatim (their contentPrefix belongs to
    // the SOURCE course and storyline keys bypass the foreign-key invariant):
    // exclude them here and flag each one, grouped by cell, with its languages.
    const slCells = storylineCells(doc);
    const slByRef = new Map<string, { locales: string[]; title?: string }>();
    for (const c of slCells) {
      inlineSkip.add(cellKey(c.l10nId, c.locale));
      const entry = slByRef.get(c.l10nId) ?? { locales: [] };
      entry.locales.push(c.locale);
      const sl = (c.value as { storyline?: { title?: unknown } }).storyline;
      if (!entry.title && typeof sl?.title === 'string') entry.title = sl.title;
      slByRef.set(c.l10nId, entry);
    }
    for (const [l10nId, entry] of slByRef) {
      // Languages this plan attaches automatically (staged package) need no flag.
      const done = stackStorylineAttached.get(l10nId) ?? new Set<string>();
      const pending = entry.locales.filter((l) => !done.has(l));
      if (pending.length === 0) continue;
      steps.push({
        kind: 'flag-l10n-storyline',
        l10nId,
        locales: pending,
        ...(entry.title ? { title: entry.title } : {}),
        summary: `⚠ Storyline in a stack${entry.title ? ` ("${entry.title}")` : ''} — attach manually for: ${pending.join(', ')}`,
      });
    }
    const batches = planCellWrites(collectCells(doc), { skip: inlineSkip });
    batches.forEach((batch, i) => {
      steps.push({
        kind: 'write-l10n',
        locale: batch[0]?.locale ?? defLocale,
        l10nIds: batch.map((c) => c.l10nId),
        batchIndex: i + 1,
        batchTotal: batches.length,
        summary: `Write ${batch.length} translation cell(s) [${batch[0]?.locale ?? ''}] (batch ${i + 1}/${batches.length})`,
      });
    });

    // 3h. Custom per-language label sets (account-scoped; deduped run-wide via
    // the executor's labelSetCache). The DEFAULT locale's set is the course's
    // own label set — course-level label-set migration is a documented gap.
    const archivedSets = Array.isArray((doc as Record<string, unknown>).labelSets)
      ? ((doc as Record<string, unknown>).labelSets as Record<string, unknown>[])
      : [];
    const defaultSets = Array.isArray((doc as Record<string, unknown>).defaultLabelSets)
      ? ((doc as Record<string, unknown>).defaultLabelSets as Record<string, unknown>[])
      : [];
    for (const row of locales) {
      const code = String(row.locale ?? '');
      if (!code || code === defLocale) continue;
      const setId = typeof row.labelSetId === 'string' ? row.labelSetId : null;
      if (!setId) continue; // language default applies — nothing to recreate
      const set = archivedSets.find((s) => s.id === setId);
      if (!set) continue; // not in the archive — the read-back will surface it
      const iso = typeof set.iso639Code === 'string' ? set.iso639Code : code;
      const name = typeof set.name === 'string' ? set.name : `Imported ${code}`;
      const labels = (set.labels ?? {}) as Record<string, unknown>;
      const def = defaultSets.find((s) => s.iso639Code === iso && s.defaultSet === true);
      const defLabels = (def?.labels ?? {}) as Record<string, unknown>;
      const overrides: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(labels)) {
        if (defLabels[k] !== v) overrides[k] = v;
      }
      steps.push({
        kind: 'set-locale-labelset',
        locale: code,
        iso639Code: iso,
        name,
        labels: overrides,
        sourceLabelSetId: setId,
        summary: `Recreate label set "${name}" (${Object.keys(overrides).length} custom label(s)) → ${code}`,
      });
    }
  }

  // Theme AFTER the lessons exist — Rise rejects theming a lesson-less course
  // ("add a lesson to your course before theming"). Applied once, course-level.
  if (course.theme && typeof course.theme === 'object') {
    steps.push({
      kind: 'set-theme',
      sourceCourseId,
      summary: 'Apply course theme + typefaces (verbatim round-trip)',
    });
  }

  // Monolingual course cover/card/logo images — the stack path already emitted
  // its set-course-images (from the MATERIALIZED course) pre-conversion.
  if (!stack) planCourseImages(course as Record<string, unknown>);

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

  if (stack) {
    // Placeholder-era cells the conversion created that map to nothing in the
    // source (computed at runtime from the await-stack snapshot; usually none).
    steps.push({
      kind: 'cleanup-l10n',
      summary: 'Delete placeholder-era translation cells (if any)',
    });
    if (input.course.l10n?.showLocaleSelector === true) {
      steps.push({
        kind: 'flag-locale-selector',
        summary:
          '⚠ Source shows the learner language selector — enable it manually (Settings → Languages)',
      });
    }
    // Final step of a stack plan (the partial-title invariant): write the clean
    // title + description cells for EVERY locale onto the target's own refs.
    steps.push({
      kind: 'set-stack-titles',
      summary: `Set course title "${title}" + description in every language`,
    });
  } else {
    // Final title write — the very LAST step, so anything short of a completed
    // import (hard crash, mid-run failure, Stop) leaves the provisional
    // `!importing:` / `!unfinished:` marker instead of a clean-titled duplicate.
    steps.push({
      kind: 'set-title',
      sourceCourseId,
      title,
      final: true,
      summary: `Set course title "${title}"`,
    });
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
  /** Multi-language stack: number of languages ('' /0 for monolingual). */
  locales: number;
  /** Translation cells written via batches (excludes create-inlined cells). */
  l10nCells: number;
  /** UPDATE_L10N_BATCH envelopes planned. */
  l10nBatches: number;
}

export function planStats(steps: PlanStep[]): PlanStats {
  const count = (k: PlanStep['kind']): number =>
    steps.filter((s) => s.kind === k).length;
  const blocks = steps.reduce(
    (n, s) => (s.kind === 'create-blocks' ? n + s.blocks.length : n),
    0,
  );
  const l10nCells = steps.reduce(
    (n, s) => (s.kind === 'write-l10n' ? n + s.l10nIds.length : n),
    0,
  );
  const awaitStep = steps.find((s) => s.kind === 'await-stack');
  return {
    total: steps.length,
    banks: count('create-bank'),
    lessons: count('create-lesson'),
    blocks,
    uploads:
      count('upload-asset') + count('upload-lesson-media') + count('upload-l10n-asset'),
    storylineFlags: count('flag-storyline') + count('flag-l10n-storyline'),
    orphanFlags: count('flag-orphan-media'),
    drawFromBank: count('bind-draw-from-bank'),
    locales: awaitStep?.kind === 'await-stack' ? awaitStep.expectedLocales.length : 0,
    l10nCells,
    l10nBatches: count('write-l10n'),
  };
}
