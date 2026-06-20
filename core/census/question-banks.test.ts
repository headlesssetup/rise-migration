import { describe, expect, it } from 'vitest';
import {
  buildBankCatalog,
  buildBankInventory,
  collectBankReferences,
  extractBanks,
  extractQuestions,
  hasInlineQuestions,
} from './question-banks';

describe('extractBanks', () => {
  it('reads the captured question_banks wrapper (with inline questions)', () => {
    const banks = extractBanks({
      question_banks: [{ id: 'a', title: 'A', questions: [{ id: 'q', type: 'MATCHING' }] }],
      profiles: [],
    });
    expect(banks.map((b) => b.id)).toEqual(['a']);
    expect(hasInlineQuestions(banks[0]!.doc)).toBe(true);
  });

  it('tolerates array, alternate wrappers, and id-maps', () => {
    expect(extractBanks([{ id: 'a' }]).map((b) => b.id)).toEqual(['a']);
    expect(extractBanks({ banks: [{ id: 'b' }] }).map((b) => b.id)).toEqual(['b']);
    expect(extractBanks({ content: { x: { id: 'c' } } }).map((b) => b.id)).toEqual(['c']);
  });
});

describe('extractQuestions', () => {
  it('finds the questions array', () => {
    const qs = extractQuestions({
      id: 'bank1',
      questions: [{ id: 'q1', type: 'MULTIPLE_CHOICE', answers: [] }],
    });
    expect(qs).toHaveLength(1);
  });

  it('falls back to a question-shaped array', () => {
    const qs = extractQuestions({
      data: { items: [{ id: 'q', type: 'MATCHING', answers: [] }] },
    });
    expect(qs[0]?.type).toBe('MATCHING');
  });
});

describe('buildBankCatalog', () => {
  const banks = [
    {
      id: 'b1',
      doc: {
        questions: [
          { id: 'q1', type: 'MULTIPLE_CHOICE', title: 'a', answers: [{ id: 'a1', correct: true }] },
          {
            id: 'q2',
            type: 'MULTIPLE_CHOICE',
            title: 'b',
            answers: [{ id: 'a2', correct: false }],
            feedback: 'x',
          },
        ],
      },
    },
    { id: 'b2', doc: { questions: [{ id: 'q3', type: 'MATCHING', answers: [] }] } },
  ];
  const cat = buildBankCatalog(banks);

  it('counts banks, questions, and types', () => {
    expect(cat.bankCount).toBe(2);
    expect(cat.questionCount).toBe(3);
    expect(cat.byType).toEqual([
      { type: 'MULTIPLE_CHOICE', count: 2 },
      { type: 'MATCHING', count: 1 },
    ]);
  });

  it('marks always-present fields core and sometimes-present optional', () => {
    const mc = cat.profiles.find((p) => p.type === 'MULTIPLE_CHOICE');
    const core = mc?.fields.filter((f) => f.core).map((f) => f.path) ?? [];
    expect(core).toContain('type');
    expect(core).toContain('title');
    expect(mc?.fields.find((f) => f.path === 'feedback')?.core).toBe(false);
  });

  it('detects question-bank media (rise/questionBanks/… snake_case keys)', () => {
    const withMedia = buildBankCatalog([
      {
        id: 'b1',
        doc: {
          questions: [
            {
              id: 'q1',
              type: 'FILL_IN_THE_BLANK',
              media: {
                image: {
                  key: 'rise/questionBanks/b1/ApJD32tYzib30O3N.jpg',
                  crushed_key: 'rise/questionBanks/b1/KCMbO6.jpg',
                },
              },
            },
          ],
        },
      },
    ]);
    const img = withMedia.mediaRefs.find((m) => m.kind === 'media-image');
    expect(img?.count).toBe(2); // key + crushed_key
    expect(img?.bankCount).toBe(1);
  });
});

describe('collectBankReferences', () => {
  it('finds questionBankId values anywhere in a course doc, deduped', () => {
    const course = {
      lessons: [
        {
          items: [
            { type: 'DRAW_FROM_QUESTION_BANK', questionBankId: 'bank-1' },
            { type: 'DRAW_FROM_QUESTION_BANK', questionBankId: 'bank-2' },
            { type: 'DRAW_FROM_QUESTION_BANK', questionBankId: 'bank-1' }, // dup
          ],
        },
      ],
    };
    expect(collectBankReferences(course).sort()).toEqual(['bank-1', 'bank-2']);
  });

  it('tolerates snake_case / bankId variants', () => {
    expect(collectBankReferences({ a: { bankId: 'x' }, b: { question_bank_id: 'y' } }).sort()).toEqual(
      ['x', 'y'],
    );
  });
});

describe('buildBankInventory', () => {
  const banks = [
    {
      id: 'b1',
      doc: {
        id: 'b1',
        title: 'Safety MCQs',
        folder_id: 'f1',
        author_id: 'u1',
        last_edited_by: 'u2',
        updated_at: '2024-05-01T00:00:00Z',
        version: '3',
        deleted: false,
        questions: [
          { id: 'q1', type: 'MULTIPLE_CHOICE' },
          { id: 'q2', type: 'MULTIPLE_CHOICE' },
          {
            id: 'q3',
            type: 'MATCHING',
            media: { image: { key: 'rise/questionBanks/b1/x.jpg' } },
          },
        ],
      },
    },
    {
      id: 'b2',
      doc: { id: 'b2', title: 'Unused', folder_id: 'f2', deleted: true, questions: [] },
    },
  ];

  const rows = buildBankInventory(banks, {
    profiles: [{ id: 'u1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@x.io' }],
    folderPaths: { f1: 'shared / Team A' },
    usage: { b1: { courseCount: 2, courseIds: ['c1', 'c2'] } },
  });

  it('produces one row per bank with counts, types, media, folder, usage', () => {
    const b1 = rows.find((r) => r.id === 'b1')!;
    expect(b1.questionCount).toBe(3);
    expect(b1.types).toBe('MULTIPLE_CHOICE:2 MATCHING:1');
    expect(b1.mediaCount).toBe(1);
    expect(b1.folderPath).toBe('shared / Team A');
    expect(b1.usedByCourses).toBe(2);
    expect(b1.exampleCourseIds).toEqual(['c1', 'c2']);
  });

  it('resolves author from profiles, falls back to raw id otherwise', () => {
    const b1 = rows.find((r) => r.id === 'b1')!;
    expect(b1.author).toBe('Ada Lovelace');
    expect(b1.authorEmail).toBe('ada@x.io');
    expect(b1.lastEditedBy).toBe('u2'); // unknown id → raw
  });

  it('carries deleted flag and sorts most-used first', () => {
    expect(rows[0]?.id).toBe('b1'); // used by 2 courses
    const b2 = rows.find((r) => r.id === 'b2')!;
    expect(b2.deleted).toBe(true);
    expect(b2.usedByCourses).toBe(0);
    expect(b2.folderPath).toBe(''); // f2 unresolved
  });
});
