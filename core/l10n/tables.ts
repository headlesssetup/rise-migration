// Translation-table machinery for stack import (docs/rise-multilang.md §4):
// collect cells from a source archive, build the `translationChanges` arrays
// that ride CREATE_LESSON/CREATE_BLOCKS, and batch the remaining cells into
// UPDATE_L10N_BATCH envelopes. Pure functions; the executor supplies remapping
// (media keys) and pacing.
//
// WRITE-ORDER INVARIANT (capture-derived): the default locale's value must be
// written BEFORE the other locales' values for the same cell, or Rise flags the
// cell "new content, untranslated" per target locale (pending = default row
// newer than target row, or target row missing).

import type { GetCourseDocument, L10nValue } from '@/shared/types/rise';
import { defaultLocaleOf, stackLocales } from './stack';
import { isL10nRef } from './materialize';

/** One (l10nId, locale) → value cell of the source tables. */
export interface L10nCell {
  l10nId: string;
  locale: string;
  value: L10nValue;
}

/**
 * True if a cell value is a STORYLINE object (`{storyline:{contentPrefix, src,
 * meta…}}`, capture2aug §4.3b). These must NEVER be copied verbatim: their
 * `contentPrefix`/`src` point at the SOURCE course's S3 prefix, storyline keys
 * are exempt from the foreign-media-key invariant (`media-storyline`), and the
 * package is re-created through Review 360, not re-uploaded as an asset. The
 * stack planner excludes them from the generic cell writes and flags them for
 * a manual per-language attach (per-language attach automation: v0.6.1).
 */
export function isStorylineCell(value: L10nValue): boolean {
  return !!value && typeof value === 'object' && 'storyline' in value;
}

/** One change of an UPDATE_L10N_BATCH / translationChanges payload. */
export interface L10nChange {
  action: 'add' | 'update' | 'delete';
  l10nId: string;
  locale?: string;
  value?: L10nValue;
  /** 'plain' | 'rich' | 'mediaRecord' — required on `add` (capture-observed). */
  valueType?: string;
  /** The owning lesson, sent on `add` for lesson-scoped cells (capture-observed). */
  lessonId?: string;
}

/** Capture-observed value types: bare strings are 'plain', HTML is 'rich',
 *  Storyline objects are 'storyline' (capture2aug §4.3b), other media objects
 *  are 'mediaRecord'. */
export function valueTypeOf(value: L10nValue): 'plain' | 'rich' | 'mediaRecord' | 'storyline' {
  if (typeof value === 'string') {
    return /<[a-z!/]/i.test(value) ? 'rich' : 'plain';
  }
  if (isStorylineCell(value)) return 'storyline';
  return 'mediaRecord';
}

/** Storyline cells of the source tables, grouped for flagging: one entry per
 *  (l10nId, locale) that holds a storyline package reference. */
export function storylineCells(doc: GetCourseDocument): L10nCell[] {
  return collectCells(doc).filter((c) => isStorylineCell(c.value));
}

/**
 * All source cells, ordered default locale first (write-order invariant),
 * then the other locales in stack order. Values verbatim.
 */
export function collectCells(doc: GetCourseDocument): L10nCell[] {
  const tables = doc.l10n?.translations ?? {};
  const def = defaultLocaleOf(doc) ?? '';
  const order = [
    ...(def && tables[def] ? [def] : []),
    ...stackLocales(doc)
      .map((l) => String(l.locale ?? ''))
      .filter((c) => c && c !== def && tables[c]),
    // tables for locales missing a locale row (defensive): still copy them
    ...Object.keys(tables).filter(
      (c) => c !== def && !stackLocales(doc).some((l) => l.locale === c),
    ),
  ];
  const cells: L10nCell[] = [];
  for (const locale of order) {
    for (const [l10nId, value] of Object.entries(tables[locale] ?? {})) {
      cells.push({ l10nId, locale, value });
    }
  }
  return cells;
}

/** Map l10nId → owning lesson id, from the refs found inside each lesson's
 *  subtree (title, description, blocks — a generic walk). */
