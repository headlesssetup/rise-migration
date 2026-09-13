// Intra-course lesson links (v0.9.10) — the forward-reference repair, the
// plane-specific media host retarget, and the read-back assertion that keeps
// both honest. Regression source: the Mercedes CRM import, 2026-08-31.

import { describe, it, expect } from 'vitest';
import { buildPlan, type PlanInput } from './plan';
import { executePlan, type Relay } from './executor';
import { IdMap } from './ids';
import { retargetMediaHosts } from './remap';
import { verifyParity } from './verify';
import { counterMint, mockRelay, happyHandlers } from './executor.fixtures';
import type { GetCourseDocument } from '@/shared/types/rise';

// --- Fixture: lesson 1 links FORWARD to lesson 3 -----------------------------

function linkCourse(): PlanInput {
  const button = (dest: string) => ({
    id: 'cbtn0000000000000000000000',
    family: 'buttons',
    variant: 'button',
    type: 'interactive',
    items: [
      {
        id: 'cbti0000000000000000000000',
        type: 'lesson',
        label: 'Impressum',
        destination: dest,
      },
    ],
  });
  return {
    author: 'auth0|t',
    targetFolderId: 'all',
    assets: [],
    banksById: new Map(),
    course: {
      course: { id: 'SRC', title: 'C', lessons: ['LFIRST', 'LMID', 'LLAST'] },
      lessons: [
        // Deliberately NOT in display order — the archive stores lessons sorted
        // by id, exactly as the Mercedes capture did.
        {
          id: 'LLAST',
          position: 2,
          type: 'blocks',
          title: 'Impressum',
          items: [],
        },
        { id: 'LMID', position: 1, type: 'blocks', title: 'Middle', items: [] },
        {
          id: 'LFIRST',
          position: 0,
          type: 'blocks',
          title: 'Intro',
          items: [button('LLAST')],
        },
      ],
    } as unknown as GetCourseDocument,
  };
}

function relayFor(sentBlocks: Record<string, unknown>[]): { relay: Relay } {
  let lessonN = 0;
  const { relay } = mockRelay({
    ...happyHandlers,
    CREATE_LESSON: () => ({
      payload: { lesson: { id: `TGTLESSON${++lessonN}`, createdAt: 't' } },
    }),
    CREATE_BLOCKS: (body: unknown) => {
      const p = (body as { payload: { blocks: Record<string, unknown>[] } })
        .payload;
      sentBlocks.push(...p.blocks);
      return {
        payload: {
          success: true,
          blockMetadata: p.blocks.map((b, i) => ({
            id: b.id,
            globalBlockId: `g${i}`,
          })),
        },
      };
    },
    UPDATE_BLOCK_DEBOUNCE: (body: unknown) => {
      sentBlocks.push(
        (body as { payload: { item: Record<string, unknown> } }).payload.item,
      );
      return { payload: { success: true } };
    },
  });
  return { relay };
}

const destOf = (b: Record<string, unknown>): string =>
  String((b.items as Record<string, unknown>[])?.[0]?.destination ?? '');

