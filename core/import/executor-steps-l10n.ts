// Executor step handlers — l10n (v0.9.0 restructure, phase B; split out of
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

export async function handleSetCourseDescription(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'set-course-description' }>,
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
          // Best-effort like set-title — a missing description ref surfaces in
          // the read-back, not as a course failure.
          try {
            await send(
              env.updateCourseFieldThrottle(ctx.newCourseId, 'description', step.value),
              step.kind,
            );
          } catch (e) {
            log(`WARN course description not set (continuing): ${(e as Error).message}`);
          }
}

export async function handleConvertStack(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'convert-stack' }>,
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
          await send(
            env.createTranslations(ctx.newCourseId, {
              sourceLanguage: step.sourceLanguage,
              targetLanguages: step.targetLanguages,
              formality: step.formality,
            }),
            step.kind,
          );
}

export async function handleAwaitStack(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'await-stack' }>,
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
          if (!dryRun) {
            // Poll the stack state until every expected language is `complete`.
            // Paced like every authoring read; one recorded envelope, per-poll
            // progress in the log ([i/N] stays visibly alive during the wait).
            // The default ceiling is sized for a FULL-COURSE conversion
            // (idea 2) — minimal conversions ran 15-70 s/language, a real
            // course's duration is unmeasured (R1), so allow ~30 min.
            const spec = env.getTranslations(ctx.newCourseId);
            result.envelopes.push({ step: step.kind, label: spec.label });
            const tries = Math.max(1, deps.stackAwaitTries ?? 900);
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

            // PAIR every source ref to the ref the target's own conversion
            // minted (course fields by path, lessons via the id map, blocks
            // via the minted client ids — core/l10n/pair.ts). This map is the
            // ONLY way a cell write addresses the target; no source l10nId
            // ever ships under idea 2.
            const rb = await send(env.getCourse(ctx.newCourseId), step.kind);
            const targetDoc = payloadOf(rb) as GetCourseDocument;
            if (!isLocalizedStack(targetDoc)) {
              throw new WriteError(
                'Target course is not l10n-ified after the conversion completed',
                step.kind,
                JSON.stringify(targetDoc.course ?? {}).slice(0, 300),
              );
            }
            ctx.targetStackDoc = targetDoc;
            const pairing = pairL10nRefs(deps.input.course, targetDoc, {
              lessonId: (l) => ids.get(l),
              blockId: (l, b) => blockMeta.get(blockKey(l, b))?.newId,
            });
            for (const [s, t] of pairing.map) stackRefMap.set(s, t);
            result.l10nRefMap = Object.fromEntries(stackRefMap);
            // Target-only refs over DEEP-EMPTY source slots are conversion
            // artifacts (the empty-logo class) — recorded so read-back parity
            // treats their cells as EXPECTED, never as divergences.
            result.l10nExpectedExtra = pairing.targetOnlyEmpty.map((r) => r.l10nId);
            for (const u of pairing.unmatched) {
              unmatchedCourseRefs.add(u.l10nId);
              result.flags.push({
                kind: 'l10n-ref',
                detail: `Localized value at ${u.path} has no counterpart on the target (its Rise does not localize that field) — set it manually per language`,
              });
              log(`${pfx()} ⚠ FLAG l10n-ref — ${u.path} unmatched on target`);
            }
            for (const u of pairing.targetOnly) {
              result.flags.push({
                kind: 'l10n-ref',
                detail: `Target localized ${u.path}, which the source held as plain text — the conversion's AI text shows in non-default languages there; review it`,
              });
              log(`${pfx()} ⚠ FLAG l10n-ref — ${u.path} localized only on the target (AI text)`);
            }
            log(
              `${pfx()} OK   paired ${pairing.map.size} ref(s)` +
                (pairing.unmatched.length ? `, ${pairing.unmatched.length} unmatched` : '') +
                (pairing.targetOnlyEmpty.length
                  ? `, ${pairing.targetOnlyEmpty.length} empty-slot target ref(s) (expected)`
                  : ''),
            );
          } else {
            result.envelopes.push({
              step: step.kind,
              label: `poll ${env.getTranslations('(new course)').label} until complete`,
            });
            log(`${pfx()} DRY  await stack conversion (${step.expectedLocales.join(', ')})`);
          }
}

export async function handleUploadL10nAsset(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'upload-l10n-asset' }>,
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
          await uploadOne(step.sourceKey, step.filename, step.kind);
}

export async function handleWriteL10n(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'write-l10n' }>,
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
          const changes = step.l10nIds
            .map((id) => buildCellChange(id, step.locale))
            .filter((c): c is L10nChange => c !== null);
          const skipped = step.l10nIds.length - changes.length;
          if (changes.length === 0) {
            log(
              `${pfx()} skip write-l10n [${step.locale}] — no cells resolved` +
                (skipped ? ` (${skipped} unpaired/flagged)` : ''),
            );
            return;
          }
          await send(env.updateL10nBatch(ctx.newCourseId, changes), step.kind);
          log(
            `${pfx()} [${step.batchIndex}/${step.batchTotal} l10n batches] OK ${changes.length} cell(s) [${step.locale}]` +
              (skipped ? ` (${skipped} skipped — unpaired/flagged)` : ''),
          );
}

export async function handleSetLocaleLabelset(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'set-locale-labelset' }>,
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
              courseId: ctx.newCourseId,
              locale: step.locale,
              labelSetId: targetSetId,
            }),
            step.kind,
          );
}

export async function handleSetStackTitles(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'set-stack-titles' }>,
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
          // Title + description cells for every writable NON-DEFAULT locale,
          // FALLBACK-RESOLVED (D2): a locale the source serves by
          // default-language fallback gets the default value — the target then
          // displays exactly what the source displays there. The default
          // locale is NEVER written (its cells came from the conversion of the
          // clean pre-conversion title/description; a default write would
          // re-pend the cell in every locale).
          const course = deps.input.course.course ?? {};
          const refs = [course.title, course.description].filter(isL10nRef);
          const writable = writableLocaleCodes(deps.input.course);
          const locales = Object.keys(srcTables).filter(
            (c) => c !== srcDefaultLocale && writable.has(c),
          );
          for (const locale of locales) {
            const changes: L10nChange[] = [];
            for (const ref of refs) {
              const value =
                srcTables[locale]?.[ref.l10nId] ?? srcTables[srcDefaultLocale]?.[ref.l10nId];
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
              await send(env.updateL10nBatch(ctx.newCourseId, changes), step.kind);
            }
          }
}

export async function handleFlagL10nLocale(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'flag-l10n-locale' }>,
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
}

export async function handleFlagLocaleSelector(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'flag-locale-selector' }>,
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
            kind: 'locale-selector',
            detail:
              'The source stack shows the learner language selector — enable it manually on the target (the toggle envelope is not capture-proven yet)',
          });
          log(`${pfx()} ⚠ FLAG locale-selector — enable the language selector manually`);
}

