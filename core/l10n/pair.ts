// Structural l10n-ref pairing for the full-course-first stack import (idea 2,
// docs/rise-multilang.md §6, v0.6.7).
//
// Under idea 2 the target course is built in the DEFAULT language from the
// materialized source, then converted ONCE — so every l10n ref on the target
// is minted by the TARGET's own conversion and no source l10nId exists there.
// This module pairs source refs to target refs by STRUCTURE:
//   - course fields by key path (title/description/media/cover/card/header…),
//   - lessons by the id map the executor recorded at create time,
//   - blocks by the fresh client ids the executor minted (they survive the
//     conversion in place), then a parallel walk INSIDE each block object.
//
// Divergences are returned, never guessed away:
//   - `unmatched`   — source ref with no target ref at the same path (the
//     target's Rise version does not localize that field): its cells cannot be
//     written; flagged loudly by the executor.
//   - `targetOnlyEmpty` — target ref over a DEEP-EMPTY source slot (the
//     conversion l10n-ifies even empty fields — e.g. the no-logo course.media):
//     EXPECTED; read-back parity tolerates its cells (the F3 rule).
//   - `targetOnly`  — target ref over a NON-empty plain source value (version
//     skew: today's Rise localizes a field the source's did not). Surfaced for
//     review; its cells hold the conversion's AI text.

import type { GetCourseDocument, Lesson, Block } from '@/shared/types/rise';
import { isL10nRef } from './materialize';
// Shared source-block addressing (positional fallback for missing ids) — must
// match the executor's blockMeta keys or id-less blocks never pair.
import { sourceBlockIdOf } from '@/core/import/executor-types';

export interface PairRef {
  path: string;
  l10nId: string;
}

export interface PairResult {
  /** source l10nId → target l10nId */
  map: Map<string, string>;
  unmatched: PairRef[];
  targetOnlyEmpty: PairRef[];
  targetOnly: PairRef[];
}

function isDeepEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.every(isDeepEmpty);
  if (typeof v === 'object') return Object.values(v as object).every(isDeepEmpty);
  return false;
}

export function pairL10nRefs(
  source: GetCourseDocument,
  target: GetCourseDocument,
  opts: {
    /** Source lesson id → target lesson id (the executor's id map). */
    lessonId: (srcLessonId: string) => string | undefined;
    /** Source lesson+block → the block id minted at create time. */
    blockId: (srcLessonId: string, srcBlockId: string) => string | undefined;
  },
): PairResult {
  const map = new Map<string, string>();
  const unmatched: PairRef[] = [];
  const targetOnlyEmpty: PairRef[] = [];
  const targetOnly: PairRef[] = [];

  // Every source ref inside a subtree with NO target counterpart is unmatched
  // (silence here would violate loud failure).
  const collectSource = (node: unknown, p: string): void => {
    if (isL10nRef(node)) {
      unmatched.push({ path: p, l10nId: node.l10nId });
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => collectSource(v, `${p}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectSource(v, `${p}.${k}`);
    }
  };

  const walk = (s: unknown, t: unknown, path: string): void => {
    if (isL10nRef(s)) {
      if (isL10nRef(t)) map.set(s.l10nId, t.l10nId);
      else unmatched.push({ path, l10nId: s.l10nId });
      return;
    }
    if (isL10nRef(t)) {
      // Target localized a field the source did not hold as a ref.
      (isDeepEmpty(s) ? targetOnlyEmpty : targetOnly).push({ path, l10nId: t.l10nId });
      return;
    }
    if (s === null || typeof s !== 'object') return;
    if (Array.isArray(s)) {
      const ta = Array.isArray(t) ? t : [];
      s.forEach((v, i) => {
        if (i < ta.length) walk(v, ta[i], `${path}[${i}]`);
        else collectSource(v, `${path}[${i}]`);
      });
      return;
    }
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      collectSource(s, path);
      return;
    }
    const keys = new Set([
      ...Object.keys(s as Record<string, unknown>),
      ...Object.keys(t as Record<string, unknown>),
    ]);
    for (const k of keys) {
      walk(
        (s as Record<string, unknown>)[k],
        (t as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
    }
  };

  // 1. Course fields.
  walk(source.course ?? {}, target.course ?? {}, 'course');

  // 2 + 3. Lessons (matched via the executor id map) and their blocks (matched
  // via the minted block ids — never by position: Rise's samples reuse "1","2",
  // "3" per lesson, and positional matching is exactly the v0.6.3 trap).
  const tgtLessons = new Map<string, Lesson>();
  for (const l of target.lessons ?? []) {
    if (typeof l.id === 'string') tgtLessons.set(l.id, l);
  }
  (source.lessons ?? []).forEach((sl) => {
    const srcLessonId = typeof sl.id === 'string' ? sl.id : '';
    const tgtId = srcLessonId ? opts.lessonId(srcLessonId) : undefined;
    const tl = tgtId ? tgtLessons.get(tgtId) : undefined;
    const lPath = `lessons[${srcLessonId}]`;
    if (!tl) {
      collectSource(sl, lPath);
      return;
    }
    // Lesson fields minus items (blocks pair by id below).
    const { items: sItems, ...sRest } = sl as Lesson & { items?: unknown };
    const { items: _tItems, ...tRest } = tl as Lesson & { items?: unknown };
    walk(sRest, tRest, lPath);

    const tgtBlocks = new Map<string, Block>();
    for (const b of (tl.items ?? []) as Block[]) {
      if (typeof b.id === 'string') tgtBlocks.set(b.id, b);
    }
    ((sItems ?? []) as Block[]).forEach((sb, sbIdx) => {
      const srcBlockId = sourceBlockIdOf(sb, sbIdx);
      const newId = opts.blockId(srcLessonId, srcBlockId);
      const tb = newId ? tgtBlocks.get(newId) : undefined;
      const bPath = `${lPath}.block[${srcBlockId}]`;
      if (!tb) {
        collectSource(sb, bPath);
        return;
      }
      walk(sb, tb, bPath);
    });
  });

  return { map, unmatched, targetOnlyEmpty, targetOnly };
}
