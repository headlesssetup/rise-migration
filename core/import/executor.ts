// Phase 3 — the import EXECUTOR. Walks the plan (core/import/plan.ts) and, for
// each step, builds the write envelope(s) (core/import/envelopes.ts), relays them
// through an injected Relay (the background runs them in the live Rise tab),
// asserts the response shape (loud-fail, protocol §12), and records server-
// assigned ids into the IdMap (resumable job log, §6). Strictly sequential +
// human-paced; DRY-RUN collects the envelopes without sending.
//
// All I/O is injected so the whole executor is unit-testable without a browser
// or a live Rise account.

import { IdMap, newId } from './ids';
import {
  remapIds,
  blankUploadedMediaKeys,
  blankForeignMediaKeys,
  remapMediaKeys,
  findForeignMediaKeys,
} from './remap';
import * as env from './envelopes';
import type { WriteSpec } from './envelopes';
import { findBankRef, MAX_UPLOAD_BASE64, type PlanStep, type PlanInput, type SourceBank } from './plan';
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
  authorProfile,
} from './executor-types';
import type { ExecutorDeps, ExecResult, AssetBytes } from './executor-types';

// Re-export the executor contracts/types so `@/core/import` keeps the same
// surface after they moved to ./executor-types (see that file's header).
export {
  summarizeFlags,
  WriteError,
  type RelayResponse,
  type Relay,
  type AssetBytes,
  type ExecutorDeps,
  type ManualFlag,
  type ExecResult,
} from './executor-types';

