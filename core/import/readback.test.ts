import { describe, it, expect } from 'vitest';
import { verifyBankParity, verifyFolderMap, verifyTypefaceBindings } from './readback';
import type { GetCourseDocument } from '@/shared/types/rise';

describe('verifyBankParity', () => {
  const source = {
    id: 'b1',
    title: 'Anatomy',
    questions: [
      {
        id: 'q1aaaaaaaaaaaaaaaaaaaaaa',
        type: 'MULTIPLE_CHOICE',
        title: 'Pick one',
        correct: 'a1aaaaaaaaaaaaaaaaaaaaaa',
        answers: [
          { id: 'a1aaaaaaaaaaaaaaaaaaaaaa', title: 'Right', correct: true },
          { id: 'a2aaaaaaaaaaaaaaaaaaaaaa', title: 'Wrong', correct: false },
        ],
      },
    ],
  };

  it('passes when the read-back matches modulo regenerated ids', () => {
    const target = {
      id: 'nb1',
      title: 'Anatomy',
      questions: [
        {
          id: 'zzq1aaaaaaaaaaaaaaaaaaaa',
          type: 'MULTIPLE_CHOICE',
          title: 'Pick one',
          correct: 'zza1aaaaaaaaaaaaaaaaaaaa',
          answers: [
            { id: 'zza1aaaaaaaaaaaaaaaaaaaa', title: 'Right', correct: true },
            { id: 'zza2aaaaaaaaaaaaaaaaaaaa', title: 'Wrong', correct: false },
          ],
        },
      ],
    };
    expect(verifyBankParity(source, target)).toEqual({ ok: true, issues: [] });
  });

  it('fails on lost questions, changed content, changed title', () => {
    const r1 = verifyBankParity(source, { title: 'Anatomy', questions: [] });
    expect(r1.issues.map((i) => i.kind)).toContain('bank-question-count');

    const r2 = verifyBankParity(source, {
      title: 'Anatomy',
      questions: [{ ...source.questions[0]!, title: 'Pick two' }],
    });
    expect(r2.issues.map((i) => i.kind)).toContain('bank-question-changed');

    const r3 = verifyBankParity(source, { title: 'Renamed', questions: source.questions });
    expect(r3.issues.map((i) => i.kind)).toContain('bank-title-changed');
  });

  it('fails loudly on an empty/garbage read-back body', () => {
    const r = verifyBankParity(source, null);
    expect(r.ok).toBe(false);
  });
});

describe('verifyFolderMap', () => {
  const srcFolders = [
    { id: 'sf1', name: 'Customer A', parentFolderId: null },
    { id: 'sf2', name: '2024', parentFolderId: 'sf1' },
  ];

  it('passes when every mapped folder exists under its name', () => {
    const map = new Map([
      ['sf1', 'tf1'],
      ['sf2', 'tf2'],
    ]);
    const listing = [
      { id: 'tf1', name: 'Customer A', parentFolderId: 'root' },
      { id: 'tf2', name: '2024', parentFolderId: 'tf1' },
    ];
    expect(verifyFolderMap(map, srcFolders, listing).ok).toBe(true);
  });

  it('reports missing and renamed targets; skips pseudo roots', () => {
    const map = new Map([
      ['sf1', 'tf1'],
      ['sf2', 'all'], // placement default, not a created folder
    ]);
    const r = verifyFolderMap(map, srcFolders, [
      { id: 'tfX', name: 'Customer A', parentFolderId: 'root' },
    ]);
    expect(r.issues).toEqual([
      expect.objectContaining({ kind: 'folder-missing', path: 'folder "Customer A"' }),
    ]);

    const r2 = verifyFolderMap(new Map([['sf1', 'tf1']]), srcFolders, [
      { id: 'tf1', name: 'Kunde A', parentFolderId: 'root' },
    ]);
    expect(r2.issues.map((i) => i.kind)).toEqual(['folder-renamed']);
  });
});

describe('verifyTypefaceBindings', () => {
  const doc = (
    bindings: Record<string, string>,
    typefaces: Record<string, string>,
  ): GetCourseDocument => ({ course: { id: 'x', ...bindings, typefaces } }) as never;

  it('passes when the slot fonts resolve to the same NAME under different ids', () => {
    const source = doc(
      { headingTypefaceId: 'srcInter00000000000000000000000', uiTypefaceId: 'srcInter00000000000000000000000' },
      { srcInter00000000000000000000000: 'Inter' },
    );
    const target = doc(
      { headingTypefaceId: 'tgtInter11111111111111111111111', uiTypefaceId: 'tgtInter11111111111111111111111' },
      { tgtInter11111111111111111111111: 'Inter' },
    );
    const r = verifyTypefaceBindings(source, target);
    expect(r.ok).toBe(true);
    expect(r.expected).toEqual([]);
  });

  it('catches the WRONG font and a missing binding', () => {
    const source = doc({ headingTypefaceId: 'a'.repeat(30) }, { ['a'.repeat(30)]: 'Inter' });
    const wrong = doc({ headingTypefaceId: 'b'.repeat(30) }, { ['b'.repeat(30)]: 'Lato' });
    expect(verifyTypefaceBindings(source, wrong).issues.map((i) => i.kind)).toEqual([
      'typeface-binding-changed',
    ]);
    const missing = doc({}, {});
    expect(verifyTypefaceBindings(source, missing).issues.map((i) => i.kind)).toEqual([
      'typeface-unresolved',
    ]);
  });

  it('downgrades divergences to expected when the import flagged typefaces', () => {
    const source = doc({ headingTypefaceId: 'a'.repeat(30) }, { ['a'.repeat(30)]: 'CustomFont' });
    const target = doc({}, {});
    const r = verifyTypefaceBindings(source, target, true);
    expect(r.ok).toBe(true);
    expect(r.expected.map((i) => i.kind)).toEqual(['typeface-unresolved']);
  });

  it('skips slots the source leaves unbound', () => {
    const r = verifyTypefaceBindings(doc({}, {}), doc({}, {}));
    expect(r.ok).toBe(true);
  });
});
