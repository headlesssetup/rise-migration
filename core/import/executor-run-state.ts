// The executor's per-run CONTEXT — split out of executor.ts (v0.9.0
// restructure, phase B; executor.ts re-exports ExecCtx, and `@/core/import`'s
// surface is unchanged). See executor.ts for the protocol walk itself.

import { IdMap, newId } from './ids';
import {
  defaultLocaleOf,
  isLocalizedStack,
  materializeLocale,
  type L10nChange,
} from '@/core/l10n';
import { remapMediaKeys } from './remap';
import { collectBuiltinRefs, probeBuiltinRefs } from './builtin-assets';
import * as env from './envelopes';
import type { WriteSpec } from './envelopes';
import { MAX_UPLOAD_BASE64, type PlanStep } from './plan';
import {
  WriteError,
  parseJson,
  payloadOf,
  indexSource,
} from './executor-types';
import type { ExecutorDeps, ExecResult, AssetBytes } from './executor-types';
import type { Block, GetCourseDocument } from '@/shared/types/rise';

/**
 * Per-run executor context (v0.9.0 restructure, phase A of the anticipated
 * "v0.9.0 refactor"): ALL run state + the shared plumbing (send/uploadOne/…),
 * created once per executePlan call. The bodies below are verbatim moves; the
 * mutable primitives are exposed as get/set properties so step handlers and
 * the loop mutate the SAME internal state the closures read (pfx ↔ stepIdx,
 * uploadOne ↔ newCourseId, …). The characterization test freezes the exact
 * envelope order this produces.
 */
export function makeExecCtx(steps: PlanStep[], deps: ExecutorDeps) {
  const mint = deps.mintId ?? newId;
  const ids = deps.ids ?? new IdMap(mint);
  const pace = deps.pace ?? (async () => {});
  const log = deps.log ?? (() => {});
  const dryRun = deps.dryRun ?? false;
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
  // Pre-created SHELL lessons observed on the create-course handshake GET_COURSE
  // (F2, capture-proven: a `onePage` shell ships WITH one empty-titled `blocks`
  // lesson the editor writes straight into; regular/aiOutline shells are
  // lessonless). Each unclaimed empty shell lesson is ADOPTED by the first
  // matching create-lesson step instead of creating a duplicate.
  const shellLessons: { id: string }[] = [];
  // sourceBlockId → {newId, globalBlockId} (from CREATE_BLOCKS metadata).
  const blockMeta = new Map<string, { newId: string; globalBlockId?: string }>();
  // blockKey → the normalized block CREATE_BLOCKS shipped (post-freshClientIds,
  // pre-media-blanking). Follow-up UPDATE payloads (media patch, storyline
  // attach) MUST rebuild from this, never from the raw source block: the
  // freshClientIds mint map is local to its call, so a block whose source id is
  // not cuid-shaped gets a DIFFERENT id on re-normalization — and the server
  // resolves UPDATE_BLOCK_DEBOUNCE from the item payload's own id, so the
  // mismatch 404s ("Block <sourceId> not found in lesson", observed 2026-08-20).
  const normBlocks = new Map<string, Block>();
  // sourceKey → new target key (after upload) for media patches.
  const keyMap = new Map<string, string>();
  // sourceBankId → ordered new question ids (for INSERT_QUESTION_BANK_QUESTIONS).
  const bankQuestionIds = new Map<string, string[]>();

  // --- Multi-language stack state (docs/rise-multilang.md, idea-2 shape) ---
  const stack = isLocalizedStack(deps.input.course);
  const srcTables = deps.input.course.l10n?.translations ?? {};
  const srcDefaultLocale = defaultLocaleOf(deps.input.course) ?? 'en-us';
  // Source l10nId → the TARGET's own ref id, for EVERY ref (course fields,
  // lesson titles, block-internal refs) — built at await-stack by pairing the
  // raw source doc against the converted target (core/l10n/pair.ts). No source
  // l10nId ever ships to the target under idea 2.
  const stackRefMap = new Map<string, string>();
  // Target GET_COURSE snapshot taken at await-stack (post-conversion) — tells
  // the cell writer which (ref, locale) rows the conversion created.
  let targetStackDoc: GetCourseDocument | null = null;
  // Materialized default locale — the CONTENT the build ships (display strings,
  // plain media objects, plain course images). The RAW doc (with refs) is used
  // only for pairing + cell values.
  const matDoc = stack ? materializeLocale(deps.input.course).doc : deps.input.course;
  // Content index over the doc the build ships (materialized for stacks).
  const { lessons: srcLessons, blocks: srcBlocks } = indexSource(matDoc);

  // Source refs with NO counterpart on the converted target (pairing gaps,
  // flagged l10n-ref at await-stack). Their cells are skipped: the target has
  // no ref to address, and source ids must never ship.
  const unmatchedCourseRefs = new Set<string>();

  /** One target-locale cell write: value from the archive (media-remapped), id
   *  mapped through the pairing map. Post-conversion every mapped cell EXISTS
   *  on the target (the conversion minted it), so writes are bare `update`s —
   *  the capture-proven shape for writing further locales on an existing cell
   *  (capture2aug §4.3b). An unmapped id returns null (flagged at pairing). */
  const buildCellChange = (l10nId: string, locale: string): L10nChange | null => {
    const value = srcTables[locale]?.[l10nId];
    if (value === undefined) return null;
    if (unmatchedCourseRefs.has(l10nId)) return null; // flagged, not orphaned
    const targetId = stackRefMap.get(l10nId);
    if (!targetId) {
      if (!dryRun) return null; // dry-run has no pairing — keep the preview count
      return {
        action: 'update',
        l10nId,
        locale,
        value: remapMediaKeys(value as never, keyMap) as typeof value,
      };
    }
    return {
      action: 'update',
      l10nId: targetId,
      locale,
      value: remapMediaKeys(value as never, keyMap) as typeof value,
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
  // Values already probed/flagged this run — dedupes the flag itself (the
  // network probe is deduped separately via deps.builtinProbeCache).
  const notedBuiltinValues = new Set<string>();
  const noteBuiltins = async (img: unknown, where: string): Promise<void> => {
    const refs = collectBuiltinRefs(img).filter((r) => !notedBuiltinValues.has(r.value));
    if (refs.length === 0) return;
    for (const r of refs) notedBuiltinValues.add(r.value);
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


  return {
    deps,
    mint,
    ids,
    pace,
    log,
    dryRun,
    author,
    result,
    shellLessons,
    blockMeta,
    normBlocks,
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
    total,
    pfx,
    send,
    reportOrphanShell,
    uploadOne,
    buildCellChange,
    noteBuiltins,
    get newCourseId() { return newCourseId; },
    set newCourseId(v: string) { newCourseId = v; },
    get materialized() { return materialized; },
    set materialized(v: boolean) { materialized = v; },
    get targetStackDoc() { return targetStackDoc; },
    set targetStackDoc(v: GetCourseDocument | null) { targetStackDoc = v; },
    get stepIdx() { return stepIdx; },
    set stepIdx(v: number) { stepIdx = v; },
  };
}

/** The executor's run context — everything step handlers may touch. */
export type ExecCtx = ReturnType<typeof makeExecCtx>;
