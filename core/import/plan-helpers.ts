// Small pure helpers over source blocks/lessons shared by the plan (and the
// executor via './plan') — split out of plan.ts (v0.9.0 restructure; plan.ts
// re-exports the previously-public names, so import sites are unchanged).

import { isL10nRef } from '@/core/l10n';
import type { PlanStep } from './plan-types';
import type { Lesson, Block } from '@/shared/types/rise';

export const STORYLINE = new Set(['360/storyline']);
export const DRAW_FROM_BANK = 'knowledgeCheck/draw from question bank';

export function lessonTitle(l: Lesson): string {
  return typeof l.title === 'string' ? l.title : (l.id ?? 'untitled');
}

/** Order the lesson OBJECTS by the course's authoritative ordered lesson-id list
 *  (`course.lessons` — a list of ids, or objects with `id`). Falls back to the
 *  objects' own array order when no usable id list is present. Any object missing
 *  from the id list is appended (never dropped). */
export function orderLessons(objs: Lesson[], orderField: unknown): Lesson[] {
  const ids = Array.isArray(orderField)
    ? orderField
        .map((x) =>
          typeof x === 'string'
            ? x
            : x && typeof x === 'object'
              ? String((x as { id?: unknown }).id ?? '')
              : '',
        )
        .filter(Boolean)
    : [];
  if (ids.length === 0) return objs;
  const byId = new Map(objs.map((l) => [typeof l.id === 'string' ? l.id : '', l]));
  const seen = new Set<string>();
  const out: Lesson[] = [];
  for (const id of ids) {
    const l = byId.get(id);
    if (l && !seen.has(id)) {
      seen.add(id);
      out.push(l);
    }
  }
  for (const l of objs) {
    const id = typeof l.id === 'string' ? l.id : '';
    if (!seen.has(id)) out.push(l);
  }
  return out;
}

export function fileBasename(key: string): string {
  return key.split('/').pop() || 'asset';
}

/** The uploaded media key of a course cover/card image object
 *  (`{media:{image:{key}}}`), or null if absent / not a course-bank upload. */
export function coverCardImageKey(img: unknown): string | null {
  const k = (img as { media?: { image?: { key?: unknown } } })?.media?.image?.key;
  return typeof k === 'string' && /^rise\/(?:courses|questionBanks)\//.test(k) ? k : null;
}

/** The uploaded media key of the course-level `media` object — the cover-page
 *  LOGO. Capture-confirmed shape is `{image:{key}}` (NO `media` wrapper, unlike
 *  coverImage/cardImage). Null if absent / not a course-bank upload. */
export function courseMediaImageKey(img: unknown): string | null {
  const k = (img as { image?: { key?: unknown } })?.image?.key;
  return typeof k === 'string' && /^rise\/(?:courses|questionBanks)\//.test(k) ? k : null;
}

/** The l10n cell id behind a STACK storyline block's `items[0].media` ref. */
export function storylineCellId(b: Block): string | null {
  const items = Array.isArray(b.items) ? b.items : [];
  const first = items.find((i) => i && typeof i === 'object') as
    | { media?: unknown }
    | undefined;
  const media = first?.media;
  return isL10nRef(media) ? media.l10nId : null;
}

/** Is this block a Storyline / Mighty block (attach from a staged package, else
 *  flagged for manual handling)? */
export function isStoryline(b: Block): boolean {
  return STORYLINE.has(`${b.family}/${b.variant}`) || b.variant === 'storyline';
}

export function isDrawFromBank(b: Block): boolean {
  return `${b.family}/${b.variant}` === DRAW_FROM_BANK;
}

/** Best-effort extraction of the source bank id referenced by a draw-from-bank
 *  block. ⚠️ Field name unconfirmed against an export fixture (protocol §4b);
 *  we probe the documented/likely locations and return null if none found (the
 *  executor loud-fails rather than guessing a bank). */
