import { describe, expect, it } from 'vitest';
import type { Storage } from '@/core/storage/storage';
import { checkImportPreconditions } from './import-preflight';

// A storyline block as the exporter sees it (leaf = an attached package).
const storylineBlock = (id: string, leaf?: string) => ({
  id,
  family: '360',
  variant: 'storyline',
  items: [
    {
      id: `${id}-item`,
      media: leaf
        ? { storyline: { contentPrefix: `review/items/${leaf}`, meta: { version: '3.90' } } }
        : {},
    },
  ],
});

const bankBlock = (id: string, bankId: string) => ({
  id,
  family: 'knowledgeCheck',
  variant: 'draw from question bank',
  items: [{ id: `${id}-item`, questionBankId: bankId, drawCount: 3 }],
});

const course = (id: string, title: string, items: unknown[]) =>
  JSON.stringify({
    course: { id, title, lessons: ['L1'] },
    lessons: [{ id: 'L1', type: 'blocks', title: 'Lesson', items }],
  });

interface Fake {
  courses: Record<string, string>;
  inventory?: unknown;
  storylineManifests?: Record<string, unknown>;
  bankIdMap?: Record<string, { newBankId: string }>;
}

function storage(f: Fake): Storage {
  return {
    readCourse: async (id: string) => f.courses[id] ?? null,
    readInventory: async () => (f.inventory ? JSON.stringify(f.inventory) : null),
    readStorylineManifest: async (id: string) =>
      f.storylineManifests?.[id] ? JSON.stringify(f.storylineManifests[id]) : null,
    readImportArtifact: async (name: string) =>
      name === 'banks.idmap.json' && f.bankIdMap ? JSON.stringify(f.bankIdMap) : null,
  } as unknown as Storage;
}