export async function executePlan(
  steps: PlanStep[],
  deps: ExecutorDeps,
): Promise<ExecResult> {
  const mint = deps.mintId ?? newId;
  const ids = deps.ids ?? new IdMap(mint);
  const pace = deps.pace ?? (async () => {});
  const log = deps.log ?? (() => {});
  const dryRun = deps.dryRun ?? false;
  const { lessons: srcLessons, blocks: srcBlocks } = indexSource(deps.input.course);
  const author = deps.input.author;

  const result: ExecResult = {
    ok: false,
    dryRun,
    envelopes: [],
    flags: [],
    idMap: {},
    survivingKeys: [],
  };

  // Per-run runtime state.
  let newCourseId = '';
  // Confirmed real by the post-create GET_COURSE handshake (mirror the editor).
  // Capture shows POST /content already returns a fully-materialized course, so the
  // handshake 200 — not any later write — is what proves the shell is real. If it
  // never gets set (handshake failed / skipped), the rollback treats the shell as
  // suspect rather than reporting a hollow success.
  let materialized = false;
  // sourceBlockId → {newId, globalBlockId} (from CREATE_BLOCKS metadata).
  const blockMeta = new Map<string, { newId: string; globalBlockId?: string }>();
  // sourceKey → new target key (after upload) for media patches.
  const keyMap = new Map<string, string>();
  // sourceBankId → ordered new question ids (for INSERT_QUESTION_BANK_QUESTIONS).
  const bankQuestionIds = new Map<string, string[]>();

  // Progress: a 1-based step counter (set in the loop) → `[i/N]` log prefix.
  const total = steps.length;
  let stepIdx = 0;
  const pfx = (): string => `[${stepIdx}/${total}]`;

  // Relay + loud-fail wrapper. In dry-run, record the envelope and return a
  // synthetic empty body (callers synthesize ids separately).
  async function send(spec: WriteSpec, step: PlanStep['kind']): Promise<Record<string, unknown>> {
    result.envelopes.push({ step, label: spec.label });
    // REST envelopes already embed the method in their label ("POST /manage/api/…");
    // ducks labels are bare ("rise/lessons/CREATE_LESSON"). Only prepend the method
    // when it isn't already there, so we don't log "POST POST /manage/api/…".
    const where = spec.label.startsWith(`${spec.method} `)
      ? spec.label
      : `${spec.method} ${spec.label}`;
    if (dryRun) {
      log(`${pfx()} DRY  ${where}`);
      return {};
    }
    await pace();
    const r = await deps.relay(spec);
    if (!r.ok) {
      throw new WriteError(
        `${spec.label} failed (HTTP ${r.status}${r.error ? `: ${r.error}` : ''})`,
        step,
        r.text,
      );
    }
    log(`${pfx()} OK   ${where}`);
    return parseJson(r.text);
  }

  // Report (do NOT delete) a created shell whose import failed before the
  // GET_COURSE handshake confirmed it. Automatic deletion is intentionally
  // disabled (operator decision: no delete actions fire automatically until
  // deletion is better researched) — the orphaned shell is left in place and
  // surfaced so the operator can remove it manually if they choose. Never throws.
  function reportOrphanShell(why: string): void {
    if (dryRun || !newCourseId) return;
    result.orphanedCourseId = newCourseId;
    result.rolledBack = false;
    log(`Orphaned course ${newCourseId} left in place (no auto-delete — ${why}); delete manually if needed`);
  }

  // Upload one source asset (block OR lesson media) via the faithful chain:
  // dedup → size-guard → GET_YURL → S3 PUT → record source→new key in keyMap. A
  // reused key uploads once; an oversize asset (over the 64MB relay cap that the
  // planner couldn't predict, e.g. no manifest size) is flagged + blanked
  // (keyMap → '') so no dead source key survives.
  async function uploadOne(
    sourceKey: string,
    filename: string,
    stepKind: PlanStep['kind'],
  ): Promise<void> {
    if (keyMap.has(sourceKey)) {
      log(`${pfx()} reuse ${sourceKey} (already uploaded)`);
      return;
    }
    let bytes: AssetBytes | null = null;
    if (!dryRun) {
      bytes = await deps.readAsset(sourceKey);
      if (!bytes) throw new WriteError(`Missing archived bytes for ${sourceKey}`, stepKind);
      if (bytes.base64.length > MAX_UPLOAD_BASE64) {
        const mb = Math.round((bytes.base64.length * 0.75) / (1024 * 1024));
        log(`${pfx()} WARN ${sourceKey} too large to upload via the extension (~${mb}MB) — flagged, attach manually`);
        result.flags.push({
          kind: 'unsupported-media',
          sourceKey,
          detail: `Asset ~${mb}MB is too large to upload via the extension — upload it manually in Rise`,
        });
        keyMap.set(sourceKey, ''); // blank → no dead source key survives
        return;
      }
    }
    // Faithful upload (no CRUSH/transcode — the exported bytes are the source of
    // truth). Every distinct source key is its own upload, so the per-key map
    // covers them all and the patch/lesson remap swaps each.
    const yurl = payloadOf(await send(env.getYurl({ courseId: newCourseId, filename }), stepKind));
    const newKey = dryRun ? `rise/courses/${newCourseId}/${mint()}` : String(yurl.key ?? '');
    const url = String(yurl.url ?? '');
    const ctype = String(yurl.type ?? 'application/octet-stream');
    if (!dryRun && (!newKey || !url)) {
      throw new WriteError('GET_YURL returned no key/url', stepKind, JSON.stringify(yurl));
    }
    if (!dryRun && bytes) {
      const put = await deps.relay(env.s3Put({ url, base64Body: bytes.base64, contentType: ctype }));
      result.envelopes.push({ step: stepKind, label: 'S3 PUT (upload bytes)' });
      if (!put.ok) throw new WriteError(`S3 PUT failed (HTTP ${put.status})`, stepKind, put.text);
    } else {
      result.envelopes.push({ step: stepKind, label: 'S3 PUT (upload bytes)' });
    }
    keyMap.set(sourceKey, newKey);
  }

  try {
    let done = 0;
    for (const step of steps) {
      // Cooperative stop checkpoint: only BETWEEN steps (the previous write has
      // fully finished), so we never abandon a half-sent write. The partial
      // course is kept + resumable via the job log — no rollback.
      if (deps.shouldStop?.()) {
        result.stopped = true;
        result.idMap = ids.toJSON();
        log(`Stopped before step ${stepIdx + 1}/${total} — partial course kept (resumable on re-run)`);
        return result;
      }
      stepIdx++;
      switch (step.kind) {
        case 'create-bank': {
          const bank = deps.input.banksById.get(step.sourceBankId);
          const resp = await send(
            // Banks live in their OWN folder namespace — NOT the course-content
            // `all` sentinel (which 500s here). Until bank-folder mapping exists
            // (protocol §5), create at the bank root with folderId: null.
            env.postBank({ folderId: null, title: step.title }),
            step.kind,
          );
          const newBankId = dryRun ? ids.remap(step.sourceBankId) : String(resp.id ?? '');
          if (!newBankId) throw new WriteError('Bank create returned no id', step.kind, JSON.stringify(resp));
          ids.set(step.sourceBankId, newBankId);
          // Pre-remap the bank's questions so their new ids are known for binding.
          const remapped = remapIds(bank?.questions ?? [], ids) as Array<{ id?: string }>;
          bankQuestionIds.set(
            step.sourceBankId,
            remapped.map((q) => String(q.id ?? '')).filter(Boolean),
          );
          break;
        }
        case 'put-bank': {
          const bank = deps.input.banksById.get(step.sourceBankId) as SourceBank | undefined;
          const newBankId = ids.get(step.sourceBankId);
          if (!newBankId) throw new WriteError('put-bank before create-bank', step.kind);
          const questions = remapIds(bank?.questions ?? [], ids);
          let resp: Record<string, unknown>;
          try {
            resp = await send(
              env.putBank({
                bankId: newBankId,
                questions: questions as unknown[],
                session: mint(),
                lockData: authorProfile(author),
              }),
              step.kind,
            );
          } catch (e) {
            // The bank shell was created (create-bank) but the questions write
            // failed → an empty bank is left on the target. Record it (no delete)
            // so the report lists it for manual cleanup, then fail the course.
            result.flags.push({
              kind: 'orphan-bank',
              detail: `Empty question bank ${newBankId} left on target (question write failed) — delete manually if needed`,
            });
            throw e;
          }
          if (!dryRun && resp.version === undefined && resp.questions === undefined) {
            result.flags.push({
              kind: 'orphan-bank',
              detail: `Question bank ${newBankId} may be incomplete (PUT did not echo a saved bank) — verify/delete manually`,
            });
            throw new WriteError('Bank PUT did not echo a saved bank', step.kind, JSON.stringify(resp));
          }
          break;
        }
        case 'create-course': {
          const resp = await send(
            env.createCourseShell(deps.input.targetFolderId ?? 'all', step.courseType),
            step.kind,
          );
          newCourseId = dryRun ? ids.remap(step.sourceCourseId) : String(resp.id ?? '');
          if (!newCourseId) throw new WriteError('Course create returned no id', step.kind, JSON.stringify(resp));
          ids.set(step.sourceCourseId, newCourseId);
          result.newCourseId = newCourseId;
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
              const spec = env.getCourse(newCourseId);
              result.envelopes.push({ step: step.kind, label: spec.label });
              const r = await deps.relay(spec);
              const rb = r.ok ? payloadOf(parseJson(r.text)) : {};
              if (r.ok && rb.course && typeof rb.course === 'object') {
                log(`${pfx()} OK   GET_COURSE handshake — course ready (attempt ${attempt}/${tries})`);
                confirmed = true;
                materialized = true;
              } else {
                log(`${pfx()} …    GET_COURSE not ready yet (attempt ${attempt}/${tries}, HTTP ${r.status})`);
              }
            }
            if (!confirmed) {
              throw new WriteError(
                'Post-create GET_COURSE never confirmed the course materialized',
                step.kind,
              );
            }
          }
          break;
        }
        case 'set-theme': {
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
            const idMap = await resolveAndRecreateTypefaces(course, src ?? new Map());
            const applied = applyTypefaceIds(course, theme, idMap);
            await send(
              env.updateCourseThemeAndTypefaces({
                courseId: newCourseId,
                theme: applied.theme,
                headingTypefaceId: applied.headingTypefaceId,
                bodyTypefaceId: applied.bodyTypefaceId,
                uiTypefaceId: applied.uiTypefaceId,
              }),
              step.kind,
            );
          } else {
            await send(env.updateCourseTheme(newCourseId, theme), step.kind);
          }
          break;
        }
        case 'set-course-images': {
          const course = (deps.input.course.course ?? {}) as Record<string, unknown>;
          // Faithful round-trip of any course-level image object (coverImage/
          // cardImage `{media:{image}}`, the `media` logo `{image}`, or
          // lessonHeaderImage which may nest an uncropped `originalImage`). Upload
          // EVERY course/bank key found anywhere in the object — key, crushedKey,
          // originalImage.* — so none survives as a source key, then remap.
          const build = async (img: unknown): Promise<unknown | undefined> => {
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
            if (keys.size === 0) return undefined;
            const km = new Map<string, string>();
            for (const k of keys) {
              const nk = await uploadImageAsset(k);
              if (nk) {
                km.set(k, nk);
                keyMap.set(k, nk);
              }
            }
            if (km.size === 0) return undefined;
            return remapMediaKeys(img, km);
          };
          const coverImage = step.hasCover ? await build(course.coverImage) : undefined;
          const cardImage = step.hasCard ? await build(course.cardImage) : undefined;
          const media = step.hasMedia ? await build(course.media) : undefined;
          const lessonHeaderImage = step.hasLessonHeader ? await build(course.lessonHeaderImage) : undefined;
          if (
            coverImage !== undefined ||
            cardImage !== undefined ||
            media !== undefined ||
            lessonHeaderImage !== undefined
          ) {
            await send(
              env.setCourseImages({ courseId: newCourseId, coverImage, cardImage, media, lessonHeaderImage }),
              step.kind,
            );
          }
          break;
        }
        case 'set-title': {
          // Best-effort: never abort a whole course import over a cosmetic
          // title/description (confirmed envelope, but flag if it doesn't take).
          try {
            await send(env.updateCourseTitle(newCourseId, step.title), step.kind);
            const desc = deps.input.course.course?.description;
            if (typeof desc === 'string' && desc) {
              await send(
                env.updateCourseFieldThrottle(newCourseId, 'description', desc),
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
          break;
        }
        case 'create-lesson': {
          const resp = await send(
            env.createLesson({
              author,
              courseId: newCourseId,
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
          break;
        }
        case 'update-lesson': {
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
            new Set(newCourseId ? [newCourseId] : []),
          ) as Record<string, unknown>;
          await send(
            env.updateLesson({
              id: newLessonId,
              courseId: newCourseId,
              type: step.lessonType,
              icon: step.icon,
              extra: safeExtra,
            }),
            step.kind,
          );
          break;
        }
        case 'lock-lesson': {
          // Best-effort: never abort the import on a lock failure.
          try {
            await send(env.putLock(ids.get(step.sourceLessonId)!, newCourseId), step.kind);
          } catch (e) {
            log(`WARN lock failed (continuing): ${(e as Error).message}`);
          }
          break;
        }
        case 'unlock-lesson': {
          try {
            await send(env.delLock(ids.get(step.sourceLessonId)!, newCourseId), step.kind);
          } catch (e) {
            log(`WARN unlock failed (ignored): ${(e as Error).message}`);
          }
          break;
        }
        case 'create-blocks': {
          const newLessonId = ids.get(step.sourceLessonId)!;
          // Build ALL of the lesson's blocks in source order, copy-faithful:
          // regenerate ids + strip server fields, then blank uploaded media keys
          // (filled by the patch step after re-upload). One ordered insert keeps
          // block order deterministic.
          const newIdToSource = new Map<string, string>();
          const built: Record<string, unknown>[] = [];
          for (const ref of step.blocks) {
            const entry = srcBlocks.get(ref.sourceBlockId);
            if (!entry) throw new WriteError(`Source block ${ref.sourceBlockId} not found`, step.kind);
            const remapped = blankUploadedMediaKeys(remapIds(entry.block, ids)) as Record<string, unknown>;
            const newBlockId = String(remapped.id ?? '');
            newIdToSource.set(newBlockId, ref.sourceBlockId);
            built.push(remapped);
            // Provisional mapping (confirmed below in a live run).
            blockMeta.set(ref.sourceBlockId, { newId: newBlockId });
          }
          const resp = await send(
            env.createBlocks({
              courseId: newCourseId,
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
              blockMeta.set(src, {
                newId: newBlockId,
                globalBlockId:
                  typeof meta.globalBlockId === 'string' ? meta.globalBlockId : undefined,
              });
            }
          }
          break;
        }
        case 'bind-draw-from-bank': {
          if (!step.sourceBankId) {
            result.flags.push({
              kind: 'missing-bank-ref',
              sourceBlockId: step.sourceBlockId,
              detail: 'draw-from-bank block has no resolvable source bank id',
            });
            throw new WriteError('draw-from-bank block missing a bank reference', step.kind);
          }
          // Bank may have been imported in step B (boundBanks) or created in this
          // same run (ids/bankQuestionIds). Prefer the pre-imported one.
          const bound = deps.input.boundBanks?.get(step.sourceBankId);
          const newBankId = bound?.newBankId ?? ids.get(step.sourceBankId);
          if (!newBankId) throw new WriteError('bind before bank create', step.kind);
          const meta = blockMeta.get(step.sourceBlockId);
          const newLessonId = ids.get(step.sourceLessonId)!;
          const pendingItemId = mint();
          const questionList = bound?.questionIds ?? bankQuestionIds.get(step.sourceBankId) ?? [];
          await send(
            env.insertQuestionBankQuestions({
              lesson: { id: newLessonId, courseId: newCourseId },
              blockOrItemId: meta?.newId ?? '',
              pendingItemId,
              mode: 'knowledgeCheck',
              drawCount: step.drawCount,
              questionDrawType: step.questionDrawType,
              questionBankId: newBankId,
              questionList,
              courseId: newCourseId,
            }),
            step.kind,
          );
          break;
        }
        case 'upload-asset': {
          // Dedup + size-guard + faithful upload (shared with lesson media). The
          // plan emits an upload step per (block, key), so the SAME source key can
          // recur — uploadOne reuses an already-uploaded key (upload once).
          await uploadOne(step.sourceKey, step.filename, step.kind);
          break;
        }
        case 'upload-lesson-media': {
          // Lesson header / media — uploaded BEFORE this lesson's UPDATE_LESSON so
          // the lesson payload (built in update-lesson) carries the remapped key.
          await uploadOne(step.sourceKey, step.filename, step.kind);
          break;
        }
        case 'patch-block-media': {
          const entry = srcBlocks.get(step.sourceBlockId);
          const meta = blockMeta.get(step.sourceBlockId);
          if (!entry || !meta) throw new WriteError('patch before block create', step.kind);
          const newLessonId = ids.get(step.sourceLessonId)!;
          // Build the patched block: remap ids, then swap source keys → new keys.
          const patched = remapMediaKeys(remapIds(entry.block, ids), keyMap);
          await send(
            env.updateBlockDebounce({
              id: meta.newId,
              courseId: newCourseId,
              lessonId: newLessonId,
              item: patched,
            }),
            step.kind,
          );
          break;
        }
        case 'attach-storyline': {
          // Mirror the editor's "add from Review 360": copy the uploaded review
          // item's bundle into the course, then patch the (empty) block's
          // media.storyline to point at the copied bundle. The copy preserves the
          // review item's leaf, so contentPrefix = rise/courses/{courseId}/{leaf}.
          const entry = srcBlocks.get(step.sourceBlockId);
          const meta = blockMeta.get(step.sourceBlockId);
          if (!entry || !meta) throw new WriteError('attach before block create', step.kind);
          const newLessonId = ids.get(step.sourceLessonId)!;
          const leaf = step.reviewPrefix.split('/').filter(Boolean).pop() ?? '';

          await send(
            env.copyReviewItem({
              courseId: newCourseId,
              reviewPrefix: step.reviewPrefix,
              blockId: meta.newId,
            }),
            step.kind,
          );

          const contentPrefix = `rise/courses/${newCourseId}/${leaf}`;
          const item = remapIds(entry.block, ids) as Record<string, unknown>;
          const items = Array.isArray(item.items) ? item.items : [];
          const first = items[0];
          if (first && typeof first === 'object') {
            (first as Record<string, unknown>).media = env.buildStorylineMedia({
              contentPrefix,
              meta: step.meta,
              title: step.title,
            });
          }
          await send(
            env.updateBlockDebounce({
              id: meta.newId,
              courseId: newCourseId,
              lessonId: newLessonId,
              item,
            }),
            step.kind,
          );
          result.storylineAttached = (result.storylineAttached ?? 0) + 1;
          log(`${pfx()} ✓ attached storyline → ${contentPrefix}`);
          break;
        }
        case 'flag-storyline': {
          result.flags.push({
            kind: 'storyline',
            sourceBlockId: step.sourceBlockId,
            detail: 'Storyline/Mighty block — attach manually via a reachable Review 360 item',
          });
          log(`${pfx()} ⚠ FLAG storyline — block ${step.sourceBlockId} needs manual Review 360 attach`);
          break;
        }
        case 'flag-draw-from-bank': {
          result.flags.push({
            kind: 'draw-from-bank',
            sourceBlockId: step.sourceBlockId,
            detail:
              'Draw-from-bank block created as an unbound placeholder — attach a question bank manually (bank recreation is off)',
          });
          log(`${pfx()} ⚠ FLAG draw-from-bank — block ${step.sourceBlockId} (attach a bank manually)`);
          break;
        }
        case 'flag-orphan-media': {
          result.flags.push({
            kind: 'orphan-media',
            sourceBlockId: step.sourceBlockId,
            sourceKey: step.sourceKey,
            detail: 'Media is 403/deleted at source — block shipped without it',
          });
          log(`${pfx()} ⚠ FLAG orphan-media — ${step.sourceKey} (deleted at source)`);
          break;
        }
        case 'flag-unsupported-media': {
          result.flags.push({
            kind: 'unsupported-media',
            sourceKey: step.sourceKey,
            detail: `Media at ${step.location} has no captured write path — attach manually (not written as a source key)`,
          });
          // Blank the key so any later remap (block patch / lesson payload / final
          // rebuild) writes empty media, never a dead source key.
          keyMap.set(step.sourceKey, '');
          log(`${pfx()} ⚠ FLAG unsupported-media — ${step.sourceKey} (${step.location})`);
          break;
        }
      }
      result.idMap = ids.toJSON();
      deps.onProgress?.(++done, steps.length);
    }

    // Materialization guard (belt-and-suspenders): the create-course handshake
    // already confirmed the shell with a 200 GET_COURSE, so this normally never
    // fires. If somehow a course id exists without that confirmation, treat the
    // shell as suspect and roll it back rather than report a hollow success.
    if (!dryRun && newCourseId && !materialized) {
      reportOrphanShell('course never confirmed by the GET_COURSE handshake');
      result.ok = false;
      result.error =
        'Course shell was not confirmed by the post-create GET_COURSE handshake — left in place (delete manually if needed)';
      result.idMap = ids.toJSON();
      return result;
    }

    // Final invariant (protocol §8/§12): every uploaded media key in the rebuilt
    // course must belong to a TARGET owner (new course id / new bank ids) — any
    // other is a source/foreign key that wasn't remapped. Flagged keys (orphan /
    // unsupported-location) are intentionally shipped without media, so excluded.
    const targetOwners = new Set<string>();
    if (newCourseId) targetOwners.add(newCourseId);
    for (const bankId of deps.input.banksById.keys()) {
      const nb = ids.get(bankId);
      if (nb) targetOwners.add(nb);
    }
    const rebuilt = remapMediaKeys(deps.input.course, keyMap);
    const flagged = new Set(
      result.flags.map((f) => f.sourceKey).filter((k): k is string => !!k),
    );
    result.survivingKeys = findForeignMediaKeys(rebuilt, targetOwners).filter(
      (k) => !flagged.has(k),
    );

    result.ok = dryRun || result.survivingKeys.length === 0;
    if (!result.ok) {
      result.error = `Source media keys survived: ${result.survivingKeys.slice(0, 5).join(', ')}`;
    }
    result.idMap = ids.toJSON();
    return result;
  } catch (e) {
    result.ok = false;
    result.idMap = ids.toJSON();
    // Report (do NOT delete) ONLY a shell the GET_COURSE handshake never
    // confirmed. Once confirmed, the course is real, queryable and resumable (a
    // bare titleless/lessonless shell is a VALID Rise course — capture-confirmed),
    // so a later failure leaves a real, resumable course we keep. An unconfirmed
    // shell is the suspect state → report it (left in place; no auto-delete).
    if (!materialized) reportOrphanShell('import failed before the course was confirmed');
    if (e instanceof WriteError) {
      // Surface a snippet of the server's response body — a 4xx/5xx body usually
      // says exactly what it rejected (the live diagnostic).
      const body = e.raw ? ` — body: ${e.raw.slice(0, 300)}` : '';
      result.error = `[${e.step}] ${e.message}${body}`;
    } else {
      result.error = String(e);
    }
    return result;
  }

  // Match the course's typefaces to the TARGET account by name (FETCH_TYPEFACES)
  // and recreate any custom font it lacks (upload .woff files → CREATE_TYPEFACE).
  // Returns source typeface id → target typeface id.
  async function resolveAndRecreateTypefaces(
    course: Record<string, unknown>,
    source: Map<string, Typeface>,
  ): Promise<Map<string, string>> {
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
          await send(env.getYurl({ courseId: newCourseId, filename, assetPath: 'fonts/' }), 'set-theme'),
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

  // Faithful upload of a single cover/card key (GET_YURL → S3 PUT of the exact
  // exported bytes). No CRUSH — the source already carries both `key` and
  // `crushedKey`, and each is uploaded + remapped on its own, verbatim.
  async function uploadImageAsset(sourceKey: string): Promise<string | null> {
    const filename = sourceKey.split('/').pop() ?? 'image.jpg';
    const yurl = payloadOf(await send(env.getYurl({ courseId: newCourseId, filename }), 'set-course-images'));
    const newKey = dryRun ? `rise/courses/${newCourseId}/${mint()}.jpg` : String(yurl.key ?? '');
    const url = String(yurl.url ?? '');
    const ctype = String(yurl.type ?? 'image/jpeg');
    if (!dryRun) {
      if (!newKey || !url) throw new WriteError('GET_YURL returned no key/url (cover)', 'set-course-images', JSON.stringify(yurl));
      const bytes = await deps.readAsset(sourceKey);
      if (!bytes) {
        log(`WARN missing archived bytes for cover/card ${sourceKey} (skipping)`);
        return null;
      }
      const put = await deps.relay(env.s3Put({ url, base64Body: bytes.base64, contentType: ctype }));
      result.envelopes.push({ step: 'set-course-images', label: 'S3 PUT (cover)' });
      if (!put.ok) throw new WriteError(`Cover S3 PUT failed (HTTP ${put.status})`, 'set-course-images', put.text);
    } else {
      result.envelopes.push({ step: 'set-course-images', label: 'S3 PUT (cover)' });
    }
    return newKey;
  }
}
