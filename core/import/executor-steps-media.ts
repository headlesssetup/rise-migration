// Executor step handlers — media (v0.9.0 restructure, phase B; split out of
// executor.ts's switch; the switch itself stays THERE for union exhaustiveness,
// each case now one `await handleX(ctx, step)`). Bodies are verbatim moves;
// the characterization test freezes the envelope order they produce.

import {
  freshClientIds,
  remapIds,
  blankUploadedMediaKeys,
  blankForeignMediaKeys,
  remapMediaKeys,
} from './remap';
import * as env from './envelopes';
import { findBankRef, type PlanStep } from './plan';
import {
  targetByName,
  usedTypefaceIds,
  resolveTypefaces,
  buildCreateTypefaceFonts,
  applyTypefaceIds,
  type Typeface,
} from './typefaces';
import {
  WriteError,
  parseJson,
  payloadOf,
  indexSource,
  blockKey,
  authorProfile,
} from './executor-types';
import {
  defaultLocaleOf,
  isL10nRef,
  isLocalizedStack,
  materializeLocale,
  pairL10nRefs,
  writableLocaleCodes,
  type L10nChange,
} from '@/core/l10n';
import { hasBuiltinRef } from './builtin-assets';
import { legacyStorylinePlaceholderBlock } from '@/core/storyline/compatibility';
import type { GetCourseDocument } from '@/shared/types/rise';
import type { AssetBytes } from './executor-types';
import type { ExecCtx } from './executor-run-state';

  // Faithful upload of a single course-image key — cover/card/logo/lesson-header
  // (GET_YURL → S3 PUT of the exact exported bytes). No CRUSH — the source
  // already carries both `key` and `crushedKey`, and each is uploaded + remapped
  // on its own, verbatim. Dedups through the global keyMap (a key shared by
  // coverImage and cardImage uploads once). Missing archived bytes are handled
  // like block media: flag + blank (keyMap → ''), so UPDATE_COURSE ships without
  // the image and the course succeeds with a flag instead of hard-failing the
  // final assertion after all writes.
  export async function uploadImageAsset(ctx: ExecCtx, sourceKey: string): Promise<string | null> {
  const {
    deps,
    ids,
    mint,
    pace,
    log,
    dryRun,
    author,
    result,
    shellLessons,
    blockMeta,
    keyMap,
    bankQuestionIds,
    stack,
    srcTables,
    srcDefaultLocale,
    stackRefMap,
    matDoc,
    srcLessons,
    srcBlocks,
    unmatchedCourseRefs,
    pfx,
    send,
    reportOrphanShell,
    uploadOne,
    buildCellChange,
    noteBuiltins,
  } = ctx;
    const cached = keyMap.get(sourceKey);
    if (cached !== undefined) {
      log(`${pfx()} reuse ${sourceKey} (already ${cached ? 'uploaded' : 'blanked'})`);
      return cached || null;
    }
    let bytes: AssetBytes | null = null;
    if (!dryRun) {
      bytes = await deps.readAsset(sourceKey);
      if (!bytes) {
        log(`${pfx()} WARN missing archived bytes for course image ${sourceKey} — flagged, image blanked`);
        result.flags.push({
          kind: 'orphan-media',
          sourceKey,
          detail: 'Course image has no archived bytes (deleted at source) — imported with the image blanked',
        });
        keyMap.set(sourceKey, '');
        return null;
      }
    }
    const filename = sourceKey.split('/').pop() ?? 'image.jpg';
    const yurl = payloadOf(await send(env.getYurl({ courseId: ctx.newCourseId, filename }), 'set-course-images'));
    const newKey = dryRun ? `rise/courses/${ctx.newCourseId}/${mint()}.jpg` : String(yurl.key ?? '');
    const url = String(yurl.url ?? '');
    const ctype = String(yurl.type ?? 'image/jpeg');
    if (!dryRun && bytes) {
      if (!newKey || !url) throw new WriteError('GET_YURL returned no key/url (cover)', 'set-course-images', JSON.stringify(yurl));
      const put = await deps.relay(env.s3Put({ url, base64Body: bytes.base64, contentType: ctype }));
      result.envelopes.push({ step: 'set-course-images', label: 'S3 PUT (cover)' });
      if (!put.ok) throw new WriteError(`Cover S3 PUT failed (HTTP ${put.status})`, 'set-course-images', put.text);
    } else {
      result.envelopes.push({ step: 'set-course-images', label: 'S3 PUT (cover)' });
    }
    keyMap.set(sourceKey, newKey);
    return newKey;
  }

