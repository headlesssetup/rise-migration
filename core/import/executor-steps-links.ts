// Executor step handlers — intra-course lesson links (v0.9.10).
//
// The one cross-ref that is neither a media key nor a blockument: a
// `type: "lesson"` sub-item whose `destination` names ANOTHER lesson of the same
// course. Lessons are created interleaved with their own blocks (plan.ts), so a
// FORWARD link is written while its target lesson does not exist yet and the
// IdMap has nothing to answer with — the SOURCE lesson id then ships verbatim
// and names nothing on the target (live 2026-08-31: the Mercedes CRM
// "Impressum" button in lesson 2 pointing at lesson 27).
//
// This handler re-sends the block ONCE per run, after every lesson exists, so
// the same `remapIds` pass that was a no-op at create time now resolves.
//
// On the `UPDATE_BLOCK_DEBOUNCE` approval rule: the destructive-operations
// invariant governs EDITING an existing course. This is the same
// create-then-attach completion `patch-block-media` already performs — a block
// this run created minutes ago, in a course this run created — so it needs no
// operator confirmation. It must never be reused to patch content we did not
// author in this run.

import { remapBlockumentRefs } from '@/core/mondrian';
import { remapIds, remapMediaKeys, retargetMediaHosts } from './remap';
import * as env from './envelopes';
import type { PlanStep } from './plan';
import { WriteError, blockKey } from './executor-types';
import type { ExecCtx } from './executor-run-state';

/** Every `type: "lesson"` destination in a block, by the value it now carries. */
function lessonDestinations(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((v) => lessonDestinations(v, out));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const o = node as Record<string, unknown>;
  if (o.type === 'lesson' && typeof o.destination === 'string')
    out.push(o.destination);
  for (const v of Object.values(o)) lessonDestinations(v, out);
  return out;
}

export async function handlePatchLessonLinks(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'patch-lesson-links' }>,
): Promise<void> {
  const { deps, ids, log, result, blockMeta, keyMap, pfx, send } = ctx;
  const key = blockKey(step.sourceLessonId, step.sourceBlockId);
  const norm = ctx.normBlocks.get(key);
  const meta = blockMeta.get(key);
  if (!norm || !meta)
    throw new WriteError('link patch before block create', step.kind);

  // Resolve against the NOW-COMPLETE map. Rebuilt exactly like the media patch:
  // UPDATE_BLOCK_DEBOUNCE is a FULL-STATE item write, so every other remap has
  // to be reapplied or the patch reverts them (blockumentIds especially — an
  // unswapped patch reintroduces the dangling source id).
  const { doc: withBlockuments, unmapped } = remapBlockumentRefs(
    remapIds(norm, ids),
    ctx.blockumentMap,
  );
  if (unmapped.length > 0) {
    throw new WriteError(
      `Link patch for block ${step.sourceBlockId} references blockument(s) with no recreated counterpart: ` +
        unmapped.map((u) => u.id).join(', '),
      step.kind,
    );
  }
  const patched = retargetMediaHosts(
    remapMediaKeys(withBlockuments, keyMap),
    deps.targetPlane,
  ) as Record<string, unknown>;
  if (String(patched.id ?? '') !== meta.newId) {
    throw new WriteError(
      `link-patch payload id ${String(patched.id ?? '(none)')} != created block id ${meta.newId} — id-mint drift (code fault)`,
      step.kind,
    );
  }

  // Loud, per the cross-ref invariant: a destination that STILL does not name a
  // target lesson is never shipped as "probably fine". It is written (the value
  // is inert either way) and flagged for manual re-linking, naming the lesson
  // the operator has to pick.
  // A source LESSON id only enters the map when CREATE_LESSON records it
  // (`ids.set`) — server-shaped ids are never minted by `registerClientIds` —
  // so "mapped" is exactly "the target lesson exists".
  const unresolved = step.destinations.filter((d) => !ids.get(d));
  for (const d of unresolved) {
    result.flags.push({
      kind: 'lesson-link',
      sourceBlockId: step.sourceBlockId,
      sourceLessonId: step.sourceLessonId,
      detail: `Button links to source lesson ${d}, which has no target counterpart — re-link it manually`,
    });
    log(
      `${pfx()} ⚠ FLAG lesson-link — ${step.sourceBlockId} → ${d} (unresolved)`,
    );
  }

  const newLessonId = ids.get(step.sourceLessonId);
  if (!newLessonId)
    throw new WriteError('link patch before lesson create', step.kind);
  await send(
    env.updateBlockDebounce({
      id: meta.newId,
      courseId: ctx.newCourseId,
      lessonId: newLessonId,
      item: patched,
    }),
    step.kind,
  );
  const now = lessonDestinations(patched).join(', ');
  log(`${pfx()} OK   re-linked block ${meta.newId} → ${now}`);
}
