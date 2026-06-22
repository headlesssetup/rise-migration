// Phase 3 — the import EXECUTOR. Walks the plan (core/import/plan.ts) and, for
// each step, builds the write envelope(s) (core/import/envelopes.ts), relays them
// through an injected Relay (the background runs them in the live Rise tab),
// asserts the response shape (loud-fail, protocol §12), and records server-
// assigned ids into the IdMap (resumable job log, §6). Strictly sequential +
// human-paced; DRY-RUN collects the envelopes without sending.
//
// All I/O is injected so the whole executor is unit-testable without a browser
// or a live Rise account.

import type { GetCourseDocument, Lesson, Block } from '@/shared/types/rise';
import { IdMap, newId } from './ids';
import { remapIds, blankUploadedMediaKeys, remapMediaKeys, findForeignMediaKeys } from './remap';
import * as env from './envelopes';
import type { WriteSpec } from './envelopes';
import { findBankRef, type PlanStep, type PlanInput, type SourceBank } from './plan';
import {
  targetByName,
  usedTypefaceIds,
  resolveTypefaces,
  buildCreateTypefaceFonts,
  applyTypefaceIds,
  type Typeface,
} from './typefaces';

export interface RelayResponse {
  ok: boolean;
  status: number;
  text: string;
  error?: string;
}

export type Relay = (spec: WriteSpec) => Promise<RelayResponse>;

export interface AssetBytes {
  base64: string;
  contentType: string;
}

