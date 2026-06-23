import { describe, it, expect } from 'vitest';
import {
  buildBlockIndex,
  resolveManualWork,
  prettyFilename,
  blockTypeLabel,
  buildCourseReportMarkdown,
  buildCourseReportJson,
  buildRunCsv,
  type RunCsvCourse,
} from './manual-work';
import type { GetCourseDocument } from '@/shared/types/rise';
import type { FidelityReport } from './fidelity';

// A tiny course: 2 lessons in an explicit display order (reversed vs the object
// array, to prove ordering follows `course.lessons`, not array position).
const doc: GetCourseDocument = {
  course: { id: 'C', title: 'Econ 101', lessons: ['l2', 'l1'] },
  lessons: [
    {
      id: 'l1',
      title: 'Intro',
      items: [
        { id: 'b1', family: 'text', variant: 'paragraph' },
        { id: 'b2', family: 'image', variant: 'full-width' },
      ],
    },
    {
      id: 'l2',
      title: 'How to Econ',
      items: [
        { id: 'b3', family: 'list', variant: 'bulleted' },
        { id: 'b4', family: '360', variant: 'storyline' },
      ],
    },
  ],
};

describe('buildBlockIndex', () => {
  it('orders lessons by course.lessons and numbers blocks 1-based', () => {
    const idx = buildBlockIndex(doc);
    // l2 comes first per the order list → lessonNumber 1.
    expect(idx.get('b4')).toEqual({
      lessonNumber: 1,
      lessonTitle: 'How to Econ',
      blockNumber: 2,
      blockType: 'Storyline/Mighty',
    });
    expect(idx.get('b1')).toEqual({
      lessonNumber: 2,
      lessonTitle: 'Intro',
      blockNumber: 1,
      blockType: 'text/paragraph',
    });
  });
});

describe('blockTypeLabel', () => {
  it('names storyline/mighty and draw-from-bank, else family/variant', () => {
    expect(blockTypeLabel({ family: '360', variant: 'storyline' })).toBe('Storyline/Mighty');
    expect(blockTypeLabel({ variant: 'storyline' })).toBe('Storyline/Mighty');
    expect(
      blockTypeLabel({ family: 'knowledgeCheck', variant: 'draw from question bank' }),
    ).toBe('Draw-from-bank');
    expect(blockTypeLabel({ family: 'image', variant: 'full-width' })).toBe('image/full-width');
  });
});

describe('prettyFilename', () => {
  it('strips the id prefix and undoes Rise double-encoding', () => {
    expect(
      prettyFilename('rise/courses/C/64EwqLFGVG84dOlK-seperator%2520(5).svg'),
    ).toBe('seperator (5).svg');
  });
});

describe('resolveManualWork', () => {
  const idx = buildBlockIndex(doc);

  it('resolves a storyline flag to a human location + action', () => {
    const item = resolveManualWork(
      [{ kind: 'storyline', sourceBlockId: 'b4', detail: 'x' }],
      idx,
    )[0]!;
    expect(item.location).toBe('Lesson 1 "How to Econ" › block 2 (Storyline/Mighty)');
    expect(item.itemType).toBe('Storyline/Mighty block');
    expect(item.action).toMatch(/Review 360/);
    expect(item.lessonNumber).toBe(1);
  });

  it('names the missing media file for an orphan-media flag', () => {
    const item = resolveManualWork(
      [
        {
          kind: 'orphan-media',
          sourceBlockId: 'b2',
          sourceKey: 'rise/courses/C/abc123defghi-Audio%2520clip.mp3',
          detail: 'x',
        },
      ],
      idx,
    )[0]!;
    expect(item.location).toBe('Lesson 2 "Intro" › block 2 (image/full-width)');
    expect(item.action).toContain('"Audio clip.mp3"');
  });

  it('categorizes flags with no block id (typeface → Theme / fonts)', () => {
    const item = resolveManualWork([{ kind: 'typeface', detail: 'x' }], idx)[0]!;
    expect(item.location).toBe('Theme / fonts');
    expect(item.itemType).toBe('Missing font');
  });

  it('falls back to the raw id when the block is not in the index', () => {
    const item = resolveManualWork(
      [{ kind: 'storyline', sourceBlockId: 'unknown', detail: 'x' }],
      idx,
    )[0]!;
    expect(item.location).toBe('block unknown');
  });
});

const baseReport: FidelityReport = {
  generatedAt: '2026-06-23T00:00:00Z',
  dryRun: false,
  ok: true,
  sourceCourseId: 'C',
  title: 'Econ 101',
  newCourseId: 'TGT',
  planned: {
    total: 6,
    lessons: 2,
    blocks: 4,
    banks: 0,
    uploads: 0,
    storylineFlags: 0,
    orphanFlags: 0,
    drawFromBank: 0,
  },
  flags: [],
  survivingSourceKeys: [],
  idMappings: 8,
};

describe('buildCourseReportMarkdown', () => {
  it('is brief and says "none" when there is no manual work', () => {
    const md = buildCourseReportMarkdown({ report: baseReport, manual: [] });
    expect(md).toContain('# Econ 101 — OK');
    expect(md).toContain('## Manual work');
    expect(md).toContain('- none');
    expect(md).toContain('Parity: not verified');
  });

  it('lists manual work with real names', () => {
    const idx = buildBlockIndex(doc);
    const manual = resolveManualWork([{ kind: 'storyline', sourceBlockId: 'b4', detail: 'x' }], idx);
    const md = buildCourseReportMarkdown({ report: baseReport, manual });
    expect(md).toContain('## Manual work (1)');
    expect(md).toContain('Lesson 1 "How to Econ" › block 2 (Storyline/Mighty)');
  });
});

describe('buildCourseReportJson', () => {
  it('nests parity, manual work, and the resumable id map', () => {
    const json = JSON.parse(
      buildCourseReportJson({
        report: baseReport,
        manual: [],
        idMap: { old1: 'new1' },
      }),
    );
    expect(json.title).toBe('Econ 101');
    expect(json.parity).toBeNull();
    expect(json.manualWork).toEqual([]);
    expect(json.idMap).toEqual({ old1: 'new1' });
  });
});

describe('buildRunCsv', () => {
  it('emits a header, a row per manual item, and a summary row for clean courses', () => {
    const idx = buildBlockIndex(doc);
    const courses: RunCsvCourse[] = [
      {
        title: 'Econ 101',
        courseId: 'C',
        targetCourseId: 'TGT',
        status: 'imported',
        manual: resolveManualWork([{ kind: 'storyline', sourceBlockId: 'b4', detail: 'x' }], idx),
      },
      { title: 'Clean', courseId: 'C2', targetCourseId: 'T2', status: 'imported', manual: [] },
      { courseId: 'C3', status: 'not-started', manual: [] },
    ];
    const csv = buildRunCsv(courses);
    const rows = csv.split('\n');
    expect(rows[0]).toBe('Course,Status,Target course,Location,Issue,What to do,Reference');
    // manual item row quotes the comma-containing location
    expect(rows[1]).toContain('"Lesson 1 ""How to Econ"" › block 2 (Storyline/Mighty)"');
    // clean course → summary row
    expect(rows[2]).toBe('Clean,imported,T2,,(none),Nothing to do,C2');
    // not-started course → guidance row
    expect(rows[3]).toBe('C3,not-started,,,Not started,Re-run to import,C3');
  });
});
