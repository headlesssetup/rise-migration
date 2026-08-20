// Read-back verification of ONE imported course — split out of ./import's
// runImport (v0.9.0 restructure). The true round-trip check (CLAUDE.md):
// paced GET_COURSE of the NEW course → structural parity vs the archived
// source, foreign-key ownership on the REAL target, typeface identity,
// storyline bundle HEAD probes, and (stacks) cell-table parity + the pending
// SET. Mutates the passed fidelity `report` exactly as the inline block did.

import {
  checkSourceNotTarget,
  findForeignMediaKeys,
  findLocalAssetRefs,
  getTranslations,
  getTranslationUpdates,
  verifyL10nParity,
  verifyParity,
  verifyTypefaceBindings,
  type AccountIdentity,
  type ExecResult,
  type FidelityReport,
  type L10nParityReport,
  type ParityReport,
  type PendingSetReport,
  type PlanStep,
  type SourceBank,
} from '@/core/import';
import {
  defaultLocaleOf,
  defaultOnlyTextCells,
  parseTranslationUpdates,
  pendingKey,
  stackLocales,
} from '@/core/l10n';
import { pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { GetCourseDocument } from '@/shared/types/rise';
import { safeJson, type BoundBankMap } from './import-shared';
import type { makePinnedRelay, pinnedRpc } from './import-shared';
import { unwrap, type ProgressEvent } from './shared';

export interface ReadBackArgs {
  pacing: PacingConfig;
  onEvent: (e: ProgressEvent) => void;
  send: ReturnType<typeof pinnedRpc>;
  relay: ReturnType<typeof makePinnedRelay>;
  course: GetCourseDocument;
  res: ExecResult;
  steps: PlanStep[];
  banksById: Map<string, SourceBank>;
  boundBanks: BoundBankMap;
  target: AccountIdentity | undefined;
  pfx: string;
  courseIsStack: boolean;
  labelSetCache: Map<string, string>;
  courseId: string;
  report: FidelityReport;
}

export interface ReadBackResult {
  parity: ParityReport | undefined;
  readBackForeign: string[];
  l10nParity: L10nParityReport | undefined;
  l10nPending: Record<string, number> | undefined;
  l10nPendingSet: PendingSetReport | undefined;
  aiTextCells: string[] | undefined;
}

export async function verifyCourseReadBack(args: ReadBackArgs): Promise<ReadBackResult> {
  const {
    pacing,
    onEvent,
    send,
    relay,
    course,
    res,
    steps,
    banksById,
    boundBanks,
    target,
    pfx,
    courseIsStack,
    labelSetCache,
    courseId,
    report,
  } = args;
  let parity: ParityReport | undefined;
  let readBackForeign: string[] = [];
  let l10nParity: L10nParityReport | undefined;
  let l10nPending: Record<string, number> | undefined;
  let l10nPendingSet: PendingSetReport | undefined;
  let aiTextCells: string[] | undefined;
  // Caller contract: only invoked for a successful live write with a course id.
  const newCourseId = res.newCourseId;
  if (!newCourseId) {
    return { parity, readBackForeign, l10nParity, l10nPending, l10nPendingSet, aiTextCells };
  }

      await pacedDelay(pacing);
      onEvent({ kind: 'log', message: `Verifying parity (read-back GET_COURSE ${newCourseId})…` });
      // Pinned like every other request of the run: the read-back must GET the
      // course from the tab we wrote it to, or an unpinned re-resolve could ask
      // the SOURCE account for an id that only exists on the target (404 → a
      // false "could not verify" on a course that is actually fine).
      const rb = await send({ type: 'GET_COURSE', courseId: newCourseId });
      if (rb.type === 'COURSE_RESULT' && rb.result.ok) {
        const targetDoc = unwrap(rb.result.data.raw);
        parity = verifyParity(course, targetDoc, res.flags);

        // INVARIANT, measured on the REAL target (CLAUDE.md: "no source media keys
        // may survive"). The executor asserts this against a doc it derived itself,
        // which can only ever confirm its own bookkeeping; this reads what Rise
        // actually stored. Any uploaded key not owned by the new course / new banks
        // is a key that wasn't remapped → fail this course loudly.
        const targetOwners = new Set<string>([newCourseId]);
        for (const sourceBankId of banksById.keys()) {
          const newBankId = res.idMap[sourceBankId] ?? boundBanks.get(sourceBankId)?.newBankId;
          if (newBankId) targetOwners.add(newBankId);
        }
        readBackForeign = [
          ...findForeignMediaKeys(targetDoc, targetOwners),
          ...findLocalAssetRefs(targetDoc).map(
            (ref) => `local-asset:${ref.assetPath}@${ref.path}`,
          ),
        ];

        // Typeface IDENTITY: parity tokenizes ids, so it proves a font is bound
        // but not WHICH — resolve the three binding slots to names on both
        // sides (course.typefaces maps id → name in every GET_COURSE).
        {
          const hadTypefaceFlag = res.flags.some((f) => f.kind === 'typeface');
          const tf = verifyTypefaceBindings(course, targetDoc, hadTypefaceFlag);
          for (const i of tf.issues) {
            parity.issues.push({ kind: 'course-field-changed', path: i.path, detail: i.detail });
            parity.ok = false;
          }
          for (const i of tf.expected) {
            parity.expectedDivergences.push({
              kind: 'course-field-changed',
              path: i.path,
              detail: i.detail,
              expected: true,
            });
          }
          if (tf.issues.length) {
            onEvent({
              kind: 'log',
              message: `${pfx} ⚠ typeface read-back: ${tf.issues.map((i) => `${i.path} (${i.detail})`).join('; ')}`,
            });
          }
        }

        // Storyline bundles: copy_review_item's 200 proved the copy request was
        // accepted — HEAD the copied bundle's story.html on usercontent (public
        // read, outside pacing) to confirm it actually exists and serves.
        for (const prefix of res.storylinePrefixes ?? []) {
          // Plane-pinned probe only: with no known target plane, guessing a
          // host would report a false "not readable" against the wrong CDN.
          if (!target?.plane) {
            onEvent({
              kind: 'log',
              message: `${pfx} ⚠ storyline read-back skipped for ${prefix}/story.html — target plane unknown, cannot pick a usercontent host`,
            });
            continue;
          }
          const base = target.plane === 'eu'
            ? 'https://articulateusercontent.eu/'
            : 'https://articulateusercontent.com/';
          let ok = false;
          let status = 0;
          try {
            const r = await fetch(`${base}${prefix}/story.html`, { method: 'HEAD', cache: 'no-store' });
            ok = r.ok;
            status = r.status;
          } catch {
            /* network error → unverified */
          }
          if (ok) {
            onEvent({ kind: 'log', message: `${pfx} storyline read-back OK — ${prefix}/story.html` });
          } else {
            parity.issues.push({
              kind: 'media-missing',
              path: `storyline ${prefix}/story.html`,
              detail: `attached bundle not readable on usercontent (HTTP ${status})`,
            });
            parity.ok = false;
            onEvent({
              kind: 'log',
              message: `${pfx} ⚠ storyline read-back: ${prefix}/story.html not readable (HTTP ${status})`,
            });
          }
        }
        if (readBackForeign.length) {
          report.ok = false;
          report.survivingSourceKeys = [
            ...new Set([...report.survivingSourceKeys, ...readBackForeign]),
          ];
          report.error =
            `Read-back FAILED: ${readBackForeign.length} foreign media key(s) survived on the target ` +
            `course ${newCourseId} (${readBackForeign.slice(0, 3).join(', ')}${readBackForeign.length > 3 ? ', …' : ''})`;
          onEvent({ kind: 'log', message: `${pfx} ${report.error} — course kept; re-run to repair, or fix those blocks manually` });
        }

        // Multi-language stack: verify the translation tables cell-by-cell
        // (locale sets, per-locale values modulo media remap) and read back the
        // per-language pending counts for the report.
        if (courseIsStack) {
          // ONLY the FLAGGED storyline cells (flag-l10n-storyline: no staged
          // package for that language) are deliberately not copied — their
          // absence is announced, not a failure (docs/rise-multilang.md §4.3b).
          // Cells the run ATTACHED are not tolerated: if an attached storyline
          // cell is missing on read-back, the write was lost and that is a
          // real divergence, not an expected absence.
          const toleratedMissing = new Set<string>();
          for (const s of steps) {
            if (s.kind === 'flag-l10n-storyline') {
              for (const loc of s.locales) toleratedMissing.add(`${s.l10nId} ${loc}`);
            }
          }
          // Refs the pairing could not match (flagged l10n-ref at await-stack)
          // are deliberately NOT written — the target has no ref to address.
          // Their announced absence is tolerated. Also tolerated MISSING: the
          // default-locale rows of source cells — idea 2 never writes default
          // rows; their VALUES are verified through the materialized build
          // (block/course-field parity), not the cell tables.
          const pairMap = new Map(Object.entries(res.l10nRefMap ?? {}));
          const allLocaleCodes = Object.keys(course.l10n?.translations ?? {});
          for (const table of Object.values(course.l10n?.translations ?? {})) {
            for (const id of Object.keys(table)) {
              if (!pairMap.has(id)) {
                for (const code of allLocaleCodes) toleratedMissing.add(`${id} ${code}`);
              }
            }
          }
          l10nParity = verifyL10nParity(course, targetDoc, {
            toleratedMissing,
            idMap: pairMap,
            toleratedExtra: new Set(res.l10nExpectedExtra ?? []),
          });
          // Target rows in locales the source serves by fallback are the
          // conversion's AI translations of REAL content (idea 2) — expected,
          // status-neutral, listed as aiTextCells in the report. No manual-work
          // flag: the operator reviews the report list, nothing is broken.
          if (l10nParity.placeholderJunk?.length) {
            onEvent({
              kind: 'log',
              message:
                `${pfx} NOTE ${l10nParity.placeholderJunk.length} cell(s) hold the conversion's AI ` +
                `translation in languages the source serves by default-language fallback — expected ` +
                `under the full-course-first import; see the AI-text list in ${courseId}.report.md`,
            });
          }
          // Per-language label-set bindings: every source locale with a CUSTOM
          // set must be bound on the target to the set this run recreated for it.
          for (const row of stackLocales(course)) {
            const code = String(row.locale ?? '');
            const srcSet = typeof row.labelSetId === 'string' ? row.labelSetId : null;
            if (!code || !srcSet || code === defaultLocaleOf(course)) continue;
            const expectedSet = labelSetCache.get(srcSet);
            const tgtRow = stackLocales(targetDoc).find((r) => r.locale === code);
            const actual = typeof tgtRow?.labelSetId === 'string' ? tgtRow.labelSetId : null;
            if (!actual || (expectedSet && actual !== expectedSet)) {
              l10nParity.issues.push({
                kind: 'labelset-binding',
                locale: code,
                detail: actual
                  ? `bound to ${actual}, expected ${expectedSet}`
                  : 'custom label set not bound on the target',
              });
              l10nParity.ok = false;
            }
          }
          onEvent({
            kind: 'log',
            message: l10nParity.ok
              ? `Language parity OK — ${l10nParity.cells.compared} cell(s) match across ${l10nParity.locales.target.length} language(s)`
              : `Language parity DIVERGENCES — ${l10nParity.issues.length} issue(s) (see ${courseId}.report.md)`,
          });
          if (!l10nParity.ok) {
            report.ok = false;
            report.error =
              report.error ??
              `Language read-back FAILED: ${l10nParity.issues.length} translation divergence(s) on ${newCourseId}`;
          }
          // Pending translations — measured as a SET (F5). `pendingChangesCount`
          // is LAZY (0 at read-back, populated hours later) and the badge
          // number is a segment-ish tally, so counts are recorded as decoration
          // only; `…/translations/updates` lists each pending (l10nId, locale)
          // entry and is the truth. Expected set after this import shape: EMPTY
          // (the conversion stamps every cell; no default row is written after
          // it). Non-empty → warn + record, never fail the course on it (the
          // signal itself can materialize lazily — the report says to re-check).
          await pacedDelay(pacing);
          const tr = await relay(getTranslations(newCourseId));
          if (tr.ok && tr.text) {
            const body = safeJson(tr.text) as Record<string, unknown>;
            const items = Array.isArray(body?.stackItems)
              ? (body.stackItems as Record<string, unknown>[])
              : [];
            l10nPending = {};
            for (const it of items) {
              const code = String(it.locale ?? '');
              const n = typeof it.pendingChangesCount === 'number' ? it.pendingChangesCount : 0;
              if (code && n > 0) l10nPending[code] = n;
            }
          }
          await pacedDelay(pacing);
          const up = await relay(getTranslationUpdates(newCourseId));
          if (up.ok && up.text) {
            const parsed = parseTranslationUpdates(safeJson(up.text));
            l10nPendingSet = {
              count: parsed.pending.length,
              keys: parsed.pending.map(pendingKey).slice(0, 50),
              updateCount: parsed.updateCount,
              inProgress: parsed.inProgress,
            };
            if (parsed.pending.length === 0) {
              onEvent({
                kind: 'log',
                message: `${pfx} pending translations: 0 — every cell stamped (expected)`,
              });
            } else {
              onEvent({
                kind: 'log',
                message:
                  `${pfx} ⚠ pending translations: ${parsed.pending.length} cell(s) ` +
                  `(badge tally ${parsed.updateCount ?? '—'}) — expected 0 after this import shape. ` +
                  'The signal can materialize lazily; re-check Manage languages later and see ' +
                  `${courseId}.report.md. Do NOT run "Update translation" before understanding the list.`,
              });
            }
          } else {
            onEvent({
              kind: 'log',
              message: `${pfx} ⚠ pending-set read-back unavailable (HTTP ${up.status}) — check Manage languages manually`,
            });
          }
          // Default-only TEXT cells: the one knowable divergence of this import
          // shape — the conversion's AI text persists where the source serves a
          // locale by default-language fallback (media lands exactly; text
          // cannot). Listed in the report for review.
          aiTextCells = defaultOnlyTextCells(course).map((c) => `${c.l10nId} ${c.locale}`);
        }
        const blockingReadBackIssues =
          parity.issues.length +
          readBackForeign.length +
          (l10nParity?.issues.length ?? 0);
        onEvent({
          kind: 'log',
          message: blockingReadBackIssues === 0
            ? `Read-back confirmation OK — ${parity.blocks.compared} block(s), course fields/settings, media ownership${l10nParity ? ', and language cells' : ''} match (${parity.expectedDivergences.length} announced exception(s))`
            : `Read-back confirmation FAILED — ${blockingReadBackIssues} blocking divergence(s) (see ${courseId}.report.md)`,
        });
      } else {
        onEvent({ kind: 'log', message: `Parity read-back failed — could not GET_COURSE ${newCourseId}` });
      }

  return { parity, readBackForeign, l10nParity, l10nPending, l10nPendingSet, aiTextCells };
}