describe('checkImportPreconditions', () => {
  it('is silent for a plain course with every prerequisite met', async () => {
    const s = storage({ courses: { c1: course('c1', 'Plain', []) } });
    expect(await checkImportPreconditions(s, ['c1'], { recreateFolders: false })).toEqual([]);
  });

  it('warns when courses that live in a folder would land in root', async () => {
    const s = storage({
      courses: { c1: course('c1', 'A', []), c2: course('c2', 'B', []) },
      inventory: [
        { id: 'c1', folderId: 'F1' },
        { id: 'c2', folderId: '' },
      ],
    });
    const w = await checkImportPreconditions(s, ['c1', 'c2'], { recreateFolders: false });
    expect(w.map((x) => x.kind)).toEqual(['folders']);
    expect(w[0]!.message).toMatch(/1 of 2 selected course\(s\) sit in a folder/);
    // The checkbox resolves it.
    expect(await checkImportPreconditions(s, ['c1', 'c2'], { recreateFolders: true })).toEqual([]);
  });

  it('warns when a Storyline package has not been uploaded (step D skipped)', async () => {
    const s = storage({
      courses: { c1: course('c1', 'Has Storyline', [storylineBlock('B1', 'leaf1')]) },
    });
    const w = await checkImportPreconditions(s, ['c1'], { recreateFolders: true });
    expect(w.map((x) => x.kind)).toEqual(['storyline']);
    expect(w[0]!.message).toMatch(/1 Storyline\/Mighty package\(s\) not yet uploaded/);
    expect(w[0]!.message).toContain('"Has Storyline"');
  });

  it('is silent once step D recorded the upload in the manifest', async () => {
    const s = storage({
      courses: { c1: course('c1', 'Has Storyline', [storylineBlock('B1', 'leaf1')]) },
      storylineManifests: {
        c1: {
          courseId: 'c1',
          blocks: [{ blockId: 'B1', lessonId: 'L1', leaf: 'leaf1', meta: { version: '3.90' } }],
          uploads: { leaf1: { reviewPrefix: 'review/items/NEW' } },
        },
      },
    });
    expect(await checkImportPreconditions(s, ['c1'], { recreateFolders: true })).toEqual([]);
  });

  it('names a not-exportable course as MANUAL attach, never "run step D first"', async () => {
    const s = storage({
      courses: { c1: course('c1', 'Blocked', [storylineBlock('B1', 'leaf1')]) },
      storylineManifests: {
        c1: {
          courseId: 'c1',
          exportBlocked: 'the saved authorPermissions lack `export`',
          blocks: [{ blockId: 'B1', lessonId: 'L1', leaf: 'leaf1', compatibility: 'source-placeholder' }],
        },
      },
    });
    const w = await checkImportPreconditions(s, ['c1'], { recreateFolders: true });
    expect(w.map((x) => x.kind)).toEqual(['storyline-manual']);
    expect(w[0]!.message).toMatch(/step D cannot stage/);
    expect(w[0]!.message).not.toMatch(/run step D/);
    expect(w[0]!.message).toContain('"Blocked"');
  });

  it('reports progress + a verdict line through onEvent', async () => {
    const s = storage({ courses: { c1: course('c1', 'Plain', []), c2: course('c2', 'Plain 2', []) } });
    const events: string[] = [];
    await checkImportPreconditions(s, ['c1', 'c2'], { recreateFolders: true }, (e) => {
      if (e.kind === 'log') events.push(e.message);
      if (e.kind === 'import-status') events.push(`status:${e.label}${e.done ? ' done' : ''}`);
    });
    expect(events).toEqual([
      'Preflight: checking 2 selected course(s) for skipped steps…',
      'status:Preflight [1/2]',
      'status:Preflight [2/2]',
      'status:Preflight complete done',
      '✓ Preflight: no skipped steps across 2 course(s).',
    ]);
  });

  it('ignores never-attached Storyline placeholders (nothing to upload)', async () => {
    const s = storage({
      courses: { c1: course('c1', 'Placeholder', [storylineBlock('B1')]) },
    });
    expect(await checkImportPreconditions(s, ['c1'], { recreateFolders: true })).toEqual([]);
  });

  it('warns when draw-from-bank blocks reference banks step B has not imported', async () => {
    const s = storage({
      courses: {
        c1: course('c1', 'Quiz', [bankBlock('B1', 'bankX')]),
        c2: course('c2', 'Bound', [bankBlock('B2', 'bankY')]),
      },
      bankIdMap: { bankY: { newBankId: 'NEW' } },
    });
    const w = await checkImportPreconditions(s, ['c1', 'c2'], { recreateFolders: true });
    expect(w.map((x) => x.kind)).toEqual(['banks']);
    expect(w[0]!.message).toMatch(/1 selected course\(s\) draw from 1 question bank\(s\)/);
    expect(w[0]!.message).toContain('"Quiz"');
    expect(w[0]!.message).not.toContain('"Bound"');
  });

  it('skips courses that are missing or unreadable (the run reports those)', async () => {
    const s = storage({ courses: { bad: '{not json' } });
    expect(await checkImportPreconditions(s, ['bad', 'absent'], { recreateFolders: true })).toEqual(
      [],
    );
  });

  it('warns when exported courses name no label set, unless an interface language is chosen', async () => {
    const unnamed = JSON.stringify({
      course: { id: 'c1', title: 'Sk', labelSetId: '', lessons: ['L1'] },
      lessons: [{ id: 'L1', type: 'blocks', title: 'Lesson', items: [] }],
    });
    const s = storage({ courses: { c1: unnamed } });
    const w = await checkImportPreconditions(s, ['c1'], { recreateFolders: false });
    expect(w.map((x) => x.kind)).toEqual(['labels']);
    expect(w[0]!.message).toContain('"Sk"');
    expect(
      await checkImportPreconditions(s, ['c1'], { recreateFolders: false, defaultLabelLanguage: 'de' }),
    ).toEqual([]);
  });
});
