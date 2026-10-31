// Executor step handlers — lifecycle (v0.9.0 restructure, phase B; split out of
// executor.ts's switch; the switch itself stays THERE for union exhaustiveness,
// each case now one `await handleX(ctx, step)`). Bodies are verbatim moves;
// the characterization test freezes the envelope order they produce.

import {
  collectStructuralIds,
  freshClientIds,
  remapIds,
  blankUploadedMediaKeys,
  blankForeignMediaKeys,
  remapMediaKeys,
  retargetMediaHosts,
} from './remap';
import * as env from './envelopes';
import { findBankRef, type PlanStep } from './plan';
import {
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
import { remapBlockumentRefs } from '@/core/mondrian';
import { legacyStorylinePlaceholderBlock } from '@/core/storyline/compatibility';
import type { GetCourseDocument } from '@/shared/types/rise';
import type { ExecCtx } from './executor-run-state';
import { resolveAndRecreateTypefaces } from './executor-steps-typefaces';

// Moved to executor-steps-typefaces.ts (size cap); this path stays the door.
export { resolveAndRecreateTypefaces };

export async function handleCreateCourse(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'create-course' }>,
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
          const resp = await send(
            env.createCourseShell(deps.input.targetFolderId ?? 'all', step.courseType),
            step.kind,
          );
          ctx.newCourseId = dryRun ? ids.remap(step.sourceCourseId) : String(resp.id ?? '');
          if (!ctx.newCourseId) throw new WriteError('Course create returned no id', step.kind, JSON.stringify(resp));
          ids.set(step.sourceCourseId, ctx.newCourseId);
          result.newCourseId = ctx.newCourseId;
          // INVARIANT — materialization handshake (mirror the editor): a real
          // GET_COURSE on the new id BEFORE any write. Rise's editor always reads the
          // course on open; `POST /content` returns a fully-materialized course
          // (capture-confirmed: GET_COURSE 200 immediately). We pace before each
          // attempt and RETRY a few times — a couple seconds of slack absorbs any
          // replication lag and matches the editor's own create→open delay. If the
          // course never confirms, the shell is broken → fail now (rollback) rather
          // than build on a course that 404s GET_COURSE yet 500s the dashboard.
          if (!dryRun) {
            const tries = Math.max(1, deps.courseHandshakeTries ?? 3);
            let confirmed = false;
            for (let attempt = 1; attempt <= tries && !confirmed; attempt++) {
              await pace(); // ≥ one paced gap after POST before reading back
              const spec = env.getCourse(ctx.newCourseId);
              result.envelopes.push({ step: step.kind, label: spec.label });
              const r = await deps.relay(spec);
              const rb = r.ok ? payloadOf(parseJson(r.text)) : {};
              if (r.ok && rb.course && typeof rb.course === 'object') {
                log(`${pfx()} OK   GET_COURSE handshake — course ready (attempt ${attempt}/${tries})`);
                confirmed = true;
                ctx.materialized = true;
                // The target's own server-assigned shareId — exportSettings
                // must carry THIS, never the source's (foreign ref).
                const share = (rb.course as Record<string, unknown>).shareId;
                if (typeof share === 'string' && share) ctx.targetShareId = share;
                if (Array.isArray(rb.labelSets)) {
                  ctx.targetLabelSets = (rb.labelSets as unknown[]).filter(
                    (x): x is Record<string, unknown> => !!x && typeof x === 'object',
                  );
                }
                // F2: record any PRE-CREATED shell lessons (onePage ships one:
                // title "", type "blocks", no items) for adoption below. Only
                // genuinely EMPTY lessons qualify — anything else is unexpected
                // and left alone (the read-back would surface it loudly).
                const shell = Array.isArray(rb.lessons)
                  ? (rb.lessons as Record<string, unknown>[])
                  : [];
                for (const l of shell) {
                  const emptyTitle = l.title === '' || l.title === null || l.title === undefined;
                  const noItems = !Array.isArray(l.items) || l.items.length === 0;
                  if (typeof l.id === 'string' && l.id && emptyTitle && noItems) {
                    shellLessons.push({ id: l.id });
                  } else if (typeof l.id === 'string') {
                    log(
                      `${pfx()} ⚠ shell lesson ${l.id} is not empty (title/items present) — not adopting it`,
                    );
                  }
                }
                if (shellLessons.length) {
                  log(
                    `${pfx()} NOTE shell ships ${shellLessons.length} pre-created lesson(s) (onePage) — lesson 1 will ADOPT it, not duplicate it`,
                  );
                }
              } else {
                // "status N", not "HTTP N": an expected poll in a bounded retry
                // loop must not paint red like a real HTTP failure.
                log(`${pfx()} …    GET_COURSE not ready yet (attempt ${attempt}/${tries}, status ${r.status} — retrying)`);
              }
            }
            if (!confirmed) {
              throw new WriteError(
                'Post-create GET_COURSE never confirmed the course ctx.materialized',
                step.kind,
              );
            }
          }
}

