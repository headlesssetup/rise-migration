import { describe, expect, it } from 'vitest';
import { buildPlan } from '@/core/import';
import type { Mints } from '@/core/storyboard/map';
import {
  COURSE_BLUEPRINT_FORMAT,
  COURSE_BLUEPRINT_VERSION,
  type CourseBlueprint,
} from './blueprint/types';
import { assertCleanDocument, compileCourseBlueprint } from './compiler';
import { StoryboardError } from './errors';
import { goldenBlueprint } from './golden-blueprint.fixture';

function mints(): Mints {
  let c = 0;
  let u = 0;
  return {
    cuid: () => `c${String(++c).padStart(24, '0')}`,
    uuid: () => `00000000-0000-4000-8000-${String(++u).padStart(12, '0')}`,
  };
}

const REF = (slideNo: number) => ({ label: `Slide ${slideNo}`, slideNo, excerpt: 'x' });

function minimal(): CourseBlueprint {
  return {
    format: COURSE_BLUEPRINT_FORMAT,
    formatVersion: COURSE_BLUEPRINT_VERSION,
    source: { kind: 'ai-provider', originalFileName: 'deck.pptx' },
    title: '1.1. Testa kurss',
    lessons: [
      {
        title: 'Tēma 1',
        blocks: [
          {
            intent: { kind: 'text', heading: 'H', paragraphs: ['<p>a</p>'] },
            sourceRef: REF(1),
            notes: [],
          },
          {
            intent: { kind: 'video-placeholder', label: 'Video (~3 min)' },
            sourceRef: REF(2),
            notes: [],
          },
        ],
      },
      {
        title: 'Tēma 2',
        blocks: [
          {
            intent: {
              kind: 'knowledge-check',
              intro: [],
              questions: [
                {
                  stem: '<p>q</p>',
                  options: [
                    { text: 'a', correct: true },
                    { text: 'b', correct: false },
                  ],
                },
              ],
            },
            sourceRef: REF(3),
            notes: [],
          },
        ],
      },
    ],
    assets: [],
    unresolved: [],
    production: [
      {
        kind: 'narration',
        lesson: 'Tēma 1',
        sourceRef: { label: 'Slide 2', slideNo: 2, excerpt: 'Video (~3 min)' },
        text: 'Runas teksts.',
      },
    ],
  };
}

