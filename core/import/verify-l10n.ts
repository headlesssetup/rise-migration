// Multi-language STACK read-back parity (docs/rise-multilang.md) — split out
// of verify.ts (v0.9.0 restructure; the ORIGINAL path re-exports this surface,
// so `@/core/import` and `./verify` imports are unchanged).

import type { GetCourseDocument } from '@/shared/types/rise';
import { canonicalize, orderedLessons } from './verify';

// --- Multi-language stack parity (docs/rise-multilang.md) --------------------

export type L10nParityKind =
  | 'missing-locale'
  | 'extra-locale'
  | 'missing-cell'
  | 'cell-changed'
  | 'extra-cell'
  | 'placeholder-cell'
  | 'labelset-binding';

export interface L10nParityIssue {
  kind: L10nParityKind;
  locale?: string;
  l10nId?: string;
  detail?: string;
}

export interface L10nParityReport {
  /** Divergences that were announced by the plan (flagged storyline cells the
   *  import deliberately does not copy) — reported, but they never fail the
   *  course. Mirrors ParityReport.expectedDivergences. */
  expected?: L10nParityIssue[];
  /** Target rows in locales where the SOURCE holds no row (`placeholder-cell`,
   *  kept for report-shape stability). Under the full-course-first import
   *  (idea 2) these are the conversion's AI translations of REAL content: a
   *  locale the source serves by default-language fallback has no proofread
   *  row to overwrite the AI text with, so it persists — EXPECTED and
   *  status-neutral. The text subset is predicted per course
   *  (`defaultOnlyTextCells`) and listed in the report as aiTextCells. */
  placeholderJunk?: L10nParityIssue[];
  ok: boolean;
  locales: { source: string[]; target: string[] };
  cells: { source: number; target: number; compared: number };
  issues: L10nParityIssue[];
}

/**
 * Read-back parity for a stack's translation tables: every source cell must
 * exist on the target (per locale) and match modulo the same canonicalization
 * parity uses elsewhere (media keys → #media tokens, ids tokenized, whitespace
 * collapsed). Course-level ids are aligned via a structural ref map (the
 * target's title/description/cover refs are its own — created by the
 * conversion); lesson/block cells keep the source ids verbatim, and lesson
 * TITLE refs are additionally aligned by lesson index (lesson 1 reuses the
 * pre-conversion placeholder's ref). Self-contained: derives the maps from the
 * two docs it is given.
 */