describe('forward lesson links', () => {
  it('plans a deferred patch, emitted AFTER every create-lesson', () => {
    const steps = buildPlan(linkCourse());
    const patchAt = steps.findIndex((s) => s.kind === 'patch-lesson-links');
    const lastLessonAt = steps.map((s) => s.kind).lastIndexOf('create-lesson');
    expect(patchAt).toBeGreaterThan(-1);
    expect(patchAt).toBeGreaterThan(lastLessonAt);
    const step = steps[patchAt] as Extract<
      (typeof steps)[number],
      { kind: 'patch-lesson-links' }
    >;
    expect(step.sourceLessonId).toBe('LFIRST');
    expect(step.destinations).toEqual(['LLAST']);
    // The operator-facing summary names the lesson, not just an id.
    expect(step.summary).toContain('"Impressum"');
  });

  it('ships the SOURCE id at create time, then repairs it to the target lesson', async () => {
    const input = linkCourse();
    const sent: Record<string, unknown>[] = [];
    const res = await executePlan(buildPlan(input), {
      input,
      relay: relayFor(sent).relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.error).toBeUndefined();
    const linkWrites = sent.filter((b) => destOf(b));
    // Two writes for the one block: the create (unresolvable) and the patch.
    expect(linkWrites).toHaveLength(2);
    expect(destOf(linkWrites[0]!)).toBe('LLAST'); // forward ref — nothing to map to yet
    expect(destOf(linkWrites[1]!)).toBe('TGTLESSON3'); // repaired: "Impressum" on the target
    // No source lesson id survives on the final state of the block.
    expect(destOf(linkWrites[1]!)).not.toBe('LLAST');
    expect(res.flags.filter((f) => f.kind === 'lesson-link')).toEqual([]);
  });

  it('never plans a patch for a destination that is not a lesson of this course', () => {
    const input = linkCourse();
    // Point the button at a lesson that is not part of the course.
    const l = (
      input.course as unknown as { lessons: Record<string, unknown>[] }
    ).lessons[2]!;
    (
      (l.items as Record<string, unknown>[])[0]!.items as Record<
        string,
        unknown
      >[]
    )[0]!.destination = 'GHOSTLESSON';
    const steps = buildPlan(input);
    // Not a lesson of this course → never even planned as a link.
    expect(steps.some((s) => s.kind === 'patch-lesson-links')).toBe(false);
  });
});

describe('retargetMediaHosts — plane-specific media hosts', () => {
  const media = {
    video: {
      key: 'rise/courses/TGT/NEWVID.mp4',
      poster:
        'https://images.articulate.com/f:png,w:1920,s:cover,q:65/rise/courses/TGT/NEWFRAME.jpg',
      thumbnail:
        'https://images.articulate.com/f:jpg,b:fff,w:100,h:100,s:cover/rise/courses/TGT/NEWFRAME.jpg',
    },
  };

  it('re-points BOTH poster and thumbnail at the EU transform host', () => {
    const out = retargetMediaHosts(media, 'eu');
    expect(out.video.poster).toBe(
      'https://images.eu.articulate.com/f:png,w:1920,s:cover,q:65/rise/courses/TGT/NEWFRAME.jpg',
    );
    expect(out.video.thumbnail).toBe(
      'https://images.eu.articulate.com/f:jpg,b:fff,w:100,h:100,s:cover/rise/courses/TGT/NEWFRAME.jpg',
    );
    expect(out.video.key).toBe('rise/courses/TGT/NEWVID.mp4');
  });

  it('is symmetric — an EU-shaped url comes back US on a US target', () => {
    const eu = retargetMediaHosts(media, 'eu');
    expect(retargetMediaHosts(eu, 'us')).toEqual(media);
  });

  it('leaves built-in library references and prose completely alone', () => {
    const doc = {
      builtinKey: 'assets/rise/assets/block-defaults/mountains.jpg',
      builtinUrl: 'https://cdn.articulate.com/assets/rise/themes/cover.jpg',
      builtinThumb:
        'https://articulateusercontent.com/assets/rise/assets/block-defaults/mountains_thumb.jpg',
      prose: 'Visit images.articulate.com for details.',
    };
    expect(retargetMediaHosts(doc, 'eu')).toEqual(doc);
  });

  it('does nothing when the target plane is unknown — never guess a plane', () => {
    expect(retargetMediaHosts(media, undefined)).toEqual(media);
  });

  it('re-points a usercontent origin that carries an uploaded key', () => {
    const doc = {
      src: 'https://articulateusercontent.com/rise/courses/TGT/a.png',
    };
    expect(retargetMediaHosts(doc, 'eu').src).toBe(
      'https://articulateusercontent.eu/rise/courses/TGT/a.png',
    );
  });
});

describe('verifyParity — lesson links', () => {
  const doc = (lessonIds: string[], dest: string): GetCourseDocument =>
    ({
      course: { id: 'C', lessons: lessonIds },
      lessons: lessonIds.map((id, i) => ({
        id,
        position: i,
        type: 'blocks',
        title: `L${i}`,
        items:
          i === 0
            ? [
                {
                  id: 'b1',
                  family: 'buttons',
                  variant: 'button',
                  items: [{ id: 'i1', type: 'lesson', destination: dest }],
                },
              ]
            : [],
      })),
    }) as unknown as GetCourseDocument;

  it('blocks when a destination names no target lesson', () => {
    const r = verifyParity(doc(['SA', 'SB'], 'SB'), doc(['TA', 'TB'], 'SB'));
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.path.includes('lesson link'));
    expect(issue?.detail).toContain('still the SOURCE lesson id');
  });

  it('passes when the destination resolves on the target', () => {
    const r = verifyParity(doc(['SA', 'SB'], 'SB'), doc(['TA', 'TB'], 'TB'));
    expect(r.issues.filter((i) => i.path.includes('lesson link'))).toEqual([]);
  });

  it('demotes a flagged block to an EXPECTED divergence', () => {
    const r = verifyParity(doc(['SA', 'SB'], 'SB'), doc(['TA', 'TB'], 'SB'), [
      { kind: 'lesson-link', sourceBlockId: 'b1', detail: 'flagged' },
    ]);
    expect(r.issues.filter((i) => i.path.includes('lesson link'))).toEqual([]);
    expect(
      r.expectedDivergences.some((i) => i.path.includes('lesson link')),
    ).toBe(true);
  });
});
