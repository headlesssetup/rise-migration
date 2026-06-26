import { describe, it, expect } from 'vitest';
import { buildPlan, summarizePlan, planStats, findBankRef, type PlanInput } from './plan';

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    author: 'auth0|target',
    assets: [],
    banksById: new Map(),
    course: {
      course: { id: 'SRC', title: 'My Course', theme: { themeId: 'x' } },
      lessons: [],
    },
    ...overrides,
  };
}

describe('buildPlan ordering', () => {
  it('emits banks → course → theme → title → lessons', () => {
    const steps = buildPlan(
      input({
        recreateBanks: true, // opt in to bank recreation for this ordering test
        banksById: new Map([['bank1', { id: 'bank1', title: 'B', questions: [{}, {}] }]]),
        course: {
          course: { id: 'SRC', title: 'My Course', theme: { themeId: 'x' } },
          lessons: [
            {
              id: 'L1',
              position: 0,
              type: 'blocks',
              title: 'Lesson 1',
              items: [
                {
                  id: 'cblk1',
                  family: 'knowledgeCheck',
                  variant: 'draw from question bank',
                  items: [{ id: 'cit1', type: 'DRAW_FROM_QUESTION_BANK', questionBankId: 'bank1', drawCount: 3 }],
                },
              ],
            },
          ],
        },
      }),
    );
    const kinds = steps.map((s) => s.kind);
    // banks → course shell → FIRST lesson immediately (materializes the runtime
    // doc; no failable step between shell and first lesson) → … → title → theme.
    // Title/theme are course-level writes applied LAST: the shell alone is a
    // catalog row, and Rise rejects theming a lesson-less course.
    expect(kinds.slice(0, 4)).toEqual([
      'create-bank',
      'put-bank',
      'create-course',
      'create-lesson',
    ]);
    // title is set AFTER the course has been materialized by its first lesson
    expect(kinds.indexOf('set-title')).toBeGreaterThan(kinds.indexOf('create-lesson'));
    // lesson lifecycle present
    expect(kinds).toContain('create-lesson');
    expect(kinds).not.toContain('lock-lesson'); // locks skipped (solo import)
    expect(kinds).toContain('create-blocks');
    expect(kinds).toContain('bind-draw-from-bank');
    expect(kinds).not.toContain('unlock-lesson'); // never locked → never unlock
    // bind comes after the batched block creation
    expect(kinds.indexOf('bind-draw-from-bank')).toBeGreaterThan(
      kinds.indexOf('create-blocks'),
    );
    // theme is applied only AFTER at least one lesson exists
    expect(kinds.indexOf('set-theme')).toBeGreaterThan(kinds.indexOf('create-lesson'));
  });

  it('by DEFAULT leaves draw-from-bank as an unbound placeholder (no bank created)', () => {
    const steps = buildPlan(
      input({
        // recreateBanks omitted → default off
        banksById: new Map([['bank1', { id: 'bank1', title: 'B', questions: [{}] }]]),
        course: {
          course: { id: 'SRC', title: 'C' },
          lessons: [
            {
              id: 'L1',
              position: 0,
              type: 'blocks',
              title: 'L',
              items: [
                {
                  id: 'cblk1',
                  family: 'knowledgeCheck',
                  variant: 'draw from question bank',
                  items: [{ id: 'cit1', type: 'DRAW_FROM_QUESTION_BANK', questionBankId: 'bank1' }],
                },
              ],
            },
          ],
        },
      }),
    );
    const kinds = steps.map((s) => s.kind);
    expect(kinds).toContain('create-blocks'); // the placeholder block IS created
    expect(kinds).toContain('flag-draw-from-bank');
    expect(kinds).not.toContain('create-bank');
    expect(kinds).not.toContain('bind-draw-from-bank');
  });

  it('auto-binds draw-from-bank to a bank imported in step B (boundBanks) WITHOUT creating it', () => {
    const steps = buildPlan(
      input({
        // No recreateBanks; the bank was imported separately (step B).
        boundBanks: new Map([['bank1', { newBankId: 'NEWBANK', questionIds: ['q1', 'q2'] }]]),
        course: {
          course: { id: 'SRC', title: 'C' },
          lessons: [
            {
              id: 'L1',
              position: 0,
              type: 'blocks',
              title: 'L',
              items: [
                {
                  id: 'cblk1',
                  family: 'knowledgeCheck',
                  variant: 'draw from question bank',
                  items: [{ id: 'cit1', type: 'DRAW_FROM_QUESTION_BANK', questionBankId: 'bank1', drawCount: 2 }],
                },
              ],
            },
          ],
        },
      }),
    );
    const kinds = steps.map((s) => s.kind);
    expect(kinds).toContain('bind-draw-from-bank'); // bound → bind
    expect(kinds).not.toContain('create-bank'); // bank already exists (step B)
    expect(kinds).not.toContain('flag-draw-from-bank');
  });

  it('preserves SOURCE ARRAY ORDER (display order), ignoring the position field', () => {
    const steps = buildPlan(
      input({
        course: {
          course: { id: 'SRC', title: 'C' },
          // Array order is the display order; the `position` field does NOT track
          // it (here it's deliberately inverted) and must NOT reorder the output.
          lessons: [
            { id: 'A', position: 9, type: 'blocks', title: 'First', items: [] },
            { id: 'B', position: 0, type: 'blocks', title: 'Second', items: [] },
            { id: 'C', position: 4, type: 'blocks', title: 'Third', items: [] },
          ],
        },
      }),
    );
    const lessonSteps = steps.filter((s) => s.kind === 'create-lesson');
    expect(lessonSteps.map((s) => (s as { title: string }).title)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
    // Slots are re-indexed 0..n-1 in array order (an append each time).
    expect(lessonSteps.map((s) => (s as { position: number }).position)).toEqual([0, 1, 2]);
  });

  it('orders lessons by the course.lessons id list (NOT array order or position)', () => {
    const steps = buildPlan(
      input({
        course: {
          // Authoritative display order: B, A, C.
          course: { id: 'SRC', title: 'C', lessons: ['B', 'A', 'C'] },
          // Objects array + position deliberately disagree.
          lessons: [
            { id: 'A', position: 0, type: 'blocks', title: 'Alpha', items: [] },
            { id: 'B', position: 1, type: 'blocks', title: 'Bravo', items: [] },
            { id: 'C', position: 2, type: 'blocks', title: 'Charlie', items: [] },
          ],
        },
      }),
    );
    const titles = steps
      .filter((s) => s.kind === 'create-lesson')
      .map((s) => (s as { title: string }).title);
    expect(titles).toEqual(['Bravo', 'Alpha', 'Charlie']);
  });

  it('re-indexes gappy/non-0-based source positions to sequential slots', () => {
    const steps = buildPlan(
      input({
        course: {
          course: { id: 'SRC', title: 'C' },
          lessons: [
            { id: 'L1', position: 10, type: 'blocks', title: 'A', items: [] },
            { id: 'L2', position: 25, type: 'blocks', title: 'B', items: [] },
            { id: 'L3', position: 40, type: 'blocks', title: 'C', items: [] },
          ],
        },
      }),
    );
    const positions = steps
      .filter((s) => s.kind === 'create-lesson')
      .map((s) => (s as { position: number }).position);
    expect(positions).toEqual([0, 1, 2]);
  });

  it('section lessons skip locks/blocks', () => {
    const steps = buildPlan(
      input({
        course: {
          course: { id: 'SRC', title: 'C' },
          lessons: [{ id: 'S', position: 0, type: 'section', title: 'Module', items: [] }],
        },
      }),
    );
    expect(steps.some((s) => s.kind === 'lock-lesson')).toBe(false);
    expect(steps.some((s) => s.kind === 'create-lesson')).toBe(true);
  });

  it('batches a lesson’s blocks into ONE ordered create-blocks step', () => {
    const steps = buildPlan(
      input({
        course: {
          course: { id: 'SRC', title: 'C' },
          lessons: [
            {
              id: 'L1',
              position: 0,
              type: 'blocks',
              title: 'L',
              items: [
                { id: 'cb1', family: 'text', variant: 'paragraph', items: [] },
                { id: 'cb2', family: 'divider', variant: 'divider', items: [] },
              ],
            },
          ],
        },
      }),
    );
    const creates = steps.filter((s) => s.kind === 'create-blocks') as Array<{
      blocks: { sourceBlockId: string }[];
    }>;
    expect(creates.length).toBe(1); // one batch per lesson
    expect(creates[0]!.blocks.map((b) => b.sourceBlockId)).toEqual(['cb1', 'cb2']); // source order
  });
});

describe('buildPlan media + flags', () => {
  it('uploads downloadable media and patches the block', () => {
    const steps = buildPlan(
      input({
        assets: [
          { key: 'rise/courses/SRC/a.jpg', kind: 'media-image', file: 'assets/h.jpg' },
        ],
        course: {
          course: { id: 'SRC', title: 'C' },
          lessons: [
            {
              id: 'L1',
              position: 0,
              type: 'blocks',
              title: 'L',
              items: [
                {
                  id: 'cb1',
                  family: 'image',
                  variant: 'hero',
                  items: [{ id: 'ci1', media: { image: { key: 'rise/courses/SRC/a.jpg' } } }],
                },
              ],
            },
          ],
        },
      }),
    );
    const kinds = steps.map((s) => s.kind);
    expect(kinds).toContain('upload-asset');
    expect(kinds).toContain('patch-block-media');
    expect(kinds.indexOf('upload-asset')).toBeGreaterThan(kinds.indexOf('create-blocks'));
    expect(kinds.indexOf('patch-block-media')).toBeGreaterThan(kinds.indexOf('upload-asset'));
  });

  it('flags orphaned media instead of uploading', () => {
    const steps = buildPlan(
      input({
        assets: [
          { key: 'rise/courses/SRC/gone.jpg', kind: 'media-image', orphaned: true },
        ],
        course: {
          course: { id: 'SRC', title: 'C' },
          lessons: [
            {
              id: 'L1',
              position: 0,
              type: 'blocks',
              title: 'L',
              items: [
                {
                  id: 'cb1',
                  family: 'image',
                  variant: 'hero',
                  items: [{ id: 'ci1', media: { image: { key: 'rise/courses/SRC/gone.jpg' } } }],
                },
              ],
            },
          ],
        },
      }),
    );
    expect(steps.some((s) => s.kind === 'flag-orphan-media')).toBe(true);
    expect(steps.some((s) => s.kind === 'upload-asset')).toBe(false);
  });

  it('uploads a course cover image (set-course-images), not flag it', () => {
    const steps = buildPlan(
      input({
        assets: [{ key: 'rise/courses/SRC/cover.jpg', kind: 'media-image', file: 'assets/c.jpg' }],
        course: {
          course: {
            id: 'SRC',
            title: 'C',
            coverImage: { media: { image: { key: 'rise/courses/SRC/cover.jpg' } } },
          },
          lessons: [
            { id: 'L1', position: 0, type: 'blocks', title: 'L', items: [{ id: 'cb1', family: 'text', variant: 'p', items: [] }] },
          ],
        },
      }),
    );
    const sc = steps.find((s) => s.kind === 'set-course-images') as
      | { hasCover: boolean; hasCard: boolean }
      | undefined;
    expect(sc?.hasCover).toBe(true);
    // the cover key is handled, NOT flagged
    expect(steps.some((s) => s.kind === 'flag-unsupported-media')).toBe(false);
  });

  it('still flags a theme/header image that is not the cover/card', () => {
    const steps = buildPlan(
      input({
        assets: [{ key: 'rise/courses/SRC/logo.svg', kind: 'media-image', file: 'assets/l.svg' }],
        course: {
          course: { id: 'SRC', title: 'C', theme: { logo: 'rise/courses/SRC/logo.svg' } },
          lessons: [
            { id: 'L1', position: 0, type: 'blocks', title: 'L', items: [{ id: 'cb1', family: 'text', variant: 'p', items: [] }] },
          ],
        },
      }),
    );
    expect(
      steps.some(
        (s) => s.kind === 'flag-unsupported-media' && (s as { sourceKey: string }).sourceKey === 'rise/courses/SRC/logo.svg',
      ),
    ).toBe(true);
  });

  it('flags storyline blocks for manual handling', () => {
    const steps = buildPlan(
      input({
        course: {
          course: { id: 'SRC', title: 'C' },
          lessons: [
            {
              id: 'L1',
              position: 0,
              type: 'blocks',
              title: 'L',
              items: [{ id: 'cb1', family: '360', variant: 'storyline', items: [{ id: 'ci1' }] }],
            },
          ],
        },
      }),
    );
    expect(steps.some((s) => s.kind === 'flag-storyline')).toBe(true);
  });

  it('attaches a storyline block when its package is uploaded (else flags)', () => {
    const course = {
      course: { id: 'SRC', title: 'C' },
      lessons: [
        {
          id: 'L1',
          position: 0,
          type: 'blocks',
          title: 'L',
          items: [
            { id: 'cb1', family: '360', variant: 'storyline', items: [{ id: 'ci1' }] },
            { id: 'cb2', family: '360', variant: 'storyline', items: [{ id: 'ci2' }] },
          ],
        },
      ],
    };
    const steps = buildPlan(
      input({
        course,
        storylineAttach: new Map([
          ['cb1', { reviewPrefix: 'review/items/LEAF1', meta: { title: 'S1' }, title: 'S1' }],
        ]),
      }),
    );
    const attach = steps.find((s) => s.kind === 'attach-storyline');
    expect(attach).toMatchObject({ sourceBlockId: 'cb1', reviewPrefix: 'review/items/LEAF1' });
    // cb2 has no uploaded package → still flagged
    expect(steps.some((s) => s.kind === 'flag-storyline' && s.sourceBlockId === 'cb2')).toBe(true);
    expect(steps.some((s) => s.kind === 'attach-storyline' && s.sourceBlockId === 'cb2')).toBe(false);
  });
});

describe('buildPlan — lesson header media', () => {
  it('uploads a lesson header image BEFORE update-lesson (not flagged)', () => {
    const key = 'rise/courses/SRC/hdr.png';
    const steps = buildPlan(
      input({
        assets: [{ key, kind: 'media-image', file: 'assets/h.png', ext: 'png', size: 1024 }],
        course: {
          course: { id: 'SRC', title: 'C' },
          lessons: [
            {
              id: 'L1',
              position: 0,
              type: 'blocks',
              title: 'L',
              headerImage: { key },
              items: [{ id: 'cb1', family: 'text', variant: 'p', items: [] }],
            },
          ],
        },
      }),
    );
    const kinds = steps.map((s) => s.kind);
    // header upload exists, and comes BEFORE the lesson's update-lesson
    expect(kinds).toContain('upload-lesson-media');
    expect(kinds.indexOf('upload-lesson-media')).toBeLessThan(kinds.indexOf('update-lesson'));
    // the header key is NOT left as an unsupported-media flag
    expect(
      steps.some((s) => s.kind === 'flag-unsupported-media' && (s as { sourceKey: string }).sourceKey === key),
    ).toBe(false);
  });

  it('predicts an oversize lesson header as a manual flag (no upload)', () => {
    const key = 'rise/courses/SRC/huge.gif';
    const steps = buildPlan(
      input({
        assets: [{ key, kind: 'media-image', file: 'assets/g.gif', ext: 'gif', size: 400 * 1024 * 1024 }],
        course: {
          course: { id: 'SRC', title: 'C' },
          lessons: [
            { id: 'L1', position: 0, type: 'blocks', title: 'L', headerImage: { key }, items: [{ id: 'cb1', family: 'text', variant: 'p', items: [] }] },
          ],
        },
      }),
    );
    expect(steps.some((s) => s.kind === 'upload-lesson-media')).toBe(false);
    expect(
      steps.some((s) => s.kind === 'flag-unsupported-media' && (s as { sourceKey: string }).sourceKey === key),
    ).toBe(true);
  });
});

describe('buildPlan — oversize block media prediction (dry-run honest)', () => {
  it('flags an oversize block asset instead of emitting an upload-asset', () => {
    const key = 'rise/courses/SRC/big.gif';
    const steps = buildPlan(
      input({
        assets: [{ key, kind: 'media-image', file: 'assets/b.gif', ext: 'gif', size: 400 * 1024 * 1024 }],
        course: {
          course: { id: 'SRC', title: 'C' },
          lessons: [
            {
              id: 'L1',
              position: 0,
              type: 'blocks',
              title: 'L',
              items: [{ id: 'cb1', family: 'image', variant: 'hero', items: [{ id: 'ci1', media: { image: { key } } }] }],
            },
          ],
        },
      }),
    );
    expect(steps.some((s) => s.kind === 'upload-asset' && (s as { sourceKey: string }).sourceKey === key)).toBe(false);
    expect(
      steps.some((s) => s.kind === 'flag-unsupported-media' && (s as { sourceKey: string }).sourceKey === key),
    ).toBe(true);
  });

  it('still uploads a normal-size block asset', () => {
    const key = 'rise/courses/SRC/ok.jpg';
    const steps = buildPlan(
      input({
        assets: [{ key, kind: 'media-image', file: 'assets/o.jpg', ext: 'jpg', size: 2 * 1024 * 1024 }],
        course: {
          course: { id: 'SRC', title: 'C' },
          lessons: [
            {
              id: 'L1',
              position: 0,
              type: 'blocks',
              title: 'L',
              items: [{ id: 'cb1', family: 'image', variant: 'hero', items: [{ id: 'ci1', media: { image: { key } } }] }],
            },
          ],
        },
      }),
    );
    expect(steps.some((s) => s.kind === 'upload-asset' && (s as { sourceKey: string }).sourceKey === key)).toBe(true);
  });
});

describe('findBankRef', () => {
  it('reads bank ref from the item', () => {
    const ref = findBankRef({
      family: 'knowledgeCheck',
      variant: 'draw from question bank',
      items: [{ id: 'x', type: 'DRAW_FROM_QUESTION_BANK', questionBankId: 'bank9', drawCount: 5 }],
    });
    expect(ref.bankId).toBe('bank9');
    expect(ref.drawCount).toBe(5);
  });

  it('returns null bankId when unreferenced (loud-fail upstream)', () => {
    const ref = findBankRef({
      family: 'knowledgeCheck',
      variant: 'draw from question bank',
      items: [{ id: 'x', type: 'DRAW_FROM_QUESTION_BANK' }],
    });
    expect(ref.bankId).toBe(null);
  });
});

describe('summarizePlan / planStats', () => {
  it('summary is one numbered line per step', () => {
    const steps = buildPlan(input());
    const lines = summarizePlan(steps);
    expect(lines.length).toBe(steps.length);
    expect(lines[0]).toMatch(/^\s*1\. /);
  });

  it('stats roll up the plan', () => {
    const steps = buildPlan(
      input({
        course: {
          course: { id: 'SRC', title: 'C' },
          lessons: [
            { id: 'L1', position: 0, type: 'blocks', title: 'L', items: [{ id: 'cb1', family: 'text', variant: 'p', items: [] }] },
          ],
        },
      }),
    );
    const stats = planStats(steps);
    expect(stats.lessons).toBe(1);
    expect(stats.blocks).toBe(1);
    expect(stats.total).toBe(steps.length);
  });
});