export function lessonIdByRef(doc: GetCourseDocument): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (node: unknown, lessonId: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (isL10nRef(node)) {
      map.set(node.l10nId, lessonId);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child, lessonId);
      return;
    }
    for (const v of Object.values(node as Record<string, unknown>)) walk(v, lessonId);
  };
  for (const lesson of doc.lessons ?? []) {
    const id = typeof lesson.id === 'string' ? lesson.id : '';
    if (id) walk(lesson, id);
  }
  return map;
}

/**
 * Course-level ref map: walk source and target `course` objects in parallel;
 * wherever BOTH have an {l10nId} ref at the same path, map source id → target
 * id (course title/description/logo/cover/card/lessonHeader — created on the
 * target by the conversion itself). Source refs with no target counterpart are
 * returned in `unmatched` for loud flagging.
 */
export function courseRefMap(
  source: GetCourseDocument,
  target: GetCourseDocument,
): { map: Map<string, string>; unmatched: { path: string; l10nId: string }[] } {
  const map = new Map<string, string>();
  const unmatched: { path: string; l10nId: string }[] = [];
  const walk = (s: unknown, t: unknown, path: string): void => {
    if (isL10nRef(s)) {
      if (isL10nRef(t)) map.set(s.l10nId, t.l10nId);
      else unmatched.push({ path, l10nId: s.l10nId });
      return;
    }
    if (s === null || typeof s !== 'object' || Array.isArray(s)) return;
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      // Source object subtree absent on target: any refs inside are unmatched.
      const collect = (node: unknown, p: string): void => {
        if (isL10nRef(node)) {
          unmatched.push({ path: p, l10nId: node.l10nId });
          return;
        }
        if (node && typeof node === 'object' && !Array.isArray(node)) {
          for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            collect(v, `${p}.${k}`);
          }
        }
      };
      collect(s, path);
      return;
    }
    for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
      walk(v, (t as Record<string, unknown>)[k], `${path}.${k}`);
    }
  };
  walk(source.course ?? {}, target.course ?? {}, 'course');
  return { map, unmatched };
}

/**
 * The `translationChanges` array to inline on a CREATE_LESSON / CREATE_BLOCKS
 * envelope: DEFAULT-locale values for every ref found in `subtree` (the lesson
 * title or the blocks being created). Cells the source only holds in other
 * locales are skipped here — they ride the per-locale batches (write-order
 * invariant keeps them non-pending since no newer default row exists).
 */