export async function handleSetTheme(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'set-theme' }>,
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
          const course = (deps.input.course.course ?? {}) as Record<string, unknown>;
          // Theme round-trips verbatim EXCEPT any user-uploaded cover/header key
          // (rise/courses/<srcId>/…) which would be a dead source key on target —
          // blank those (flagged as unsupported-media); built-in cdn/asset theme
          // images are kept as-is.
          const theme = blankUploadedMediaKeys(course.theme ?? {}) as Record<string, unknown>;

          // Typography: typeface ids are account-specific, so match the source's
          // fonts to the TARGET account by name and recreate any custom font it
          // lacks — otherwise the course renders with the wrong (default) font.
          const src = deps.sourceTypefaces;
          const hasMap = !!((src && src.size) || (deps.typefaceIdMap && deps.typefaceIdMap.size));
          // Without an account typeface export (a course-only archive) the ids are
          // sent UNCHANGED rather than omitted: the TOP-LEVEL heading/body/ui slots
          // are the authoritative binding (envelopes §7), while `theme.*TypefaceId`
          // can be stale leftovers of the theme the course was duplicated from.
          // Writing the theme alone made Rise adopt those stale ids (VAS 2026-10-28:
          // theme said Lato/Merriweather, course said Source Sans Pro → read-back
          // `course-field-changed`). Unchanged ids are exact within the same
          // account; across accounts the read-back still catches a wrong font.
          const idMap = hasMap
            ? await resolveAndRecreateTypefaces(ctx, course, src ?? new Map())
            : new Map<string, string>();
          if (!hasMap) {
            log(
              `${pfx()} ⚠ no account typeface export — sending the course's typeface ids unchanged (exact within the same account; the read-back verifies the fonts)`,
            );
          }
          const applied = applyTypefaceIds(course, theme, idMap);
          if (!applied.headingTypefaceId && !applied.bodyTypefaceId && !applied.uiTypefaceId) {
            // Nothing to bind (a course doc without any typeface slot) — the
            // theme-only envelope is the exact round-trip.
            await send(env.updateCourseTheme(ctx.newCourseId, theme), step.kind);
          } else {
            await send(
              env.updateCourseThemeAndTypefaces({
                courseId: ctx.newCourseId,
                theme: applied.theme,
                headingTypefaceId: applied.headingTypefaceId,
                bodyTypefaceId: applied.bodyTypefaceId,
                uiTypefaceId: applied.uiTypefaceId,
              }),
              step.kind,
            );
          }
}

export async function handleSetTitle(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'set-title' }>,
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
          // Best-effort: never abort a whole course import over a cosmetic
          // title/description (confirmed envelope, but flag if it doesn't take).
          try {
            await send(env.updateCourseTitle(ctx.newCourseId, step.title), step.kind);
            // The description is its own `set-course-description` step — LAST
            // on a monolingual course (after every upload, so its media refs
            // remap), pre-conversion on a stack.
          } catch (e) {
            log(`WARN title/description not set (continuing): ${(e as Error).message}`);
            result.flags.push({
              kind: 'title',
              detail: `Course title "${step.title}" could not be set automatically — rename manually`,
            });
          }
}

