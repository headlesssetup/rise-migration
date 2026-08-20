// Executor step handlers — lifecycle (v0.9.0 restructure, phase B; split out of
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
import type { ExecCtx } from './executor-run-state';

  // Match the course's typefaces to the TARGET account by name (FETCH_TYPEFACES)
  // and recreate any custom font it lacks (upload .woff files → CREATE_TYPEFACE).
  // Returns source typeface id → target typeface id.
  export async function resolveAndRecreateTypefaces(
  ctx: ExecCtx,
    course: Record<string, unknown>,
    source: Map<string, Typeface>,
  ): Promise<Map<string, string>> {
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
    // Target typefaces are pre-fetched by the orchestrator against a live
    // existing course — FETCH_TYPEFACES 404s on a just-created course id.
    const target = deps.targetTypefaces ?? new Map<string, Typeface>();
    // Seed from the account-settings step (A): ids it already resolved/created
    // are reused as-is; only ids it didn't cover go through resolve/recreate.
    const seed = deps.typefaceIdMap ?? new Map<string, string>();
    const used = usedTypefaceIds(course);
    const unseeded = used.filter((id) => !seed.has(id));
    const { idMap, toRecreate, unresolved } = resolveTypefaces(unseeded, source, targetByName(target));
    for (const [k, v] of seed) idMap.set(k, v);

    for (const tf of toRecreate) {
      const uploaded = new Map<string, { key: string; url: string; type: string; filename: string }>();
      for (const f of tf.fonts) {
        const filename = f.original ?? f.key.split('/').pop() ?? 'font.woff';
        const yurl = payloadOf(
          await send(env.getYurl({ courseId: ctx.newCourseId, filename, assetPath: 'fonts/' }), 'set-theme'),
        );
        const newKey = dryRun ? `rise/fonts/${mint()}.woff` : String(yurl.key ?? '');
        const url = String(yurl.url ?? '');
        const type = String(yurl.type ?? 'font/woff');
        if (!dryRun) {
          const bytes = await deps.readFontBytes?.(f.key);
          if (!bytes) {
            log(`WARN missing archived font bytes for ${f.key} (skipping)`);
            continue;
          }
          const put = await deps.relay(env.s3Put({ url, base64Body: bytes.base64, contentType: type }));
          result.envelopes.push({ step: 'set-theme', label: 'S3 PUT (font)' });
          if (!put.ok) throw new WriteError(`Font S3 PUT failed (HTTP ${put.status})`, 'set-theme', put.text);
        } else {
          result.envelopes.push({ step: 'set-theme', label: 'S3 PUT (font)' });
        }
        uploaded.set(f.key, { key: newKey, url, type, filename: String(yurl.filename ?? filename) });
      }
      if (uploaded.size === 0) {
        result.flags.push({ kind: 'typeface', detail: `Custom font "${tf.name}" has no archived bytes — provision it manually on the target` });
        continue;
      }
      const cresp = payloadOf(
        await send(env.createTypeface({ name: tf.name, fonts: buildCreateTypefaceFonts(tf, uploaded) }), 'set-theme'),
      );
      const newId = dryRun ? mint() : String(cresp.id ?? '');
      if (newId) idMap.set(tf.id, newId);
      else result.flags.push({ kind: 'typeface', detail: `CREATE_TYPEFACE returned no id for "${tf.name}"` });
    }
    for (const u of unresolved) {
      result.flags.push({ kind: 'typeface', detail: `Typeface ${u} not found on the target — set the font manually` });
    }
    return idMap;
  }

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
                log(`${pfx()} …    GET_COURSE not ready yet (attempt ${attempt}/${tries}, HTTP ${r.status})`);
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
          if ((src && src.size) || (deps.typefaceIdMap && deps.typefaceIdMap.size)) {
            const idMap = await resolveAndRecreateTypefaces(ctx, course, src ?? new Map());
            const applied = applyTypefaceIds(course, theme, idMap);
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
          } else {
            await send(env.updateCourseTheme(ctx.newCourseId, theme), step.kind);
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
            // The monolingual description rides the (single) `final` title
            // write; a stack's description is its own pre-conversion step.
            const desc = deps.input.course.course?.description;
            if (step.final && typeof desc === 'string' && desc) {
              await send(
                env.updateCourseFieldThrottle(ctx.newCourseId, 'description', desc),
                step.kind,
              );
            }
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
            remapMediaKeys(extra, keyMap),
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
            // freshClientIds FIRST: block/item ids that are not cuid-shaped (Rise's
            // sample courses number them "1","2","3"… in EVERY lesson) get a fresh
            // per-block id, so two lessons never claim the same block id. Then the
            // usual IdMap pass handles cuid-shaped ids + refs globally.
            const normalized = freshClientIds(withId, mint);
            ctx.normBlocks.set(blockKey(step.sourceLessonId, ref.sourceBlockId), normalized);
            const remappedSource = blankUploadedMediaKeys(
              remapIds(normalized, ids),
            ) as Record<string, unknown>;
            const remapped =
              ref.replacement === 'legacy-storyline'
                ? legacyStorylinePlaceholderBlock(remappedSource, mint)
                : remappedSource;
            const newBlockId = String(remapped.id ?? '');
            newIdToSource.set(newBlockId, ref.sourceBlockId);
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