export function inlineTranslationChanges(
  subtree: unknown,
  doc: GetCourseDocument,
  lessonId?: string,
): L10nChange[] {
  const tables = doc.l10n?.translations ?? {};
  const def = defaultLocaleOf(doc) ?? '';
  const defTable = tables[def] ?? {};
  const changes: L10nChange[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (isL10nRef(node)) {
      if (seen.has(node.l10nId)) return;
      seen.add(node.l10nId);
      const value = defTable[node.l10nId];
      // Storyline cells are never copied verbatim (see isStorylineCell) — not
      // inline at create time either; the planner flags them instead.
      if (value !== undefined && !isStorylineCell(value)) {
        changes.push({
          action: 'add',
          l10nId: node.l10nId,
          ...(lessonId ? { lessonId } : {}),
          locale: def,
          value,
          valueType: valueTypeOf(value),
        });
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    for (const v of Object.values(node as Record<string, unknown>)) walk(v);
  };
  walk(subtree);
  return changes;
}

export interface CellWriteOptions {
  /** source l10nId → target l10nId (course-level refs); ids not in the map keep
   *  their source id (lesson/block cells — we created those refs ourselves). */
  idMap?: Map<string, string>;
  /** Remap media keys inside a value (executor wires core/import/remap). */
  remapValue?: (value: L10nValue) => L10nValue;
  /** l10nId → lessonId (sent on `add`; from lessonIdByRef of the SOURCE doc). */
  lessonIds?: Map<string, string>;
  /** Cells already shipped inline at create time: (l10nId, locale) pairs to skip. */
  skip?: Set<string>;
  /** Changes per UPDATE_L10N_BATCH envelope. */
  batchSize?: number;
}

export const CELL_BATCH_SIZE = 20;

/** Key for the `skip` set. */
export function cellKey(l10nId: string, locale: string): string {
  return `${l10nId} ${locale}`;
}

/**
 * Batch the source cells into UPDATE_L10N_BATCH change lists. Preserves the
 * collectCells ordering (default locale first) and never mixes locales within
 * one envelope (captured envelopes are single-locale).
 */
export function planCellWrites(
  cells: L10nCell[],
  opts: CellWriteOptions = {},
): L10nChange[][] {
  const size = opts.batchSize ?? CELL_BATCH_SIZE;
  const batches: L10nChange[][] = [];
  let current: L10nChange[] = [];
  let currentLocale: string | null = null;
  for (const cell of cells) {
    if (opts.skip?.has(cellKey(cell.l10nId, cell.locale))) continue;
    const id = opts.idMap?.get(cell.l10nId) ?? cell.l10nId;
    const value = opts.remapValue ? opts.remapValue(cell.value) : cell.value;
    const lessonId = opts.lessonIds?.get(cell.l10nId);
    const change: L10nChange = {
      action: 'add',
      l10nId: id,
      ...(lessonId ? { lessonId } : {}),
      locale: cell.locale,
      value,
      valueType: valueTypeOf(value),
    };
    if (currentLocale !== cell.locale || current.length >= size) {
      if (current.length) batches.push(current);
      current = [];
      currentLocale = cell.locale;
    }
    current.push(change);
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Cells the source holds ONLY in the default locale, per target locale.
 *
 * These are fallback cells (mostly media records, plus non-translatable text
 * like quiz choices, numbers, urls): the source renders them in every language
 * from the default row, and there is no target-locale row to copy. After an
 * import Rise counts each one as a "source change" for that language — the
 * "N source changes detected / translations are out of sync" badge — because on
 * the target those cells were authored AFTER the conversion, so Rise has never
 * stamped them as translated. The CONTENT is identical to the source; only the
 * sync marker differs, and it cannot be set through the API (the only writer is
 * an AI translation run, which is exactly what a migration must not do).
 *
 * We therefore PREDICT the number from the archive so the operator can match it
 * against what Rise shows: equal ⇒ benign and expected; different ⇒ a real
 * signal worth investigating.
 */
export function defaultOnlyCells(doc: GetCourseDocument): Record<
  string,
  { total: number; media: number; text: number }
> {
  const tables = doc.l10n?.translations ?? {};
  const def = defaultLocaleOf(doc) ?? '';
  const defTable = tables[def] ?? {};
  const out: Record<string, { total: number; media: number; text: number }> = {};
  for (const [locale, table] of Object.entries(tables)) {
    if (locale === def) continue;
    let media = 0;
    let text = 0;
    for (const [id, value] of Object.entries(defTable)) {
      if (table[id] !== undefined) continue;
      if (typeof value === 'string') text++;
      else media++;
    }
    out[locale] = { total: media + text, media, text };
  }
  return out;
}

/**
 * Target-side cells to DELETE after the import: l10nIds present in the target
 * tables that are neither source ids nor mapped target ids (`keep`). These are
 * the placeholder-era cells the AI conversion created. `delete` removes the id
 * across ALL locales — restricted to provably-ours ids by construction.
 */
export function junkCellIds(
  sourceDoc: GetCourseDocument,
  targetDoc: GetCourseDocument,
  keep: Iterable<string>,
): string[] {
  const sourceIds = new Set<string>();
  for (const table of Object.values(sourceDoc.l10n?.translations ?? {})) {
    for (const id of Object.keys(table)) sourceIds.add(id);
  }
  const keepSet = new Set(keep);
  const junk = new Set<string>();
  for (const table of Object.values(targetDoc.l10n?.translations ?? {})) {
    for (const id of Object.keys(table)) {
      if (!sourceIds.has(id) && !keepSet.has(id)) junk.add(id);
    }
  }
  return [...junk];
}