export async function handleSetCourseImages(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'set-course-images' }>,
): Promise<void> {
  const {
    deps,
    ids,
    mint,
    pace,
    log,
    dryRun,
    author,
    result,
    shellLessons,
    blockMeta,
    keyMap,
    bankQuestionIds,
    stack,
    srcTables,
    srcDefaultLocale,
    stackRefMap,
    matDoc,
    srcLessons,
    srcBlocks,
    unmatchedCourseRefs,
    pfx,
    send,
    reportOrphanShell,
    uploadOne,
    buildCellChange,
    noteBuiltins,
  } = ctx;
          // Stack: the raw course fields are {l10nId} refs — the image OBJECTS
          // live in the tables. Use the materialized default locale (this step
          // runs PRE-conversion on a stack; the conversion re-extracts the plain
          // objects into refs + cells itself).
          const course = ((stack ? matDoc.course : deps.input.course.course) ??
            {}) as Record<string, unknown>;
          // Faithful round-trip of any course-level image object (coverImage/
          // cardImage `{media:{image}}`, the `media` logo `{image}`, or
          // lessonHeaderImage which may nest an uncropped `originalImage`). Upload
          // EVERY course/bank key found anywhere in the object — key, crushedKey,
          // originalImage.* — so none survives as a source key, then remap.
          const build = async (img: unknown, where: string): Promise<unknown | undefined> => {
            const keys = new Set<string>();
            const walk = (o: unknown): void => {
              if (typeof o === 'string') {
                if (/^rise\/(?:courses|questionBanks)\//.test(o)) keys.add(o);
              } else if (Array.isArray(o)) {
                o.forEach(walk);
              } else if (o && typeof o === 'object') {
                Object.values(o).forEach(walk);
              }
            };
            walk(img);
            if (keys.size === 0) {
              // No account media — but a BUILT-IN (library/CDN) reference is
              // copyable as-is: ship the object verbatim. Nothing to upload; a
              // library asset has no per-account copy, and inventing one for a
              // possibly region-restricted asset is not ours to decide.
              if (hasBuiltinRef(img)) {
                await noteBuiltins(img, where);
                return img;
              }
              return undefined;
            }
            const km = new Map<string, string>();
            for (const k of keys) {
              // null = no archived bytes → flagged + blanked (keyMap → '') by
              // uploadImageAsset, so the payload strips the dead source key.
              km.set(k, (await uploadImageAsset(ctx, k)) ?? '');
            }
            // Every key orphaned → ship the course without this image entirely
            // (flagged), not an image object full of empty keys.
            if (![...km.values()].some(Boolean)) return undefined;
            return remapMediaKeys(img, km);
          };
          const coverImage = step.hasCover
            ? await build(course.coverImage, 'course cover image')
            : undefined;
          const cardImage = step.hasCard
            ? await build(course.cardImage, 'course card image')
            : undefined;
          const media = step.hasMedia ? await build(course.media, 'course logo') : undefined;
          const lessonHeaderImage = step.hasLessonHeader
            ? await build(course.lessonHeaderImage, 'course lesson-header image')
            : undefined;
          if (
            coverImage !== undefined ||
            cardImage !== undefined ||
            media !== undefined ||
            lessonHeaderImage !== undefined
          ) {
            await send(
              env.setCourseImages({ courseId: ctx.newCourseId, coverImage, cardImage, media, lessonHeaderImage }),
              step.kind,
            );
          }
}

export async function handleUploadAsset(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'upload-asset' }>,
): Promise<void> {
  const {
    deps,
    ids,
    mint,
    pace,
    log,
    dryRun,
    author,
    result,
    shellLessons,
    blockMeta,
    keyMap,
    bankQuestionIds,
    stack,
    srcTables,
    srcDefaultLocale,
    stackRefMap,
    matDoc,
    srcLessons,
    srcBlocks,
    unmatchedCourseRefs,
    pfx,
    send,
    reportOrphanShell,
    uploadOne,
    buildCellChange,
    noteBuiltins,
  } = ctx;
          // Dedup + size-guard + faithful upload (shared with lesson media). The
          // plan emits an upload step per (block, key), so the SAME source key can
          // recur — uploadOne reuses an already-uploaded key (upload once).
          await uploadOne(step.sourceKey, step.filename, step.kind);
}

export async function handleUploadLessonMedia(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'upload-lesson-media' }>,
): Promise<void> {
  const {
    deps,
    ids,
    mint,
    pace,
    log,
    dryRun,
    author,
    result,
    shellLessons,
    blockMeta,
    keyMap,
    bankQuestionIds,
    stack,
    srcTables,
    srcDefaultLocale,
    stackRefMap,
    matDoc,
    srcLessons,
    srcBlocks,
    unmatchedCourseRefs,
    pfx,
    send,
    reportOrphanShell,
    uploadOne,
    buildCellChange,
    noteBuiltins,
  } = ctx;
          // Lesson header / media — uploaded BEFORE this lesson's UPDATE_LESSON so
          // the lesson payload (built in update-lesson) carries the remapped key.
          await uploadOne(step.sourceKey, step.filename, step.kind);
}

