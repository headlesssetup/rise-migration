// Materialize one language of a multi-language stack into a plain course doc:
// every {l10nId} ref is replaced by its value from the per-locale tables.
// Used by the census (scan stacks without l10nId field-noise) and by the future
// split-course path. NEVER mutates its input (source-archive immutability).
//
// Fallback chain (capture-derived, docs/rise-multilang.md §2): a cell may exist
// in ANY subset of locales — resolve locale → defaultLocale → first locale that
// has the cell. Unresolvable refs are reported, not thrown.

import type { GetCourseDocument, L10nValue } from '@/shared/types/rise';
import { defaultLocaleOf } from './stack';

/** Is this value an {l10nId: "<uuid>"} ref object (and nothing else)? */
export function isL10nRef(v: unknown): v is { l10nId: string } {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).l10nId === 'string' &&
    Object.keys(v as object).length === 1
  );
}

export interface MaterializedCourse {
  /** Deep-copied doc with refs resolved and the l10n overlay stripped. */
  doc: GetCourseDocument;
  /** The locale that was materialized. */
  locale: string;
  /** l10nIds that had no value in ANY locale (left in place as refs). */
  unresolved: string[];
}

/**
 * Resolve every {l10nId} ref in `doc` to the given locale's value (default:
 * the stack's default locale). Strips `l10n`, `course.localizationMetadata`
 * and `course.defaultLocaleId` from the copy. A non-stack doc round-trips as a
 * plain deep copy with `locale` = '' and no unresolved entries.
 */
export function materializeLocale(
  doc: GetCourseDocument,
  locale?: string,
): MaterializedCourse {
  const tables = doc?.l10n?.translations ?? {};
  const def = defaultLocaleOf(doc) ?? '';
  const target = locale ?? def;
  const order = [target, def, ...Object.keys(tables)].filter(
    (c, i, a) => c && a.indexOf(c) === i,
  );
  const unresolved = new Set<string>();

  const resolve = (id: string): L10nValue | undefined => {
    for (const code of order) {
      const cell = tables[code]?.[id];
      if (cell !== undefined) return cell;
    }
    unresolved.add(id);
    return undefined;
  };

  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') return node;
    if (isL10nRef(node)) {
      const v = resolve(node.l10nId);
      // Unresolved: keep the ref object verbatim (loud in reports, not lossy).
      return v === undefined ? { l10nId: node.l10nId } : walk(v);
    }
    if (Array.isArray(node)) return node.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = walk(v);
    }
    return out;
  };

  const copy = walk({ ...doc }) as GetCourseDocument;
  delete (copy as Record<string, unknown>).l10n;
  if (copy.course && typeof copy.course === 'object') {
    delete (copy.course as Record<string, unknown>).localizationMetadata;
    delete (copy.course as Record<string, unknown>).defaultLocaleId;
  }
  return { doc: copy, locale: target, unresolved: [...unresolved] };
}

/** The course title as a display string: resolves the ref on a stack, passes a
 *  plain string through, falls back to the course id. */
export function resolveStackTitle(doc: GetCourseDocument | undefined | null): string {
  const t = doc?.course?.title;
  if (typeof t === 'string') return t;
  if (isL10nRef(t) && doc) {
    const tables = doc.l10n?.translations ?? {};
    const def = defaultLocaleOf(doc) ?? '';
    for (const code of [def, ...Object.keys(tables)]) {
      const v = tables[code]?.[t.l10nId];
      if (typeof v === 'string' && v) return v;
    }
  }
  return typeof doc?.course?.id === 'string' ? doc.course.id : '';
}