export interface ExecutorDeps {
  input: PlanInput;
  relay: Relay;
  /** Resolve a source media key to its archived bytes (base64) + content-type. */
  readAsset: (sourceKey: string) => Promise<AssetBytes | null>;
  /** Source account typefaces (parsed from account/typefaces.json), keyed by id.
   *  When provided, the import migrates fonts (match-by-name + recreate custom);
   *  otherwise it falls back to a plain theme round-trip. */
  sourceTypefaces?: Map<string, Typeface>;
  /** TARGET account typefaces (FETCH_TYPEFACES on a *live existing* course),
   *  fetched once by the orchestrator. Used to match by name + dedup recreation.
   *  We can't FETCH_TYPEFACES on the brand-new course (404 until it settles),
   *  so this must be pre-fetched against an existing target course. */
  targetTypefaces?: Map<string, Typeface>;
  /** Read a custom font's archived `.woff` bytes by its source key. */
  readFontBytes?: (fontKey: string) => Promise<AssetBytes | null>;
  ids?: IdMap;
  /** Human-paced gap between writes (no-op in tests). */
  pace?: () => Promise<void>;
  log?: (msg: string) => void;
  dryRun?: boolean;
  mintId?: () => string;
  /** Poll budget for transcode CHECK_STATUS (default a few tries). */
  maxStatusPolls?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface ManualFlag {
  kind:
    | 'storyline'
    | 'draw-from-bank'
    | 'orphan-media'
    | 'unsupported-media'
    | 'missing-bank-ref'
    | 'title'
    | 'typeface';
  sourceBlockId?: string;
  sourceKey?: string;
  detail: string;
}

/** Group manual-handling flags by kind into a compact summary, e.g.
 *  "5 unsupported-media, 2 storyline". */
export function summarizeFlags(flags: ManualFlag[]): string {
  const counts = new Map<string, number>();
  for (const f of flags) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${kind}`)
    .join(', ');
}

export interface ExecResult {
  ok: boolean;
  dryRun: boolean;
  /** Every envelope that was (or would be) sent, in order — the dry-run plan. */
  envelopes: { step: PlanStep['kind']; label: string }[];
  flags: ManualFlag[];
  /** The resumable old→new id map (job log). */
  idMap: Record<string, string>;
  /** New course id once the shell is created. */
  newCourseId?: string;
  /** Surviving source media keys (must be empty on success). */
  survivingKeys: string[];
  error?: string;
}

/** Thrown on a loud-fail; carries the offending step + raw response. */
export class WriteError extends Error {
  constructor(
    message: string,
    readonly step: PlanStep['kind'],
    readonly raw?: string,
  ) {
    super(message);
    this.name = 'WriteError';
  }
}

function parseJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
function payloadOf(obj: Record<string, unknown>): Record<string, unknown> {
  const p = obj.payload;
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : obj;
}

/** Build source-id → object indexes once, so steps resolve their source doc. */
function indexSource(course: GetCourseDocument): {
  lessons: Map<string, Lesson>;
  blocks: Map<string, { block: Block; lessonId: string }>;
} {
  const lessons = new Map<string, Lesson>();
  const blocks = new Map<string, { block: Block; lessonId: string }>();
  for (const l of course.lessons ?? []) {
    const lid = typeof l.id === 'string' ? l.id : '';
    if (lid) lessons.set(lid, l);
    for (const b of (l.items ?? []) as Block[]) {
      const bid = typeof b.id === 'string' ? b.id : '';
      if (bid) blocks.set(bid, { block: b, lessonId: lid });
    }
  }
  return { lessons, blocks };
}

/** A minimal author profile for authoring locks / bank PUT lock_data. */
function authorProfile(author: string): Record<string, unknown> {
  return { user_id: author, staff: false, content_team_admin: false };
}

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
    if (dryRun) {
      log(`${pfx()} DRY  ${spec.method} ${spec.label}`);
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
    log(`${pfx()} OK   ${spec.method} ${spec.label}`);
    return parseJson(r.text);
  }

  try {
    let done = 0;
    for (const step of steps) {
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
          const resp = await send(
            env.putBank({
              bankId: newBankId,
              questions: questions as unknown[],
              session: mint(),
              lockData: authorProfile(author),
            }),
            step.kind,
          );
          if (!dryRun && resp.version === undefined && resp.questions === undefined) {
            throw new WriteError('Bank PUT did not echo a saved bank', step.kind, JSON.stringify(resp));
          }
          break;
        }
        case 'create-course': {
          const resp = await send(
            env.createCourseShell(deps.input.targetFolderId ?? 'all'),
            step.kind,
          );
          newCourseId = dryRun ? ids.remap(step.sourceCourseId) : String(resp.id ?? '');
          if (!newCourseId) throw new WriteError('Course create returned no id', step.kind, JSON.stringify(resp));
          ids.set(step.sourceCourseId, newCourseId);
          result.newCourseId = newCourseId;
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
          if (src && src.size) {
            const idMap = await resolveAndRecreateTypefaces(course, src);
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
          const build = async (img: unknown): Promise<unknown | undefined> => {
            const image = (img as { media?: { image?: Record<string, unknown> } })?.media?.image;
            const mainKey = typeof image?.key === 'string' ? image.key : '';
            if (!mainKey || !/^rise\/(?:courses|questionBanks)\//.test(mainKey)) return undefined;
            const up = await uploadImageAsset(mainKey);
            if (!up) return undefined;
            const km = new Map<string, string>([[mainKey, up.key]]);
            keyMap.set(mainKey, up.key);
            if (typeof image?.crushedKey === 'string') {
              km.set(image.crushedKey, up.crushedKey);
              keyMap.set(image.crushedKey, up.crushedKey);
            }
            return remapMediaKeys(img, km);
          };
          const coverImage = step.hasCover ? await build(course.coverImage) : undefined;
          const cardImage = step.hasCard ? await build(course.cardImage) : undefined;
          if (coverImage !== undefined || cardImage !== undefined) {
            await send(
              env.setCourseImages({ courseId: newCourseId, coverImage, cardImage }),
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
          // Lesson-level uploaded media (headerImage/media) isn't re-uploaded by
          // the captured write path — blank those keys (flagged unsupported) so a
          // dead source key is never written to the target lesson.
          const safeExtra = blankUploadedMediaKeys(extra) as Record<string, unknown>;
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
          const newBankId = ids.get(step.sourceBankId);
          if (!newBankId) throw new WriteError('bind before bank create', step.kind);
          const meta = blockMeta.get(step.sourceBlockId);
          const newLessonId = ids.get(step.sourceLessonId)!;
          const pendingItemId = mint();
          const questionList = bankQuestionIds.get(step.sourceBankId) ?? [];
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
          const newLessonId = ids.get(step.sourceLessonId)!;
          const meta = blockMeta.get(step.sourceBlockId);
          // 1) GET_YURL → presigned url + server key.
          const yurl = payloadOf(
            await send(env.getYurl({ courseId: newCourseId, filename: step.filename }), step.kind),
          );
          const newKey = dryRun ? `rise/courses/${newCourseId}/${mint()}` : String(yurl.key ?? '');
          const url = String(yurl.url ?? '');
          const ctype = String(yurl.type ?? 'application/octet-stream');
          if (!dryRun && (!newKey || !url)) {
            throw new WriteError('GET_YURL returned no key/url', step.kind, JSON.stringify(yurl));
          }
          // 2) PUT bytes to S3 (skipped in dry-run).
          if (!dryRun) {
            const bytes = await deps.readAsset(step.sourceKey);
            if (!bytes) throw new WriteError(`Missing archived bytes for ${step.sourceKey}`, step.kind);
            const put = await deps.relay(
              env.s3Put({ url, base64Body: bytes.base64, contentType: ctype }),
            );
            result.envelopes.push({ step: step.kind, label: 'S3 PUT (upload bytes)' });
            if (!put.ok) throw new WriteError(`S3 PUT failed (HTTP ${put.status})`, step.kind, put.text);
          } else {
            result.envelopes.push({ step: step.kind, label: 'S3 PUT (upload bytes)' });
          }
          // Map this source key → its new target key. Every distinct uploaded
          // key on a block (including a separate `crushedKey`) is its own
          // upload step, so a uniform per-key mapping covers them all and the
          // patch step swaps each — guaranteeing no source key survives.
          keyMap.set(step.sourceKey, newKey);
          // 3) Mirror the editor's post-processing for the main media: image →
          // CRUSH (output not needed for mapping, the bytes already round-trip);
          // a/v → TRANSCODE + register job + poll until done.
          if (step.mediaKind === 'media-image') {
            await send(env.crushImage(newCourseId, newKey), step.kind);
          } else if (step.mediaKind === 'media-video' || step.mediaKind === 'media-audio') {
            const refs = meta ? `items:${meta.newId}` : `items:${step.sourceBlockId}`;
            const tr = payloadOf(
              await send(
                env.transcodeAsset({
                  courseId: newCourseId,
                  key: encodeURIComponent(newKey),
                  lessonId: newLessonId,
                  mediaType: step.mediaKind === 'media-video' ? 'video' : 'audio',
                  original: step.filename,
                  refs,
                  uploadId: `${newLessonId}-${refs}`,
                }),
                step.kind,
              ),
            );
            const jobId = dryRun ? `dry-job-${mint()}` : String(tr.jobId ?? '');
            if (jobId) {
              await send(env.registerJobs(newCourseId, [jobId]), step.kind);
              await pollStatus(jobId, step.kind);
            }
          }
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
        case 'flag-storyline': {
          result.flags.push({
            kind: 'storyline',
            sourceBlockId: step.sourceBlockId,
            detail: 'Storyline/Mighty block — attach manually via a reachable Review 360 item',
          });
          break;
        }
        case 'flag-draw-from-bank': {
          result.flags.push({
            kind: 'draw-from-bank',
            sourceBlockId: step.sourceBlockId,
            detail:
              'Draw-from-bank block created as an unbound placeholder — attach a question bank manually (bank recreation is off)',
          });
          break;
        }
        case 'flag-orphan-media': {
          result.flags.push({
            kind: 'orphan-media',
            sourceBlockId: step.sourceBlockId,
            sourceKey: step.sourceKey,
            detail: 'Media is 403/deleted at source — block shipped without it',
          });
          break;
        }
        case 'flag-unsupported-media': {
          result.flags.push({
            kind: 'unsupported-media',
            sourceKey: step.sourceKey,
            detail: `Media at ${step.location} has no captured write path — attach manually (not written as a source key)`,
          });
          break;
        }
      }
      result.idMap = ids.toJSON();
      deps.onProgress?.(++done, steps.length);
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
    const used = usedTypefaceIds(course);
    const { idMap, toRecreate, unresolved } = resolveTypefaces(used, source, targetByName(target));

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

  // Upload an image (cover/card) via the standard chain and CRUSH it; returns the
  // new key + crushed key. (Shares the GET_YURL→S3 PUT→CRUSH_IMAGE flow.)
  async function uploadImageAsset(
    sourceKey: string,
  ): Promise<{ key: string; crushedKey: string } | null> {
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
    const crush = payloadOf(await send(env.crushImage(newCourseId, newKey), 'set-course-images'));
    const crushedKey = dryRun ? `${newKey}.crushed` : String(crush.key ?? newKey);
    return { key: newKey, crushedKey };
  }

  async function pollStatus(jobId: string, step: PlanStep['kind']): Promise<void> {
    if (dryRun) return;
    const budget = deps.maxStatusPolls ?? 10;
    for (let i = 0; i < budget; i++) {
      await pace();
      const resp = payloadOf(await send(env.checkStatus(newCourseId, [jobId]), step));
      const jobs = Array.isArray((resp as { jobs?: unknown }).jobs)
        ? ((resp as { jobs: unknown[] }).jobs)
        : Array.isArray(resp)
          ? (resp as unknown[])
          : [];
      // Empty / no in-flight job for this id ⇒ done.
      const stillRunning = jobs.some(
        (j) => j && typeof j === 'object' && (j as { id?: string }).id === jobId &&
          (j as { status?: string }).status !== 'complete',
      );
      if (!stillRunning) return;
    }
    log(`WARN transcode job ${jobId} did not confirm complete within budget`);
  }
}