export async function handlePatchBlockMedia(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'patch-block-media' }>,
): Promise<void> {
  const {
    deps,
    ids,
    mint,
    pace,
    log,
    dryRun,
    author,
    result,
    shellLessons,
    blockMeta,
    keyMap,
    bankQuestionIds,
    stack,
    srcTables,
    srcDefaultLocale,
    stackRefMap,
    matDoc,
    srcLessons,
    srcBlocks,
    unmatchedCourseRefs,
    pfx,
    send,
    reportOrphanShell,
    uploadOne,
    buildCellChange,
    noteBuiltins,
  } = ctx;
          const entry = srcBlocks.get(blockKey(step.sourceLessonId, step.sourceBlockId));
          const meta = blockMeta.get(blockKey(step.sourceLessonId, step.sourceBlockId));
          if (!entry || !meta) throw new WriteError('patch before block create', step.kind);
          const newLessonId = ids.get(step.sourceLessonId)!;
          // Build the patched block: remap ids, then swap source keys → new keys.
          const patched = remapMediaKeys(remapIds(entry.block, ids), keyMap);
          await send(
            env.updateBlockDebounce({
              id: meta.newId,
              courseId: ctx.newCourseId,
              lessonId: newLessonId,
              item: patched,
            }),
            step.kind,
          );
}

export async function handleFlagOrphanMedia(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'flag-orphan-media' }>,
): Promise<void> {
  const {
    deps,
    ids,
    mint,
    pace,
    log,
    dryRun,
    author,
    result,
    shellLessons,
    blockMeta,
    keyMap,
    bankQuestionIds,
    stack,
    srcTables,
    srcDefaultLocale,
    stackRefMap,
    matDoc,
    srcLessons,
    srcBlocks,
    unmatchedCourseRefs,
    pfx,
    send,
    reportOrphanShell,
    uploadOne,
    buildCellChange,
    noteBuiltins,
  } = ctx;
          result.flags.push({
            kind: 'orphan-media',
            sourceBlockId: step.sourceBlockId,
            sourceLessonId: step.sourceLessonId,
            sourceKey: step.sourceKey,
            detail: 'Media is 403/deleted at source — imported with the media slot blanked',
          });
          // Blank the key so every later payload built via remapMediaKeys (block
          // patch / lesson update / course images / the final rebuild assertion)
          // strips the dead source key instead of shipping it verbatim.
          keyMap.set(step.sourceKey, '');
          log(`${pfx()} ⚠ FLAG orphan-media — ${step.sourceKey} (deleted at source)`);
}

export async function handleDropOptionalMedia(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'drop-optional-media' }>,
): Promise<void> {
  const {
    deps,
    ids,
    mint,
    pace,
    log,
    dryRun,
    author,
    result,
    shellLessons,
    blockMeta,
    keyMap,
    bankQuestionIds,
    stack,
    srcTables,
    srcDefaultLocale,
    stackRefMap,
    matDoc,
    srcLessons,
    srcBlocks,
    unmatchedCourseRefs,
    pfx,
    send,
    reportOrphanShell,
    uploadOne,
    buildCellChange,
    noteBuiltins,
  } = ctx;
          // Capture-confirmed non-rendering provenance (pre-transcode inputs,
          // temp media, original crop sources, inactive image variants). It is
          // safe to omit, but the source key must never leak into target JSON.
          keyMap.set(step.sourceKey, '');
          log(`${pfx()} Drop optional ${step.reason} — ${step.sourceKey}`);
}

export async function handleFlagUnsupportedMedia(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'flag-unsupported-media' }>,
): Promise<void> {
  const {
    deps,
    ids,
    mint,
    pace,
    log,
    dryRun,
    author,
    result,
    shellLessons,
    blockMeta,
    keyMap,
    bankQuestionIds,
    stack,
    srcTables,
    srcDefaultLocale,
    stackRefMap,
    matDoc,
    srcLessons,
    srcBlocks,
    unmatchedCourseRefs,
    pfx,
    send,
    reportOrphanShell,
    uploadOne,
    buildCellChange,
    noteBuiltins,
  } = ctx;
          result.flags.push({
            kind: 'unsupported-media',
            sourceKey: step.sourceKey,
            detail: `Media at ${step.location} has no captured write path — attach manually (not written as a source key)`,
          });
          // Blank the key so any later remap (block patch / lesson payload / final
          // rebuild) writes empty media, never a dead source key.
          keyMap.set(step.sourceKey, '');
          log(`${pfx()} ⚠ FLAG unsupported-media — ${step.sourceKey} (${step.location})`);
}