export function verifyL10nParity(
  source: GetCourseDocument,
  target: GetCourseDocument,
  opts: {
    /** `cellKey(l10nId, locale)` entries whose ABSENCE **or DIVERGENCE** on
     *  the target is expected — the flagged storyline cells the planner
     *  deliberately does not copy (docs/rise-multilang.md §4.3b). Divergence
     *  is tolerated too (G1, findings 2026-08-05): under idea 2 the conversion
     *  MINTS a cell for the flagged slot from the blanked block we shipped, so
     *  the cell EXISTS with `contentPrefix:""` — present-but-blanked is the
     *  expected state of an unattached storyline slot, and the announced
     *  `l10n-storyline` manual flag already tells the operator what to do.
     *  Without this, a stack whose storyline could not be staged (the Localize
     *  gate) could never read back `imported`. */
    toleratedMissing?: Set<string>;
    /** IDEA-2 imports: the executor's pairing map (source l10nId → target
     *  l10nId, ALL refs — course fields, lesson titles, block-internal). When
     *  provided it is authoritative: no source id exists on the target, so the
     *  structural self-derivation below cannot map block-level cells. */
    idMap?: ReadonlyMap<string, string>;
    /** Target-only ref ids whose cells are EXPECTED (conversion artifacts over
     *  deep-empty source slots, recorded by the executor's pairing). Unioned
     *  with this function's own course-field detection (F3). */
    toleratedExtra?: ReadonlySet<string>;
  } = {},
): L10nParityReport {
  const srcTables = source.l10n?.translations ?? {};
  const tgtTables = target.l10n?.translations ?? {};
  const srcLocales = Object.keys(srcTables);
  const tgtLocales = Object.keys(tgtTables);
  const issues: L10nParityIssue[] = [];
  const expected: L10nParityIssue[] = [];

  for (const code of srcLocales) {
    if (!tgtLocales.includes(code)) issues.push({ kind: 'missing-locale', locale: code });
  }
  for (const code of tgtLocales) {
    if (!srcLocales.includes(code)) issues.push({ kind: 'extra-locale', locale: code });
  }

  // source l10nId → target l10nId. Course-level refs map structurally; lesson
  // title refs map by lesson index; everything else maps to itself.
  const idMap = new Map<string, string>();
  // Target-only refs whose SOURCE slot is deep-empty (F3): the conversion mints
  // a ref+cell even for an EMPTY slot (e.g. `course.media` with no logo), so a
  // source-driven map can never cover it — the 0.6.6 dangling-ref guard rightly
  // KEEPS the cell, and its presence is EXPECTED, not a divergence (the l10n
  // analog of the random-default-cover rule).
  const emptySlotTargetRefs = new Set<string>();
  const isDeepEmpty = (v: unknown): boolean => {
    if (v === undefined || v === null || v === '') return true;
    if (Array.isArray(v)) return v.every(isDeepEmpty);
    if (typeof v === 'object') return Object.values(v as object).every(isDeepEmpty);
    return false;
  };
  const soleRefId = (v: unknown): string | null => {
    if (
      v && typeof v === 'object' && !Array.isArray(v) &&
      Object.keys(v as object).length === 1 &&
      typeof (v as Record<string, unknown>).l10nId === 'string'
    ) {
      return (v as Record<string, unknown>).l10nId as string;
    }
    return null;
  };
  const mapRefs = (s: unknown, t: unknown): void => {
    const tr0 = soleRefId(t);
    if (tr0 && isDeepEmpty(s)) {
      emptySlotTargetRefs.add(tr0);
      return;
    }
    if (
      s && t &&
      typeof s === 'object' && typeof t === 'object' &&
      !Array.isArray(s) && !Array.isArray(t)
    ) {
      const sr = soleRefId(s);
      const tr = soleRefId(t);
      if (sr && tr) {
        idMap.set(sr, tr);
        return;
      }
      for (const k of new Set([
        ...Object.keys(s as Record<string, unknown>),
        ...Object.keys(t as Record<string, unknown>),
      ])) {
        mapRefs(
          (s as Record<string, unknown>)[k],
          (t as Record<string, unknown>)[k],
        );
      }
    }
  };
  if (opts.idMap) {
    // Idea-2 import: the executor's pairing is authoritative (block-level refs
    // are unreachable to the structural derivation — no source id survives on
    // the target). The own course-field walk still runs for the F3 empty-slot
    // detection; the caller's toleratedExtra unions in the block-level ones.
    for (const [s, t] of opts.idMap) idMap.set(s, t);
    mapRefs(source.course ?? {}, target.course ?? {});
  } else {
    mapRefs(source.course ?? {}, target.course ?? {});
    const srcLessons = orderedLessons(source);
    const tgtLessons = orderedLessons(target);
    srcLessons.forEach((sl, i) => {
      const tl = tgtLessons[i];
      if (sl && tl) mapRefs({ t: sl.title }, { t: tl.title });
    });
  }
  for (const id of opts.toleratedExtra ?? []) emptySlotTargetRefs.add(id);

  const mappedTargets = new Set(idMap.values());
  let sourceCells = 0;
  let targetCells = 0;
  let compared = 0;

  for (const [code, table] of Object.entries(srcTables)) {
    const tgtTable = tgtTables[code] ?? {};
    for (const [id, value] of Object.entries(table)) {
      sourceCells++;
      const tgtId = idMap.get(id) ?? id;
      const tgtValue = tgtTable[tgtId];
      if (tgtValue === undefined) {
        (opts.toleratedMissing?.has(`${id} ${code}`) ? expected : issues).push({
          kind: 'missing-cell',
          locale: code,
          l10nId: id,
        });
        continue;
      }
      compared++;
      const a = JSON.stringify(canonicalize(value));
      const b = JSON.stringify(canonicalize(tgtValue));
      if (a !== b) {
        // A tolerated (flagged-storyline) cell that EXISTS diverges by design:
        // the conversion minted it from the blanked block, so it holds
        // `contentPrefix:""` until the operator attaches the package (G1).
        (opts.toleratedMissing?.has(`${id} ${code}`) ? expected : issues).push({
          kind: 'cell-changed',
          locale: code,
          l10nId: id,
          detail: `source ${a.slice(0, 120)} ≠ target ${b.slice(0, 120)}`,
        });
      }
    }
  }

  // Target-only cells: ids that came neither from the source verbatim nor via
  // the ref map — placeholder-era leftovers the cleanup should have removed.
  const srcIds = new Set<string>();
  for (const table of Object.values(srcTables)) {
    for (const id of Object.keys(table)) srcIds.add(id);
  }
  // Inverse of idMap, to trace a mapped target id back to its source id.
  const srcIdByTarget = new Map<string, string>();
  for (const [s, t] of idMap) srcIdByTarget.set(t, s);
  const placeholderJunk: L10nParityIssue[] = [];
  for (const [code, table] of Object.entries(tgtTables)) {
    for (const [id, tgtValue] of Object.entries(table)) {
      targetCells++;
      if (!srcIds.has(id) && !mappedTargets.has(id)) {
        // F3: a target-only ref over a DEEP-EMPTY source slot is a conversion
        // artifact (it l10n-ifies even empty course fields) — expected, and its
        // cell content is irrelevant (the slot renders empty either way).
        (emptySlotTargetRefs.has(id) ? expected : issues).push({
          kind: 'extra-cell',
          locale: code,
          l10nId: id,
          ...(emptySlotTargetRefs.has(id)
            ? { detail: 'target-only ref over an empty source slot (conversion artifact)' }
            : {}),
        });
        continue;
      }
      // A known id, but in a locale the SOURCE has no row for: the
      // conversion's AI translation of real content (idea 2) — the source
      // renders that locale via default-locale fallback. Expected +
      // status-neutral; surfaced separately (see the report field's doc).
      const srcId = srcIdByTarget.get(id) ?? (srcIds.has(id) ? id : undefined);
      if (srcId !== undefined && srcTables[code]?.[srcId] === undefined) {
        placeholderJunk.push({
          kind: 'placeholder-cell',
          locale: code,
          l10nId: id,
          detail: `target holds ${JSON.stringify(tgtValue).slice(0, 80)}; source falls back to its default language here`,
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    locales: { source: srcLocales, target: tgtLocales },
    cells: { source: sourceCells, target: targetCells, compared },
    issues,
    ...(expected.length ? { expected } : {}),
    ...(placeholderJunk.length ? { placeholderJunk } : {}),
  };
}

export function l10nParityToMarkdown(r: L10nParityReport): string {
  const lines: string[] = [];
  lines.push(`## Language parity${r.ok ? ' — OK' : ' — DIVERGENCES'}`);
  if (r.expected?.length) {
    lines.push(
      `- ${r.expected.length} expected divergence(s)/absence(s) (flagged storyline cells — not copied by design; ` +
        'an unattached slot holds a blanked package reference until the operator attaches it)',
    );
  }
  if (r.placeholderJunk?.length) {
    lines.push(
      `- ${r.placeholderJunk.length} cell(s) hold the conversion's AI translation in languages the source ` +
        'serves by default-language fallback — expected under the full-course-first import (there is no ' +
        'proofread source row to overwrite the AI text with; media is unaffected). Review each in the editor ' +
        'if AI text is unacceptable there:',
    );
    for (const x of r.placeholderJunk.slice(0, 15)) {
      lines.push(`  - [${x.locale}] ${x.l10nId}${x.detail ? ` — ${x.detail}` : ''}`);
    }
  }
  lines.push(
    `- Languages: ${r.locales.source.join(', ') || '—'} (source) / ${r.locales.target.join(', ') || '—'} (target)`,
  );
  lines.push(
    `- Translation cells: ${r.cells.source} source / ${r.cells.target} target (${r.cells.compared} compared)`,
  );
  if (r.issues.length) {
    lines.push(`- **Divergences: ${r.issues.length}**`);
    for (const x of r.issues.slice(0, 25)) {
      lines.push(
        `  - [${x.kind}] ${x.locale ?? ''} ${x.l10nId ?? ''}${x.detail ? ` — ${x.detail}` : ''}`,
      );
    }
  } else {
    lines.push('- Divergences: 0 ✓');
  }
  return lines.join('\n');
}