export async function handleCreateLesson(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'create-lesson' }>,
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
          // F2 ADOPTION: a onePage shell already holds ONE empty lesson (title
          // "", type blocks, no items — capture-proven) which the editor writes
          // straight into; creating our own would leave a phantom extra lesson.
          // Adopt an unclaimed shell lesson instead of CREATE_LESSON — but only
          // when this step's intended title is ALSO empty (a microlearning
          // lesson has no title by design, so empty IS the faithful state; no
          // captured envelope renames a lesson, so a titled lesson 1 must be
          // created normally and the read-back will surface the extra lesson).
          if (!dryRun && shellLessons.length > 0 && step.title === '') {
            const adopted = shellLessons.shift()!;
            ids.set(step.sourceLessonId, adopted.id);
            log(
              `${pfx()} OK   adopted the shell's pre-created lesson ${adopted.id} as "${step.sourceLessonId}" (no CREATE_LESSON)`,
            );
            return;
          }
          // Always a PLAIN title: a stack's lessons are built in the default
          // language (materialized) and the conversion extracts titles into
          // cells itself — idea 2 ships no l10n refs and no inline cells.
          const resp = await send(
            env.createLesson({
              author,
              courseId: ctx.newCourseId,
              position: step.position,
              title: step.title,
              type: step.lessonType,
            }),
            step.kind,
          );
          const lesson = payloadOf(resp).lesson as Record<string, unknown> | undefined;
          const newLessonId = dryRun
            ? ids.remap(step.sourceLessonId)
            : String(lesson?.id ?? '');
          if (!newLessonId) throw new WriteError('CREATE_LESSON returned no lesson id', step.kind, JSON.stringify(resp));
          ids.set(step.sourceLessonId, newLessonId);
}

export async function handleUpdateLesson(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'update-lesson' }>,
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
          const newLessonId = ids.get(step.sourceLessonId)!;
          const src = srcLessons.get(step.sourceLessonId);
          const extra: Record<string, unknown> = {};
          for (const k of ['headerImage', 'description', 'settings', 'media', 'piles']) {
            if (src && k in src) extra[k] = (src as Record<string, unknown>)[k];
          }
          // Lesson media (header image / media) uploaded by the preceding
          // `upload-lesson-media` steps is in keyMap → remap it to the new target
          // key; anything NOT uploaded (oversize/orphan/none) is blanked so a dead
          // source key is never written to the target lesson.
          const safeExtra = blankForeignMediaKeys(
            retargetMediaHosts(remapMediaKeys(extra, keyMap), deps.targetPlane),
            new Set(ctx.newCourseId ? [ctx.newCourseId] : []),
          ) as Record<string, unknown>;
          await send(
            env.updateLesson({
              id: newLessonId,
              courseId: ctx.newCourseId,
              type: step.lessonType,
              icon: step.icon,
              extra: safeExtra,
            }),
            step.kind,
          );
}

export async function handleLockLesson(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'lock-lesson' }>,
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
          // Best-effort: never abort the import on a lock failure.
          try {
            await send(env.putLock(ids.get(step.sourceLessonId)!, ctx.newCourseId), step.kind);
          } catch (e) {
            log(`WARN lock failed (continuing): ${(e as Error).message}`);
          }
}

export async function handleUnlockLesson(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'unlock-lesson' }>,
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
          try {
            await send(env.delLock(ids.get(step.sourceLessonId)!, ctx.newCourseId), step.kind);
          } catch (e) {
            log(`WARN unlock failed (ignored): ${(e as Error).message}`);
          }
}

