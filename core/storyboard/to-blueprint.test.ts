import { describe, expect, it } from 'vitest';
import { plannedCourseToBlueprint } from './to-blueprint';
import type { PlannedCourse } from './types';

describe('plannedCourseToBlueprint', () => {
  it('preserves semantics and provenance without emitting Rise JSON', () => {
    const planned: PlannedCourse = {
      title: 'Course',
      lessons: [
        {
          title: 'Lesson',
          blocks: [
            {
              intent: { kind: 'text', paragraphs: ['<p>Hello</p>'] },
              provenance: {
                slideNo: 7,
                tableRow: 3,
                experience: 'Text',
                comments: '',
                rawScreenText: 'Hello',
              },
              notes: ['review'],
            },
          ],
        },
      ],
      unparsed: [],
      production: [],
    };

    const blueprint = plannedCourseToBlueprint(planned, 'source.docx');
    expect(blueprint).toMatchObject({
      format: 'rise-course-blueprint',
      formatVersion: 1,
      source: { kind: 'intea-storyboard', originalFileName: 'source.docx' },
      title: 'Course',
      assets: [],
    });
    expect(blueprint.lessons[0]!.blocks[0]).toMatchObject({
      intent: { kind: 'text' },
      sourceRef: { slideNo: 7, row: 3, excerpt: 'Hello' },
    });
    expect(JSON.stringify(blueprint)).not.toContain('"family"');
    expect(JSON.stringify(blueprint)).not.toContain('"variant"');
  });
});
