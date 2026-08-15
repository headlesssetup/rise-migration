import { describe, expect, it } from 'vitest';
import { buildPlan } from '@/core/import';
import { assertCleanDocument, buildArchiveCourse } from './archive';
import type { Mints } from './map';
import { StoryboardError, type PlannedCourse } from './types';

function mints(): Mints {
  let c = 0;
  let u = 0;
  return {
    cuid: () => `c${String(++c).padStart(24, '0')}`,
    uuid: () => `00000000-0000-4000-8000-${String(++u).padStart(12, '0')}`,
  };
}

const PROV = (slideNo: number) => ({
  slideNo,
  tableRow: slideNo,
  experience: 'Teksts',
  comments: '',
  rawScreenText: 'x',
});

function planned(): PlannedCourse {
  return {
    title: '1.1. Testa kurss',
    lessons: [
      {
        title: 'Tēma 1',
        blocks: [
          { intent: { kind: 'text', heading: 'H', paragraphs: ['<p>a</p>'] }, provenance: PROV(1), notes: [] },
          { intent: { kind: 'video-placeholder', label: 'Video (~3 min)' }, provenance: PROV(2), notes: [] },
        ],
      },
      {
        title: 'Tēma 2',
        blocks: [
          {
            intent: {
              kind: 'knowledge-check',
              intro: [],
              questions: [{ stem: '<p>q</p>', options: [{ text: 'a', correct: true }, { text: 'b', correct: false }] }],
            },
            provenance: PROV(3),
            notes: [],
          },
        ],
      },
    ],
    unparsed: [],
    production: [
      { lesson: 'Tēma 1', slideNo: 2, experience: 'Video (~3 min)', audioText: 'Runas teksts.' },
    ],
  };
}

describe('buildArchiveCourse', () => {
  it('emits a {course, lessons} body the import can read, with clean synthetic ids', () => {
    const built = buildArchiveCourse(planned(), '2026-08-10T00:00:00Z', mints(), () => 'cXcourse');
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

  it('writes the production report grouped by lesson with slide numbers', () => {
    const built = buildArchiveCourse(planned(), '2026-08-10T00:00:00Z', mints());
    expect(built.productionMd).toContain('## Tēma 1');
    expect(built.productionMd).toContain('### Slaids 2 — Video (~3 min)');
    expect(built.productionMd).toContain('Runas teksts.');
  });

  it('records per-block provenance in the plan artifact', () => {
    const built = buildArchiveCourse(planned(), '2026-08-10T00:00:00Z', mints());
    const plan = JSON.parse(built.planJson);
    expect(plan.blocks.some((b: { slideNo: number; kind: string }) => b.slideNo === 3 && b.kind === 'knowledge-check')).toBe(true);
  });

  it('feeds the EXISTING import planner without a forked path (buildPlan accepts it)', () => {
    const built = buildArchiveCourse(planned(), '2026-08-10T00:00:00Z', mints());
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

  it('refuses an empty plan', () => {
    expect(() =>
      buildArchiveCourse({ title: 'x', lessons: [], unparsed: [], production: [] }, 't', mints()),
    ).toThrow(StoryboardError);
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
              { id: 'b', type: 'text', family: 'text', variant: 'paragraph', items: [{ id: 'i', paragraph: { l10nId: 'x' } }] },
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
