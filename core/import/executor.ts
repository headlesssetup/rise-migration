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

/** chrome.runtime messages are capped at 64MiB; the asset's base64 body rides one
 *  (plus envelope overhead), so guard a bit under the limit. Larger assets are
 *  flagged for manual upload rather than crashing the course. */
const MAX_RELAY_BASE64 = 60 * 1024 * 1024;

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
  /** source typeface id → target typeface id, pre-resolved by the account-settings
   *  step (A): all fonts already matched-by-name + custom ones recreated. When a
   *  course's typeface id is seeded here, set-theme reuses it (no per-course font
   *  upload); ids NOT seeded fall back to in-loop resolve/recreate. */
  typefaceIdMap?: Map<string, string>;
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
  /** Set when a created shell was soft-deleted (transactional rollback) because
   *  the import failed or the course never materialized — so a never-born phantom
   *  never strands in the root folder. */
  rolledBack?: boolean;
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
  // A successful CREATE_LESSON is the write that materializes the runtime course
  // document (POST /content only mints a catalog row). If a run ends without one,
  // the shell never became a real course → a phantom that 500s content/search.
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

  // Transactional cleanup: soft-delete a created shell whose import failed or
  // never materialized, so a never-born phantom never strands in the root folder
  // (it 500s the dashboard's content/search). Best-effort + status-agnostic — the
  // manage/api soft-delete is cookie-authed (lands even when the failure was a
  // stale-bearer 403) and takes effect even when it answers 500 on a shell with no
  // runtime doc. Never throws (rollback must not mask the original failure).
  async function rollbackShell(why: string): Promise<void> {
    if (dryRun || !newCourseId) return;
    try {
      await pace();
      await deps.relay(env.softDeleteContent([newCourseId]));
      result.rolledBack = true;
      log(`Rolled back orphaned course ${newCourseId} (${why})`);
    } catch (re) {
      log(`WARN rollback soft-delete failed for ${newCourseId}: ${(re as Error).message}`);
    }
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
          const build = async (img: unknown): Promise<unknown | undefined> => {
            const image = (img as { media?: { image?: Record<string, unknown> } })?.media?.image;
            const mainKey = typeof image?.key === 'string' ? image.key : '';
            if (!mainKey || !/^rise\/(?:courses|questionBanks)\//.test(mainKey)) return undefined;
            const newMain = await uploadImageAsset(mainKey);
            if (!newMain) return undefined;
            const km = new Map<string, string>([[mainKey, newMain]]);
            keyMap.set(mainKey, newMain);
            // Upload the crushed variant faithfully too (verbatim bytes) — no
            // re-crush; the exported crushedKey IS the crushed image.
            if (typeof image?.crushedKey === 'string' && /^rise\/(?:courses|questionBanks)\//.test(image.crushedKey)) {
              const newCrushed = await uploadImageAsset(image.crushedKey);
              if (newCrushed) {
                km.set(image.crushedKey, newCrushed);
                keyMap.set(image.crushedKey, newCrushed);
              }
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
          // A successful lesson create materializes the runtime course document.
          if (!dryRun) materialized = true;
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
          // Dedup: a source asset reused across blocks (e.g. a logo) uploads ONCE.
          // The plan emits an upload step per (block, key), so the SAME source key
          // can recur — if it's already uploaded, reuse the new key instead of
          // creating a duplicate copy in the target. (CLAUDE.md: upload once, reuse
          // the key for all references.)
          if (keyMap.has(step.sourceKey)) {
            log(`${pfx()} reuse ${step.sourceKey} (already uploaded)`);
            break;
          }
          // Read bytes FIRST, so we can size-guard before issuing any write. The
          // bytes ride a chrome.runtime message (base64) which is capped at 64MiB
          // — a bigger asset can't be relayed, so flag it (don't crash the whole
          // course) and blank the key so no dead source key survives.
          let bytes: AssetBytes | null = null;
          if (!dryRun) {
            bytes = await deps.readAsset(step.sourceKey);
            if (!bytes) throw new WriteError(`Missing archived bytes for ${step.sourceKey}`, step.kind);
            if (bytes.base64.length > MAX_RELAY_BASE64) {
              const mb = Math.round(bytes.base64.length / (1024 * 1024));
              log(`${pfx()} WARN ${step.sourceKey} too large to upload via the extension (~${mb}MB > 64MB message limit) — flagged, attach manually`);
              result.flags.push({
                kind: 'unsupported-media',
                sourceKey: step.sourceKey,
                detail: `Asset ~${mb}MB exceeds the 64MB extension message limit — upload it manually in Rise`,
              });
              keyMap.set(step.sourceKey, ''); // blank → no dead source key survives
              break;
            }
          }
          // Faithful upload: GET_YURL → S3 PUT of the EXACT exported bytes → map
          // the source key. We do NOT crush images or transcode a/v — the source
          // asset is the source of truth (Rise already crushed/transcoded it at
          // author time; re-processing would recompress and drift). Every distinct
          // source key (original, crushedKey, poster, caption .vtt) is its own
          // upload step, so the per-key map covers them all and the patch step
          // swaps each — guaranteeing no source key survives.
          const yurl = payloadOf(
            await send(env.getYurl({ courseId: newCourseId, filename: step.filename }), step.kind),
          );
          const newKey = dryRun ? `rise/courses/${newCourseId}/${mint()}` : String(yurl.key ?? '');
          const url = String(yurl.url ?? '');
          const ctype = String(yurl.type ?? 'application/octet-stream');
          if (!dryRun && (!newKey || !url)) {
            throw new WriteError('GET_YURL returned no key/url', step.kind, JSON.stringify(yurl));
          }
          if (!dryRun && bytes) {
            const put = await deps.relay(
              env.s3Put({ url, base64Body: bytes.base64, contentType: ctype }),
            );
            result.envelopes.push({ step: step.kind, label: 'S3 PUT (upload bytes)' });
            if (!put.ok) throw new WriteError(`S3 PUT failed (HTTP ${put.status})`, step.kind, put.text);
          } else {
            result.envelopes.push({ step: step.kind, label: 'S3 PUT (upload bytes)' });
          }
          keyMap.set(step.sourceKey, newKey);
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

    // Materialization guard: a run can finish without throwing yet never create
    // any content (e.g. a lesson-less course, or one whose only lesson is a blockless
    // section that still creates — but a truly content-less course makes no
    // CREATE_LESSON). An un-materialized shell 404s GET_COURSE but 500s
    // content/search — a phantom. Roll it back rather than report a hollow success.
    if (!dryRun && newCourseId && !materialized) {
      await rollbackShell('no content write materialized the course');
      result.ok = false;
      result.error =
        'Course shell never materialized (no lesson created) — rolled back to avoid a phantom in the root folder';
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
    // Roll back the created shell so a failed import never leaves a phantom in root.
    await rollbackShell('import failed before completion');
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
