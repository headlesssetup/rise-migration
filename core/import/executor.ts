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
  courseRefMap,
  defaultLocaleOf,
  inlineTranslationChanges,
  isL10nRef,
  isLocalizedStack,
  junkCellIds,
  lessonIdByRef,
  materializeLocale,
  valueTypeOf,
  writableLocaleCodes,
  type L10nChange,
} from '@/core/l10n';
import {
  freshClientIds,
  remapIds,
  blankUploadedMediaKeys,
  blankForeignMediaKeys,
  remapMediaKeys,
  findForeignMediaKeys,
} from './remap';
import { collectBuiltinRefs, hasBuiltinRef, probeBuiltinRefs } from './builtin-assets';
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
  blockKey,
  authorProfile,
} from './executor-types';
import type { ExecutorDeps, ExecResult, AssetBytes } from './executor-types';
import type { GetCourseDocument } from '@/shared/types/rise';

// Re-export the executor contracts/types so `@/core/import` keeps the same
// surface after they moved to ./executor-types (see that file's header).
export {
  blockKey,
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

  // --- Multi-language stack state (docs/rise-multilang.md) ---
  const stack = isLocalizedStack(deps.input.course);
  const srcTables = deps.input.course.l10n?.translations ?? {};
  const srcDefaultLocale = defaultLocaleOf(deps.input.course) ?? 'en-us';
  // Source course-level l10nId → the TARGET's own ref id (title/description/
  // cover… — created by the conversion; learned at await-stack from GET_COURSE).
  const stackRefMap = new Map<string, string>();
  // Target GET_COURSE snapshot taken at await-stack (pre-content) — the baseline
  // for junk-cell cleanup (only placeholder-era cells can be in it).
  let targetStackDoc: GetCourseDocument | null = null;
  // Source lesson-scoped l10nId → source lesson id (adds carry the TARGET
  // lesson id, mapped through `ids` at write time).
  const srcLessonByRef = stack ? lessonIdByRef(deps.input.course) : new Map<string, string>();
  // Materialized default locale (display strings + plain course-image objects
  // for the pre-conversion writes).
  const matDoc = stack ? materializeLocale(deps.input.course).doc : deps.input.course;

  /** Remap media keys inside a cell value + map ids/lessons for one batch add. */
  const buildCellChange = (l10nId: string, locale: string): L10nChange | null => {
    const value = srcTables[locale]?.[l10nId];
    if (value === undefined) return null;
    const srcLesson = srcLessonByRef.get(l10nId);
    const targetLesson = srcLesson ? ids.get(srcLesson) : undefined;
    return {
      action: 'add',
      l10nId: stackRefMap.get(l10nId) ?? l10nId,
      ...(targetLesson ? { lessonId: targetLesson } : {}),
      locale,
      value: remapMediaKeys(value as never, keyMap) as typeof value,
      valueType: valueTypeOf(value),
    };
  };

  /**
   * A built-in (library/CDN) reference is copied verbatim — but whether the
   * TARGET plane actually serves it is unverified (the libraries of the two
   * planes are not known to be identical; a region may lack an asset for
   * licensing reasons). Probe the target plane once per distinct value and flag
   * anything not confirmed, so a silently-broken image is impossible. With no
   * prober wired (tests, dry-run) the references are flagged as unverified.
   */
  const noteBuiltins = async (img: unknown, where: string): Promise<void> => {
    const refs = collectBuiltinRefs(img);
    if (refs.length === 0) return;
    const probe = deps.probeBuiltinAsset;
    const plane = deps.targetPlane;
    if (!probe || !plane) {
      for (const r of refs) {
        result.flags.push({
          kind: 'builtin-asset',
          detail: `${where}: built-in asset "${r.value}" copied as-is, availability on the target plane NOT checked`,
        });
      }
      return;
    }
    const probed = await probeBuiltinRefs(
      refs.map((r) => r.value),
      plane,
      probe,
      deps.builtinProbeCache,
    );
    for (const p of probed) {
      if (p.available === true) continue;
      const why =
        p.available === false
          ? `is NOT served by the ${plane.toUpperCase()} plane (HTTP ${p.status})`
          : 'could not be verified on the target plane';
      result.flags.push({
        kind: 'builtin-asset',
        detail:
          `${where}: built-in asset "${p.value}" ${why} — copied as-is, so it may not render. ` +
          'Replace it in the target course, or re-upload the file as course media.',
      });
      log(`${pfx()} ⚠ FLAG built-in asset ${why}: ${p.value}`);
    }
  };

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
        // Mark the partial course so it's identifiable in the dashboard (an
        // unfinished import otherwise leaves a hard-to-spot course). Best-effort,
        // and only once the course exists. A re-run's FINAL set-title restores the
        // clean title when the import resumes + completes.
        if (!dryRun && newCourseId) {
          const srcTitleRaw = deps.input.course.course?.title;
          const srcTitle =
            typeof srcTitleRaw === 'string'
              ? srcTitleRaw
              : typeof matDoc.course?.title === 'string'
                ? matDoc.course.title
                : '';
          try {
            await pace(); // an authoring write like any other — keep it human-paced
            const titleRefTarget = isL10nRef(srcTitleRaw)
              ? stackRefMap.get(srcTitleRaw.l10nId)
              : undefined;
            if (titleRefTarget) {
              // Post-conversion stack: the course title is a ref — writing a
              // plain string would clobber it. Rename via the title CELL
              // (default locale) instead.
              await deps.relay(
                env.updateL10nBatch(newCourseId, [
                  {
                    action: 'update',
                    l10nId: titleRefTarget,
                    locale: srcDefaultLocale,
                    value: `!unfinished: ${srcTitle}`,
                  },
                ]),
              );
            } else {
              await deps.relay(env.updateCourseTitle(newCourseId, `!unfinished: ${srcTitle}`));
            }
            log(`Marked partial course title "!unfinished: ${srcTitle}"`);
          } catch {
            /* best-effort — the stop still succeeds */
          }
        }
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
              km.set(k, (await uploadImageAsset(k)) ?? '');
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
            // The description rides only with the FINAL title write (the early
            // write is the provisional `!importing:` marker — see plan.ts).
            const desc = deps.input.course.course?.description;
            if (step.final && typeof desc === 'string' && desc) {
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
          // Stack content lesson: create with the SOURCE title ref + an inline
          // default-locale title cell (capture-proven translationChanges add).
          // Plain-string title otherwise (monolingual, or the pre-conversion
          // placeholder — whose title the conversion extracts into a cell).
          let title: string | { l10nId: string } = step.title;
          let translationChanges: L10nChange[] | undefined;
          if (step.l10nTitleRef) {
            title = { l10nId: step.l10nTitleRef };
            const v = srcTables[srcDefaultLocale]?.[step.l10nTitleRef];
            if (v !== undefined) {
              translationChanges = [
                {
                  action: 'add',
                  l10nId: step.l10nTitleRef,
                  locale: srcDefaultLocale,
                  value: remapMediaKeys(v as never, keyMap) as typeof v,
                  valueType: valueTypeOf(v),
                },
              ];
            }
          }
          const resp = await send(
            env.createLesson({
              author,
              courseId: newCourseId,
              position: step.position,
              title,
              type: step.lessonType,
              translationChanges,
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
            const entry = srcBlocks.get(blockKey(step.sourceLessonId, ref.sourceBlockId));
            if (!entry) throw new WriteError(`Source block ${ref.sourceBlockId} not found`, step.kind);
            // freshClientIds FIRST: block/item ids that are not cuid-shaped (Rise's
            // sample courses number them "1","2","3"… in EVERY lesson) get a fresh
            // per-block id, so two lessons never claim the same block id. Then the
            // usual IdMap pass handles cuid-shaped ids + refs globally.
            const normalized = freshClientIds(entry.block, mint);
            const remapped = blankUploadedMediaKeys(remapIds(normalized, ids)) as Record<string, unknown>;
            const newBlockId = String(remapped.id ?? '');
            newIdToSource.set(newBlockId, ref.sourceBlockId);
            built.push(remapped);
            // Provisional mapping (confirmed below in a live run).
            blockMeta.set(blockKey(step.sourceLessonId, ref.sourceBlockId), { newId: newBlockId });
          }
          // Stack: inline the default-locale cells for every {l10nId} ref in
          // these blocks (action:'add' + the TARGET lesson id — capture-proven).
          // Values are media-remapped: table media was uploaded pre-content.
          let translationChanges: L10nChange[] | undefined;
          if (stack) {
            const srcSubtrees = step.blocks.map(
              (r) => srcBlocks.get(blockKey(step.sourceLessonId, r.sourceBlockId))?.block,
            );
            translationChanges = inlineTranslationChanges(
              srcSubtrees,
              deps.input.course,
              newLessonId,
            ).map((ch) => ({
              ...ch,
              value: remapMediaKeys(ch.value as never, keyMap) as typeof ch.value,
            }));
          }
          const resp = await send(
            env.createBlocks({
              courseId: newCourseId,
              lessonId: newLessonId,
              previousBlockId: null,
              blocks: built,
              translationChanges,
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
          const meta = blockMeta.get(blockKey(step.sourceLessonId, step.sourceBlockId));
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
          const entry = srcBlocks.get(blockKey(step.sourceLessonId, step.sourceBlockId));
          const meta = blockMeta.get(blockKey(step.sourceLessonId, step.sourceBlockId));
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
          const entry = srcBlocks.get(blockKey(step.sourceLessonId, step.sourceBlockId));
          const meta = blockMeta.get(blockKey(step.sourceLessonId, step.sourceBlockId));
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
          (result.storylinePrefixes ??= []).push(contentPrefix);
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
            detail: 'Media is 403/deleted at source — imported with the media slot blanked',
          });
          // Blank the key so every later payload built via remapMediaKeys (block
          // patch / lesson update / course images / the final rebuild assertion)
          // strips the dead source key instead of shipping it verbatim.
          keyMap.set(step.sourceKey, '');
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

        // ---- Multi-language stacks (docs/rise-multilang.md) ----
        case 'set-course-description': {
          // Best-effort like set-title — a missing description ref surfaces in
          // the read-back, not as a course failure.
          try {
            await send(
              env.updateCourseFieldThrottle(newCourseId, 'description', step.value),
              step.kind,
            );
          } catch (e) {
            log(`WARN placeholder description not set (continuing): ${(e as Error).message}`);
          }
          break;
        }
        case 'convert-stack': {
          await send(
            env.createTranslations(newCourseId, {
              sourceLanguage: step.sourceLanguage,
              targetLanguages: step.targetLanguages,
              formality: step.formality,
            }),
            step.kind,
          );
          break;
        }
        case 'await-stack': {
          if (!dryRun) {
            // Poll the stack state until every expected language is `complete`.
            // Paced like every authoring read; one recorded envelope, per-poll
            // progress in the log ([i/N] stays visibly alive during the wait).
            const spec = env.getTranslations(newCourseId);
            result.envelopes.push({ step: step.kind, label: spec.label });
            const tries = Math.max(1, deps.stackAwaitTries ?? 240);
            const expected = new Set(step.expectedLocales);
            let ready = false;
            for (let attempt = 1; attempt <= tries && !ready; attempt++) {
              await pace();
              const r = await deps.relay(spec);
              if (!r.ok) {
                throw new WriteError(
                  `GET translations failed while waiting for the stack (HTTP ${r.status})`,
                  step.kind,
                  r.text,
                );
              }
              const body = parseJson(r.text);
              const items = Array.isArray(body.stackItems)
                ? (body.stackItems as Record<string, unknown>[])
                : [];
              const live = items.filter((it) => !it.deletedAt);
              const completed = new Set(
                live
                  .filter((it) => it.status === 'complete')
                  .map((it) => String(it.locale ?? '')),
              );
              ready = [...expected].every((code) => completed.has(code));
              if (!ready && attempt % 5 === 0) {
                const pending = [...expected].filter((c) => !completed.has(c));
                log(
                  `${pfx()} …    stack conversion in progress — waiting on ${pending.join(', ')} (poll ${attempt}/${tries})`,
                );
              }
            }
            if (!ready) {
              throw new WriteError(
                `Stack conversion did not complete within ${tries} polls (languages: ${step.expectedLocales.join(', ')})`,
                step.kind,
              );
            }
            log(`${pfx()} OK   stack shape ready (${step.expectedLocales.join(', ')})`);

            // Learn the target's own course-level refs (title/description/
            // cover…) for the cell writes, and snapshot the pre-content doc as
            // the junk-cleanup baseline.
            const rb = await send(env.getCourse(newCourseId), step.kind);
            const targetDoc = payloadOf(rb) as GetCourseDocument;
            if (!isLocalizedStack(targetDoc)) {
              throw new WriteError(
                'Target course is not l10n-ified after the conversion completed',
                step.kind,
                JSON.stringify(targetDoc.course ?? {}).slice(0, 300),
              );
            }
            targetStackDoc = targetDoc;
            const { map, unmatched } = courseRefMap(deps.input.course, targetDoc);
            for (const [s, t] of map) stackRefMap.set(s, t);
            // The placeholder IS lesson 1: map its title ref (source lesson-1
            // title → the target placeholder's title cell).
            const srcFirst = deps.input.course.lessons?.[0];
            const tgtFirst = targetDoc.lessons?.[0];
            if (srcFirst && tgtFirst && isL10nRef(srcFirst.title) && isL10nRef(tgtFirst.title)) {
              stackRefMap.set(srcFirst.title.l10nId, tgtFirst.title.l10nId);
            }
            for (const u of unmatched) {
              result.flags.push({
                kind: 'l10n-ref',
                detail: `Course-level localized value at ${u.path} has no counterpart on the target — set it manually per language`,
              });
              log(`${pfx()} ⚠ FLAG l10n-ref — ${u.path} unmatched on target`);
            }
          } else {
            result.envelopes.push({
              step: step.kind,
              label: `poll ${env.getTranslations('(new course)').label} until complete`,
            });
            log(`${pfx()} DRY  await stack conversion (${step.expectedLocales.join(', ')})`);
          }
          break;
        }
        case 'upload-l10n-asset': {
          await uploadOne(step.sourceKey, step.filename, step.kind);
          break;
        }
        case 'write-l10n': {
          const changes = step.l10nIds
            .map((id) => buildCellChange(id, step.locale))
            .filter((c): c is L10nChange => c !== null);
          if (changes.length === 0) {
            log(`${pfx()} skip write-l10n [${step.locale}] — no cells resolved`);
            break;
          }
          await send(env.updateL10nBatch(newCourseId, changes), step.kind);
          log(
            `${pfx()} [${step.batchIndex}/${step.batchTotal} l10n batches] OK ${changes.length} cell(s) [${step.locale}]`,
          );
          break;
        }
        case 'set-locale-labelset': {
          // Account-scoped: reuse a set another course of this run already
          // recreated (deps.labelSetCache, keyed by SOURCE label-set id).
          const cache = deps.labelSetCache;
          let targetSetId = cache?.get(step.sourceLabelSetId);
          if (!targetSetId) {
            const created = payloadOf(
              await send(
                env.createLabelSet({ iso639Code: step.iso639Code, name: step.name }),
                step.kind,
              ),
            );
            targetSetId = dryRun ? mint() : String(created.id ?? '');
            if (!targetSetId) {
              throw new WriteError('CREATE_LABEL_SET returned no id', step.kind, JSON.stringify(created));
            }
            if (Object.keys(step.labels).length > 0) {
              await send(
                env.updateLabels({ id: targetSetId, labels: step.labels }),
                step.kind,
              );
            }
            cache?.set(step.sourceLabelSetId, targetSetId);
          } else {
            log(`${pfx()} reuse label set "${step.name}" (already recreated this run)`);
          }
          await send(
            env.updateLocale({
              courseId: newCourseId,
              locale: step.locale,
              labelSetId: targetSetId,
            }),
            step.kind,
          );
          break;
        }
        case 'cleanup-l10n': {
          if (dryRun || !targetStackDoc) {
            log(`${pfx()} ${dryRun ? 'DRY ' : 'skip'} cleanup-l10n (runtime-computed)`);
            break;
          }
          const junk = junkCellIds(deps.input.course, targetStackDoc, stackRefMap.values());
          if (junk.length === 0) {
            log(`${pfx()} OK   cleanup-l10n — no placeholder-era cells to delete`);
            break;
          }
          for (let i = 0; i < junk.length; i += 20) {
            const slice = junk.slice(i, i + 20);
            await send(
              env.updateL10nBatch(
                newCourseId,
                slice.map((l10nId) => ({ action: 'delete', l10nId })),
              ),
              step.kind,
            );
          }
          log(`${pfx()} OK   cleanup-l10n — deleted ${junk.length} placeholder cell(s)`);
          break;
        }
        case 'set-stack-titles': {
          // The FINAL step: clean title + description cells for EVERY locale
          // (default first — write-order invariant) onto the target's own refs.
          const course = deps.input.course.course ?? {};
          const refs = [course.title, course.description].filter(isL10nRef);
          // Writable locales only: an archived/row-less locale's table was
          // skipped everywhere else (flag-l10n-locale) — writing its title
          // cell here would hit a locale the target course doesn't have.
          const writable = writableLocaleCodes(deps.input.course);
          const locales = [
            srcDefaultLocale,
            ...Object.keys(srcTables).filter(
              (c) => c !== srcDefaultLocale && writable.has(c),
            ),
          ];
          for (const locale of locales) {
            const changes: L10nChange[] = [];
            for (const ref of refs) {
              const value = srcTables[locale]?.[ref.l10nId];
              const target = stackRefMap.get(ref.l10nId);
              if (value === undefined || (!dryRun && !target)) continue;
              changes.push({
                action: 'update',
                l10nId: target ?? ref.l10nId,
                locale,
                value: remapMediaKeys(value as never, keyMap) as typeof value,
              });
            }
            if (changes.length > 0) {
              await send(env.updateL10nBatch(newCourseId, changes), step.kind);
            }
          }
          break;
        }
        case 'attach-storyline-l10n': {
          // STACK per-language attach (docs/rise-multilang.md §4.3b): copy THIS
          // language's uploaded package into the course, then write the storyline
          // CELL for that locale. The block already carries the {l10nId} ref
          // (copy-faithful) — patching its media would clobber every language.
          const meta = blockMeta.get(blockKey(step.sourceLessonId, step.sourceBlockId));
          if (!meta) throw new WriteError('attach before block create', step.kind);
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
          const targetLesson = ids.get(step.sourceLessonId);
          await send(
            env.updateL10nBatch(newCourseId, [
              {
                action: 'add',
                l10nId: stackRefMap.get(step.l10nId) ?? step.l10nId,
                ...(targetLesson ? { lessonId: targetLesson } : {}),
                locale: step.locale,
                value: env.buildStorylineMedia({
                  contentPrefix,
                  meta: step.meta,
                  title: step.title,
                }),
                valueType: 'storyline',
              },
            ]),
            step.kind,
          );
          result.storylineAttached = (result.storylineAttached ?? 0) + 1;
          (result.storylinePrefixes ??= []).push(contentPrefix);
          log(`${pfx()} ✓ attached storyline [${step.locale}] → ${contentPrefix}`);
          break;
        }
        case 'flag-l10n-storyline': {
          // The source cell's storyline contentPrefix belongs to the SOURCE
          // course and storyline keys bypass the foreign-key invariant, so the
          // cell is deliberately NOT written (docs/rise-multilang.md §4.3b).
          result.flags.push({
            kind: 'l10n-storyline',
            detail: `${step.title ? `"${step.title}" — ` : ''}attach the Storyline package manually for: ${step.locales.join(', ')}`,
          });
          log(
            `${pfx()} ⚠ FLAG storyline in stack — cell ${step.l10nId} not copied; attach per language (${step.locales.join(', ')})`,
          );
          break;
        }
        case 'flag-l10n-locale': {
          // Skipped table for an archived/row-less locale (see plan): the data
          // stays in the archive; the operator restores the language at the
          // source and re-exports if they want it migrated.
          result.flags.push({
            kind: 'l10n-locale',
            detail: `${step.cells} cell(s) for locale "${step.locale}" not migrated (${step.reason})`,
          });
          log(
            `${pfx()} ⚠ FLAG locale "${step.locale}" (${step.reason}) — ${step.cells} cell(s) stay in the archive`,
          );
          break;
        }
        case 'flag-locale-selector': {
          result.flags.push({
            kind: 'locale-selector',
            detail:
              'The source stack shows the learner language selector — enable it manually on the target (the toggle envelope is not capture-proven yet)',
          });
          log(`${pfx()} ⚠ FLAG locale-selector — enable the language selector manually`);
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
    // other is a source/foreign key that wasn't remapped. Runs UNFILTERED: every
    // flagged key (orphan / oversize / unsupported-location) was BLANKED via the
    // keyMap, so a hit here is a real failure — including in a dry run, whose
    // prediction must not be silently discarded.
    const targetOwners = new Set<string>();
    if (newCourseId) targetOwners.add(newCourseId);
    for (const bankId of deps.input.banksById.keys()) {
      const nb = ids.get(bankId);
      if (nb) targetOwners.add(nb);
    }
    const rebuilt = remapMediaKeys(deps.input.course, keyMap);
    result.survivingKeys = findForeignMediaKeys(rebuilt, targetOwners);

    result.ok = result.survivingKeys.length === 0;
    if (!result.ok) {
      result.error = `Source media keys ${dryRun ? 'would survive (dry-run prediction)' : 'survived'}: ${result.survivingKeys.slice(0, 5).join(', ')}`;
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

  // Faithful upload of a single course-image key — cover/card/logo/lesson-header
  // (GET_YURL → S3 PUT of the exact exported bytes). No CRUSH — the source
  // already carries both `key` and `crushedKey`, and each is uploaded + remapped
  // on its own, verbatim. Dedups through the global keyMap (a key shared by
  // coverImage and cardImage uploads once). Missing archived bytes are handled
  // like block media: flag + blank (keyMap → ''), so UPDATE_COURSE ships without
  // the image and the course succeeds with a flag instead of hard-failing the
  // final assertion after all writes.
  async function uploadImageAsset(sourceKey: string): Promise<string | null> {
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
    const yurl = payloadOf(await send(env.getYurl({ courseId: newCourseId, filename }), 'set-course-images'));
    const newKey = dryRun ? `rise/courses/${newCourseId}/${mint()}.jpg` : String(yurl.key ?? '');
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
}
