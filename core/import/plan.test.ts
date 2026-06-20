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
    expect(kinds.slice(0, 5)).toEqual([
      'create-bank',
      'put-bank',
      'create-course',
      'set-theme',
      'set-title',
    ]);
    // lesson lifecycle present
    expect(kinds).toContain('create-lesson');
    expect(kinds).toContain('lock-lesson');
    expect(kinds).toContain('create-block');
    expect(kinds).toContain('bind-draw-from-bank');
    expect(kinds).toContain('unlock-lesson');
    // bind comes after its create-block
    expect(kinds.indexOf('bind-draw-from-bank')).toBeGreaterThan(
      kinds.indexOf('create-block'),
    );
  });

  it('orders lessons by ascending position', () => {
    const steps = buildPlan(
      input({
        course: {
          course: { id: 'SRC', title: 'C' },
          lessons: [
            { id: 'L2', position: 1, type: 'blocks', title: 'Second', items: [] },
            { id: 'L1', position: 0, type: 'blocks', title: 'First', items: [] },
          ],
        },
      }),
    );
    const lessonSteps = steps.filter((s) => s.kind === 'create-lesson');
    expect(lessonSteps.map((s) => (s as { title: string }).title)).toEqual([
      'First',
      'Second',
    ]);
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

  it('chains blocks via previousSourceBlockId', () => {
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
    const creates = steps.filter((s) => s.kind === 'create-block') as Array<{
      sourceBlockId: string;
      previousSourceBlockId: string | null;
    }>;
    expect(creates[0]!.previousSourceBlockId).toBe(null);
    expect(creates[1]!.previousSourceBlockId).toBe('cb1');
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
    expect(kinds.indexOf('upload-asset')).toBeGreaterThan(kinds.indexOf('create-block'));
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

  it('flags course-level (cover) media as unsupported, not on a block', () => {
    const steps = buildPlan(
      input({
        assets: [{ key: 'rise/courses/SRC/cover.jpg', kind: 'media-image', file: 'assets/c.jpg' }],
        course: {
          course: { id: 'SRC', title: 'C', coverImage: { key: 'rise/courses/SRC/cover.jpg' } },
          lessons: [
            { id: 'L1', position: 0, type: 'blocks', title: 'L', items: [{ id: 'cb1', family: 'text', variant: 'p', items: [] }] },
          ],
        },
      }),
    );
    const flag = steps.find((s) => s.kind === 'flag-unsupported-media') as
      | { sourceKey: string }
      | undefined;
    expect(flag?.sourceKey).toBe('rise/courses/SRC/cover.jpg');
    // not emitted as a block upload
    expect(steps.some((s) => s.kind === 'upload-asset')).toBe(false);
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
