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
    | 'orphan-media'
    | 'unsupported-media'
    | 'missing-bank-ref'
    | 'typeface';
  sourceBlockId?: string;
  sourceKey?: string;
  detail: string;
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

  // Relay + loud-fail wrapper. In dry-run, record the envelope and return a
  // synthetic empty body (callers synthesize ids separately).
  async function send(spec: WriteSpec, step: PlanStep['kind']): Promise<Record<string, unknown>> {
    result.envelopes.push({ step, label: spec.label });
    if (dryRun) {
      log(`DRY  ${spec.method} ${spec.label}`);
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
    log(`OK   ${spec.method} ${spec.label}`);
    return parseJson(r.text);
  }

  try {
    let done = 0;
    for (const step of steps) {
      switch (step.kind) {
        case 'create-bank': {
          const bank = deps.input.banksById.get(step.sourceBankId);
          const resp = await send(
            env.postBank({ folderId: deps.input.targetFolderId ?? null, title: step.title }),
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
          // Theme round-trips verbatim EXCEPT any user-uploaded cover/header key
          // (rise/courses/<srcId>/…) which would be a dead source key on target —
          // blank those (flagged as unsupported-media); built-in cdn/asset theme
          // images are kept as-is.
          const theme = blankUploadedMediaKeys(deps.input.course.course?.theme ?? {});
          await send(env.updateCourseTheme(newCourseId, theme), step.kind);
          break;
        }
        case 'set-title': {
          await send(env.updateCourseField(newCourseId, 'title', step.title), step.kind);
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
        case 'create-block': {
          const entry = srcBlocks.get(step.sourceBlockId);
          if (!entry) throw new WriteError(`Source block ${step.sourceBlockId} not found`, step.kind);
          const newLessonId = ids.get(step.sourceLessonId)!;
          // Copy-faithful: regenerate ids + strip server fields, then blank
          // uploaded media keys (filled by the patch step after re-upload).
          const remapped = blankUploadedMediaKeys(remapIds(entry.block, ids)) as Record<string, unknown>;
          const newBlockId = String(remapped.id ?? '');
          const previousBlockId = step.previousSourceBlockId
            ? ids.get(step.previousSourceBlockId) ?? null
            : null;
          const resp = await send(
            env.createBlocks({
              courseId: newCourseId,
              lessonId: newLessonId,
              previousBlockId,
              blocks: [remapped],
            }),
            step.kind,
          );
          if (!dryRun) {
            const p = payloadOf(resp);
            const meta = Array.isArray(p.blockMetadata)
              ? (p.blockMetadata[0] as Record<string, unknown> | undefined)
              : undefined;
            if (p.success !== true || !meta || meta.id !== newBlockId) {
              throw new WriteError(
                'CREATE_BLOCKS did not confirm the block id we sent',
                step.kind,
                JSON.stringify(resp),
              );
            }
            blockMeta.set(step.sourceBlockId, {
              newId: newBlockId,
              globalBlockId: typeof meta.globalBlockId === 'string' ? meta.globalBlockId : undefined,
            });
          } else {
            blockMeta.set(step.sourceBlockId, { newId: newBlockId });
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
    result.error = e instanceof WriteError ? `[${e.step}] ${e.message}` : String(e);
    return result;
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