export function findBankRef(b: Block): {
  bankId: string | null;
  drawCount: number;
  questionDrawType: string;
} {
  const probe = (o: unknown): string | null => {
    if (!o || typeof o !== 'object') return null;
    const r = o as Record<string, unknown>;
    for (const k of ['questionBankId', 'bankId', 'questionBankID', 'bank_id']) {
      if (typeof r[k] === 'string') return r[k] as string;
    }
    return null;
  };
  let bankId = probe(b);
  let drawCount = typeof (b as Record<string, unknown>).drawCount === 'number'
    ? ((b as Record<string, unknown>).drawCount as number)
    : 1;
  let questionDrawType =
    typeof (b as Record<string, unknown>).questionDrawType === 'string'
      ? ((b as Record<string, unknown>).questionDrawType as string)
      : 'random';
  for (const it of (b.items ?? []) as Record<string, unknown>[]) {
    bankId = bankId ?? probe(it);
    if (typeof it.drawCount === 'number') drawCount = it.drawCount;
    if (typeof it.questionDrawType === 'string') {
      questionDrawType = it.questionDrawType;
    }
  }
  return { bankId, drawCount, questionDrawType };
}

/** One block that points at ANOTHER lesson, plus the source lesson ids it names. */
export interface LessonLinkRef {
  sourceLessonId: string;
  sourceBlockId: string;
  /** Source lesson ids this block's `destination` fields name (deduped). */
  destinations: string[];
}

/**
 * Find every block carrying an intra-course lesson link.
 *
 * A `buttons`/`interactive` block can hold sub-items of `type: "lesson"` whose
 * `destination` is a LESSON id — the one cross-ref that is neither a media key
 * nor a blockument, and the one the remap plan used to miss entirely. Sibling
 * `type`s put a URL (`link`) or the literal `exit-course` in the same field, so
 * pairing on `type === 'lesson'` is what separates a real cross-ref from text.
 *
 * Detection is a generic recursive walk (protocol §3: never a per-family
 * switch) and only accepts destinations that name a lesson of THIS course — an
 * external url or a stale id is left alone for the read-back to judge.
 */
export function collectLessonLinks(
  lessons: Lesson[],
  knownLessonIds: ReadonlySet<string>,
  blockIdOf: (block: Block, index: number) => string,
): LessonLinkRef[] {
  const out: LessonLinkRef[] = [];
  for (const lesson of lessons) {
    const sourceLessonId = typeof lesson.id === 'string' ? lesson.id : '';
    if (!sourceLessonId) continue;
    (lesson.items ?? []).forEach((block, i) => {
      const found = new Set<string>();
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (!node || typeof node !== 'object') return;
        const o = node as Record<string, unknown>;
        if (
          o.type === 'lesson' &&
          typeof o.destination === 'string' &&
          knownLessonIds.has(o.destination)
        ) {
          found.add(o.destination);
        }
        for (const v of Object.values(o)) walk(v);
      };
      walk(block);
      if (found.size > 0) {
        out.push({
          sourceLessonId,
          sourceBlockId: blockIdOf(block, i),
          destinations: [...found],
        });
      }
    });
  }
  return out;
}

/**
 * The deferred link-repair steps for one ordered lesson list.
 *
 * Emitted right after the branch's lesson loop — NOT at the end of the plan: a
 * stack converts after that loop, and `patch-lesson-links` is a full-state
 * block write, so running it post-conversion would flatten the l10n refs the
 * conversion just minted.
 */
export function lessonLinkPatchSteps(
  ordered: Lesson[],
  blockIdOf: (block: Block, index: number) => string,
): PlanStep[] {
  const knownLessonIds = new Set(
    ordered.map((l) => (typeof l.id === 'string' ? l.id : '')).filter(Boolean),
  );
  const titleOf = new Map(
    ordered.map((l) => [typeof l.id === 'string' ? l.id : '', lessonTitle(l)]),
  );
  return collectLessonLinks(ordered, knownLessonIds, blockIdOf).map((link) => ({
    kind: 'patch-lesson-links' as const,
    sourceLessonId: link.sourceLessonId,
    sourceBlockId: link.sourceBlockId,
    destinations: link.destinations,
    summary: `Re-link block ${link.sourceBlockId} → ${link.destinations
      .map((d) => `"${titleOf.get(d) ?? d}"`)
      .join(', ')} (lesson ids are only complete now)`,
  }));
}

/**
 * Build the ordered import plan. Pure + deterministic — no ids minted, no
 * network. (Server-assigned ids are resolved at execution time.)
 */
