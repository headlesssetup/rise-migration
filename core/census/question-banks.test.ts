import { describe, expect, it } from 'vitest';
import {
  buildBankCatalog,
  extractBankRefs,
  extractQuestions,
} from './question-banks';

describe('extractBankRefs', () => {
  it('reads array, wrapper, and id-map shapes', () => {
    expect(extractBankRefs([{ id: 'a', title: 'A' }]).map((b) => b.id)).toEqual([
      'a',
    ]);
    expect(extractBankRefs({ questionBanks: [{ id: 'b' }] }).map((b) => b.id)).toEqual(
      ['b'],
    );
    expect(extractBankRefs({ content: { x: { id: 'c' } } }).map((b) => b.id)).toEqual(
      ['c'],
    );
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
});
