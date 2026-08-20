// The per-lesson / course-image PLANNERS — the two big closures split out of
// buildPlan (v0.9.0 restructure). makeLessonPlanners(ctx) closes over the SAME
// objects buildPlan creates (steps, handledKeys, postAwaitSteps, …), so the
// bodies below are verbatim moves with identical mutation semantics; the
// characterization test freezes the emitted step order.

import { collectAssetKeys } from '@/core/assets/keys';
import { isKnownLegacyStorylineBlock } from '@/core/storyline/compatibility';
import type { Block, Lesson } from '@/shared/types/rise';
import { courseImageKind } from './builtin-assets';
// Type-only/runtime imports back from executor-types stay cycle-free (see plan.ts).
import { blockKey } from './executor-types';
import {
  DRAW_FROM_BANK,
  coverCardImageKey,
  courseMediaImageKey,
  fileBasename,
  findBankRef,
  isDrawFromBank,
  isStoryline,
  lessonTitle,
  storylineCellId,
} from './plan-helpers';
import {
  approxMb,
  exceedsUploadLimit,
  type AssetEntry,
  type PlanInput,
  type PlanStep,
} from './plan-types';

/** Everything the planners mutate/consult — the exact objects buildPlan owns. */
export interface LessonPlanContext {
  steps: PlanStep[];
  input: PlanInput;
  stack: boolean;
  sourceCourseId: string;
  assetByKey: Map<string, AssetEntry>;
  handledKeys: Set<string>;
  stackDefaultLocale: string;
  postAwaitSteps: PlanStep[];
  rawStorylineCellByBlock: Map<string, string>;
  stackStorylineAttached: Map<string, Set<string>>;
  storylineCellLocales: (l10nId: string) => string[];
}

export function makeLessonPlanners(ctx: LessonPlanContext) {
  const {
    steps,
    input,
    stack,
    sourceCourseId,
    assetByKey,
    handledKeys,
    stackDefaultLocale,
    postAwaitSteps,
    rawStorylineCellByBlock,
    stackStorylineAttached,
    storylineCellLocales,
  } = ctx;

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
        if (entry?.optionalUnavailable) continue;
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
      if (entry?.optionalUnavailable) continue;
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
        ...(!stack && isStoryline(b) && isKnownLegacyStorylineBlock(b)
          ? { replacement: 'legacy-storyline' as const }
          : {}),
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
        const legacy = isKnownLegacyStorylineBlock(block);
        const attach = input.storylineAttach?.get(blockKey(sourceLessonId, sourceBlockId));
        // On a STACK (idea 2) each language's package lives in its own cell
        // (docs/rise-multilang.md §4.3b). The DEFAULT locale's package attaches
        // like a monolingual block DURING the pre-conversion build (a plain
        // media patch — the conversion then l10n-ifies OUR attached object into
        // the ref + default cell). Every NON-default locale attaches AFTER the
        // conversion via a storyline CELL write, addressed through the pairing
        // map — those steps are DEFERRED to the post-await section. Languages
        // with no staged package are flagged by the flag-l10n-storyline sweep.
        if (stack) {
          // The ref lives on the RAW source block (this loop walks the
          // materialized twin, where the slot holds the resolved object).
          const cellId = rawStorylineCellByBlock.get(blockKey(sourceLessonId, sourceBlockId)) ?? null;
          const attached = cellId ? stackStorylineAttached.get(cellId) : undefined;
          const cellLocales = cellId ? storylineCellLocales(cellId) : [];
          const defPkg = input.storylineAttachL10n?.get(
            `${blockKey(sourceLessonId, sourceBlockId)}|${stackDefaultLocale}`,
          );
          if (defPkg) {
            steps.push({
              kind: 'attach-storyline',
              sourceLessonId,
              sourceBlockId,
              reviewPrefix: defPkg.reviewPrefix,
              meta: defPkg.meta,
              title: defPkg.title,
              summary: `Attach Storyline [${stackDefaultLocale}] from ${defPkg.reviewPrefix} (default language, pre-conversion)`,
            });
            if (cellId) attached?.add(stackDefaultLocale);
          }
          for (const locale of cellLocales) {
            if (locale === stackDefaultLocale) continue;
            const pkg = input.storylineAttachL10n?.get(
              `${blockKey(sourceLessonId, sourceBlockId)}|${locale}`,
            );
            if (!pkg || !cellId) continue;
            postAwaitSteps.push({
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
          if (cellLocales.length === 0 && !defPkg) {
            steps.push({
              kind: 'flag-storyline',
              sourceLessonId,
              sourceBlockId,
              summary: `⚠ Storyline/Mighty block (multi-language) has no package to copy — check it manually`,
            });
          }
          continue;
        }
        if (legacy) {
          steps.push({
            kind: 'flag-storyline',
            sourceLessonId,
            sourceBlockId,
            reason: 'legacy',
            summary: `⚠ Legacy Storyline block replaced with a manual-review placeholder`,
          });
        } else if (attach) {
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
            reason: 'missing-package',
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
        if (entry?.optionalUnavailable) continue;
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

  return { planCourseImages, planLessonBody };
}