export async function handleCreateBlocks(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'create-blocks' }>,
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
          const newLessonId = ids.get(step.sourceLessonId)!;
          // Build ALL of the lesson's blocks in source order, copy-faithful:
          // regenerate ids + strip server fields, then blank uploaded media keys
          // (filled by the patch step after re-upload). One ordered insert keeps
          // block order deterministic.
          const newIdToSource = new Map<string, string>();
          const built: Record<string, unknown>[] = [];
          for (const ref of step.blocks) {
            const entry = srcBlocks.get(blockKey(step.sourceLessonId, ref.sourceBlockId));
            if (!entry) {
              throw new WriteError(
                `Source block ${ref.sourceBlockId} not found in lesson ${step.sourceLessonId}`,
                step.kind,
              );
            }
            // A block id is client-generated and ours to choose; a source block
            // with a missing/non-string id ships under its positional `noid:<n>`
            // key (sourceBlockIdOf) so freshClientIds mints it a real one below.
            const src = entry.block as Record<string, unknown>;
            const withId =
              typeof src.id === 'string' && src.id !== ''
                ? entry.block
                : ({ ...src, id: ref.sourceBlockId } as typeof entry.block);
            // freshClientIds FIRST: block/item/answer ids that are not
            // cuid-shaped (Rise's sample courses number them "1","2","3"… in
            // EVERY lesson) OR that are REUSED across blocks (copy-paste
            // provenance carries cuid-shaped duplicates too — Mercedes capture
            // 2026-08-31) get a fresh per-block id, so two blocks never claim
            // the same identity. Then the usual IdMap pass handles the
            // remaining (unique) cuid-shaped ids + refs globally.
            const normalized = freshClientIds(withId, mint, ctx.dupStructuralIds);
            ctx.normBlocks.set(blockKey(step.sourceLessonId, ref.sourceBlockId), normalized);
            const remappedSource = blankUploadedMediaKeys(
              remapIds(normalized, ids),
            ) as Record<string, unknown>;
            // Mondrian (Custom block) cross-refs: swap every `blockumentId` to
            // the blockument recreated by the create-blockument step. A source
            // id with no recreated counterpart ABORTS — shipping it verbatim is
            // the dangling ref that 404s preview/publish boot (2026-08-31).
            const { doc: withBlockuments, unmapped } = remapBlockumentRefs(
              remappedSource,
              ctx.blockumentMap,
            );
            if (unmapped.length > 0) {
              throw new WriteError(
                `Block ${ref.sourceBlockId} references blockument(s) with no recreated target counterpart: ` +
                  unmapped.map((u) => `${u.id} at ${u.path}`).join(', '),
                step.kind,
              );
            }
            const remapped =
              ref.replacement === 'legacy-storyline'
                ? legacyStorylinePlaceholderBlock(withBlockuments, mint)
                : withBlockuments;
            const newBlockId = String(remapped.id ?? '');
            newIdToSource.set(newBlockId, ref.sourceBlockId);
            // Loud-fail assertion (handover 2026-08-31, blocker 1): a generated
            // structural id claimed by TWO different blocks is a remap code
            // fault — the exact defect class that silently clobbers content.
            const bk = blockKey(step.sourceLessonId, ref.sourceBlockId);
            for (const sid of new Set(collectStructuralIds(remapped))) {
              const owner = ctx.builtStructuralIds.get(sid);
              if (owner !== undefined && owner !== bk) {
                throw new WriteError(
                  `Generated structural id collision: "${sid}" is claimed by both ${owner} and ${bk} — remap fault, aborting course`,
                  step.kind,
                );
              }
              ctx.builtStructuralIds.set(sid, bk);
            }
            built.push(remapped);
            // Provisional mapping (confirmed below in a live run).
            blockMeta.set(blockKey(step.sourceLessonId, ref.sourceBlockId), { newId: newBlockId });
          }
          // Idea 2: stack blocks ship MATERIALIZED (srcBlocks indexes the
          // materialized doc) — plain default-language values, no refs, no
          // inline translationChanges. The conversion l10n-ifies them itself.
          const resp = await send(
            env.createBlocks({
              courseId: ctx.newCourseId,
              lessonId: newLessonId,
              previousBlockId: null,
              blocks: built,
            }),
            step.kind,
          );
          if (!dryRun) {
            const p = payloadOf(resp);
            const metas = Array.isArray(p.blockMetadata)
              ? (p.blockMetadata as Record<string, unknown>[])
              : [];
            if (p.success !== true || metas.length !== built.length) {
              throw new WriteError(
                `CREATE_BLOCKS did not confirm all ${built.length} block(s)`,
                step.kind,
                JSON.stringify(resp),
              );
            }
            for (const meta of metas) {
              const newBlockId = String(meta.id ?? '');
              const src = newIdToSource.get(newBlockId);
              if (!src) {
                throw new WriteError(
                  `CREATE_BLOCKS returned an unexpected block id ${newBlockId}`,
                  step.kind,
                  JSON.stringify(resp),
                );
              }
              blockMeta.set(blockKey(step.sourceLessonId, src), {
                newId: newBlockId,
                globalBlockId:
                  typeof meta.globalBlockId === 'string' ? meta.globalBlockId : undefined,
              });
            }
          }
}