describe('compileCourseBlueprint', () => {
  it('emits a {course, lessons} body the import can read, with clean synthetic ids', () => {
    const built = compileCourseBlueprint(minimal(), '2026-08-16T00:00:00Z', mints(), () => 'cXcourse');
    expect(built.courseId).toBe('sb-cXcourse');
    const doc = JSON.parse(built.raw);
    expect(doc.course).toMatchObject({ id: 'sb-cXcourse', title: '1.1. Testa kurss', type: null });
    expect(doc.lessons).toHaveLength(2);
    expect(doc.lessons[0]).toMatchObject({ type: 'blocks', position: 0, title: 'Tēma 1' });
    expect(doc.lessons[0].items).toHaveLength(2);
    expect(built.lessonCount).toBe(2);
    expect(built.blockCount).toBe(3);
    expect(built.manifestEntry).toEqual({ id: 'sb-cXcourse', title: '1.1. Testa kurss' });

    // Every block id unique.
    const ids = doc.lessons.flatMap((l: { items: { id: string }[] }) => l.items.map((b) => b.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('writes the production report (English scaffolding) grouped by lesson with slide numbers', () => {
    const built = compileCourseBlueprint(minimal(), '2026-08-16T00:00:00Z', mints());
    expect(built.productionMd).toContain('# Production material — 1.1. Testa kurss');
    expect(built.productionMd).toContain('## Tēma 1');
    expect(built.productionMd).toContain('### Slide 2 — Video (~3 min)');
    expect(built.productionMd).toContain('Runas teksts.');
  });

  it('returns no production report when the blueprint has no narration', () => {
    const built = compileCourseBlueprint(
      { ...minimal(), production: [] },
      '2026-08-16T00:00:00Z',
      mints(),
    );
    expect(built.productionMd).toBeNull();
  });

  it('records per-block provenance in the plan artifact', () => {
    const built = compileCourseBlueprint(minimal(), '2026-08-16T00:00:00Z', mints());
    const plan = JSON.parse(built.planJson);
    expect(
      plan.blocks.some(
        (b: { slideNo: number; kind: string }) => b.slideNo === 3 && b.kind === 'knowledge-check',
      ),
    ).toBe(true);
  });

  it('feeds the EXISTING import planner without a forked path (buildPlan accepts it)', () => {
    const built = compileCourseBlueprint(minimal(), '2026-08-16T00:00:00Z', mints());
    const doc = JSON.parse(built.raw);
    const steps = buildPlan({
      course: doc,
      assets: [],
      banksById: new Map(),
      author: 'test-author',
    });
    const kinds = steps.map((s) => s.kind);
    expect(kinds).toContain('create-course');
    expect(kinds.filter((k) => k === 'create-lesson')).toHaveLength(2);
    expect(kinds).toContain('create-blocks');
    // Text-only: NO media patches, NO bank binds, NO storyline, NO stack steps.
    for (const k of kinds) {
      expect(k).not.toMatch(/media|bank|storyline|stack|flag/);
    }
  });

  it('refuses an empty course', () => {
    expect(() => compileCourseBlueprint({ ...minimal(), lessons: [] }, 't', mints())).toThrow(
      StoryboardError,
    );
  });

  it('refuses provider-returned assets until a local-asset adapter exists', () => {
    const bp = minimal();
    bp.assets = [{ kind: 'local-asset', path: 'assets/x.png' } as never];
    expect(() => compileCourseBlueprint(bp, 't', mints())).toThrow(/local assets/);
  });

  it('is loud when per-answer KC feedback is dropped (no donor slot yet)', () => {
    const bp = minimal();
    const kc = bp.lessons[1]!.blocks[0]!;
    if (kc.intent.kind === 'knowledge-check') {
      kc.intent.questions[0]!.options[0]!.feedback = 'Correct — well done.';
    }
    const built = compileCourseBlueprint(bp, 't', mints());
    expect(built.notes.some((n) => /per-answer feedback/.test(n))).toBe(true);
  });
});

describe('compileCourseBlueprint — golden fixture (every intent kind)', () => {
  it('compiles the golden blueprint clean and passes assertCleanDocument', () => {
    const built = compileCourseBlueprint(goldenBlueprint(), '2026-08-16T00:00:00Z', mints());
    const doc = JSON.parse(built.raw);
    expect(() => assertCleanDocument(doc)).not.toThrow();
    expect(built.lessonCount).toBe(3);
    expect(built.blockCount).toBeGreaterThan(15);

    // Every fixture intent kind is recorded in the plan artifact.
    const plan = JSON.parse(built.planJson);
    const kinds = new Set(plan.blocks.map((b: { kind: string }) => b.kind));
    for (const kind of [
      'text',
      'list',
      'accordion',
      'tabs',
      'flashcards',
      'process',
      'timeline',
      'sorting',
      'knowledge-check',
      'note',
      'links',
      'video-placeholder',
      'storyline-placeholder',
      'continue',
      'attachment-placeholder',
    ]) {
      expect(kinds.has(kind), `kind "${kind}" missing from plan records`).toBe(true);
    }

    // The pasted blueprint (incl. origin marks) persists verbatim in the plan.
    expect(plan.blueprint.lessons[1].blocks.at(-1).origin).toBe('suggested');
  });

  it('golden fixture still feeds the import planner', () => {
    const built = compileCourseBlueprint(goldenBlueprint(), '2026-08-16T00:00:00Z', mints());
    const steps = buildPlan({
      course: JSON.parse(built.raw),
      assets: [],
      banksById: new Map(),
      author: 'test-author',
    });
    expect(steps.map((s) => s.kind)).toContain('create-course');
  });
});

describe('assertCleanDocument', () => {
  it('aborts when a typed package-local asset reaches Rise JSON', () => {
    expect(() =>
      assertCleanDocument({
        course: { id: 'c', title: 't' },
        lessons: [
          {
            id: 'l',
            type: 'blocks',
            items: [
              {
                id: 'b',
                type: 'image',
                family: 'image',
                variant: 'hero',
                items: [{ id: 'i', media: { image: { kind: 'local-asset', path: 'assets/x.png' } } }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/unresolved local asset ref/);
  });

  it('aborts loudly when a media key sneaks into the built course', () => {
    expect(() =>
      assertCleanDocument({
        course: { id: 'c', title: 't' },
        lessons: [
          {
            id: 'l',
            type: 'blocks',
            items: [
              {
                id: 'b',
                type: 'text',
                family: 'text',
                variant: 'paragraph',
                items: [
                  {
                    id: 'i',
                    paragraph:
                      '<p><img src="https://articulateusercontent.com/rise/courses/c/img.png"></p>',
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow(/media key/);
  });

  it('aborts on l10n refs and storyline blocks', () => {
    expect(() =>
      assertCleanDocument({
        course: { id: 'c', title: 't' },
        lessons: [
          {
            id: 'l',
            type: 'blocks',
            items: [
              {
                id: 'b',
                type: 'text',
                family: 'text',
                variant: 'paragraph',
                items: [{ id: 'i', paragraph: { l10nId: 'x' } }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/l10n/);
    expect(() =>
      assertCleanDocument({
        course: { id: 'c', title: 't' },
        lessons: [
          {
            id: 'l',
            type: 'blocks',
            items: [
              {
                id: 'b',
                type: '360',
                family: '360',
                variant: 'storyline',
                items: [{ id: 'i', media: { storyline: { src: 'rise/courses/c/leaf/story.html' } } }],
              },
            ],
          },
        ],
      }),
    ).toThrow(/storyline/);
  });
});
