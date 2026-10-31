import { describe, it, expect } from 'vitest';
import { buildManualActionsMarkdown } from './manual-actions';
import type { RunCsvCourse } from './manual-work';

const font = (action: string) => ({ kind: 'typeface' as const, location: 'Theme / fonts', itemType: 'Missing font', action });

describe('buildManualActionsMarkdown', () => {
  it('groups by action, links each course on its plane, and dedupes identical lines', () => {
    const courses: RunCsvCourse[] = [
      {
        title: 'Freigabe',
        courseId: 'S1',
        targetCourseId: 'T1',
        status: 'imported',
        manual: [font('Font "DB Head" is not on the target'), font('Font "DB Head" is not on the target')],
      },
      {
        title: 'Hauptlichtsignale',
        courseId: 'S2',
        targetCourseId: 'T2',
        status: 'imported',
        manual: [
          { kind: 'export-settings', location: 'Course-level', itemType: 'Publish settings', action: 'Select the quiz' },
          { kind: 'builtin-asset', location: 'Built-in assets', itemType: 'Built-in Rise asset', action: 'Check the image' },
        ],
      },
      { title: 'Clean', courseId: 'S3', targetCourseId: 'T3', status: 'imported', manual: [] },
    ];
    const md = buildManualActionsMarkdown(courses, { plane: 'eu' });
    expect(md).toContain('## Required');
    expect(md).toContain('### Missing font (1) — in Theme → Fonts');
    expect(md).toContain('[Freigabe](https://rise.eu.articulate.com/authoring/T1)');
    expect(md).toContain('[Hauptlichtsignale](https://rise.eu.articulate.com/authoring/T2)');
    expect(md.indexOf('## Required')).toBeLessThan(md.indexOf('## Verify'));
    expect(md).not.toContain('Clean');
  });

  it('lists blocking read-back issues and unfinished courses; empty when nothing to do', () => {
    const md = buildManualActionsMarkdown([
      {
        title: 'P',
        courseId: 'S',
        targetCourseId: 'T',
        status: 'partial',
        manual: [],
        parity: {
          ok: false,
          lessons: { source: 1, target: 1 },
          blocks: { source: 1, target: 1, compared: 1 },
          issues: [{ kind: 'content-changed', path: 'lessons[0]', detail: 'x' }],
          expectedDivergences: [],
        },
      },
    ]);
    expect(md).toContain('Read-back differences');
    expect(md).toContain('status **partial**');
    expect(buildManualActionsMarkdown([{ courseId: 'S', status: 'imported', manual: [] }])).toBe('');
  });

  it('lists every automatic decision, even for a course with no manual work', () => {
    const md = buildManualActionsMarkdown(
      [
        {
          title: 'Q',
          courseId: 'S',
          targetCourseId: 'T',
          status: 'imported',
          manual: [],
          decisions: [{ area: 'Completion quiz', detail: 'bound completion to the only quiz "Test"' }],
        },
      ],
      { plane: 'us' },
    );
    expect(md).toContain('## Decisions made automatically (1)');
    expect(md).toContain('[Q](https://rise.articulate.com/authoring/T) — **Completion quiz**: bound completion');
  });
});
