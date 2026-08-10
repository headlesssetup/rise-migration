import { describe, expect, it } from 'vitest';
import { mapIntent, mapLesson, type Mints } from './map';
import type { PlannedBlock } from './types';

/** Deterministic mints for stable assertions. */
function mints(): Mints {
  let c = 0;
  let u = 0;
  return {
    cuid: () => `c${String(++c).padStart(24, '0')}`,
    uuid: () => `00000000-0000-4000-8000-${String(++u).padStart(12, '0')}`,
  };
}

/** The pristine editor CREATE_BLOCKS key set (capture_creation4aug). */
const EDITOR_KEYS = ['family', 'id', 'items', 'settings', 'type', 'variant'];

describe('mapIntent — block shapes', () => {
  it('emits exactly the editor key set on every block (plus piles on sorting)', () => {
    const cases = [
      mapIntent({ kind: 'text', paragraphs: ['<p>x</p>'] }, mints()),
      mapIntent({ kind: 'note', paragraphs: ['<p>x</p>'] }, mints()),
      mapIntent(
        { kind: 'accordion', intro: [], items: [{ title: 'a', body: '<p>b</p>' }] },
        mints(),
      ),
      mapIntent({ kind: 'video-placeholder', label: 'v' }, mints()),
      mapIntent(
        {
          kind: 'knowledge-check',
          intro: [],
          questions: [{ stem: '<p>q</p>', options: [{ text: 'a', correct: true }] }],
        },
        mints(),
      ),
    ];
    for (const { blocks } of cases) {
      for (const b of blocks) expect(Object.keys(b).sort()).toEqual(EDITOR_KEYS);
    }
    const sorting = mapIntent(
      { kind: 'sorting', intro: [], piles: ['P'], cards: [{ title: 'c', pile: 1 }] },
      mints(),
    );
    expect(Object.keys(sorting.blocks[0]!).sort()).toEqual(
      [...EDITOR_KEYS, 'piles'].sort(),
    );
  });

  it('maps text with heading to heading-paragraph, else paragraph', () => {
    const withH = mapIntent(
      { kind: 'text', heading: 'V & X', paragraphs: ['<p>a</p>'] },
      mints(),
    ).blocks[0]!;
    expect(withH.variant).toBe('heading paragraph');
    expect((withH.items as Record<string, unknown>[])[0]!.heading).toBe(
      '<strong>V &amp; X</strong>',
    );
    const noH = mapIntent({ kind: 'text', paragraphs: ['<p>a</p>'] }, mints()).blocks[0]!;
    expect(noH.variant).toBe('paragraph');
  });

  it('maps a list with heading + outro to three blocks in order', () => {
    const { blocks } = mapIntent(
      {
        kind: 'list',
        ordered: true,
        heading: 'H',
        intro: ['<p>i</p>'],
        items: ['<p>1</p>', '<p>2</p>'],
        outro: ['<p>pēc</p>'],
      },
      mints(),
    );
    expect(blocks.map((b) => `${b.family}/${b.variant}`)).toEqual([
      'text/heading paragraph',
      'list/numbered',
      'text/paragraph',
    ]);
    const items = blocks[1]!.items as Record<string, unknown>[];
    expect(items[0]).toMatchObject({ number: '1', paragraph: '<p>1</p>' });
    expect(items[1]).toMatchObject({ number: '2' });
  });

  it('maps knowledge-check questions one block per question, MR when >1 correct', () => {
    const { blocks } = mapIntent(
      {
        kind: 'knowledge-check',
        heading: 'Pārbaudi sevi',
        intro: [],
        questions: [
          {
            stem: '<p>q1</p>',
            options: [
              { text: 'a', correct: true },
              { text: 'b', correct: false },
            ],
            feedback: '<p>fb</p>',
          },
          {
            stem: '<p>q2</p>',
            options: [
              { text: 'a', correct: true },
              { text: 'b', correct: true },
            ],
          },
        ],
      },
      mints(),
    );
    expect(blocks).toHaveLength(3); // lead-in + 2 questions
    const q1 = blocks[1]!;
    const q2 = blocks[2]!;
    expect(q1.variant).toBe('multiple choice');
    const q1item = (q1.items as Record<string, unknown>[])[0]!;
    expect(q1item.type).toBe('MULTIPLE_CHOICE');
    expect(q1item.feedback).toBe('<p>fb</p>');
    expect(
      (q1item.answers as Record<string, unknown>[]).map((a) => a.correct),
    ).toEqual([true, false]);
    expect(q2.variant).toBe('multiple response');
    expect((q2.items as Record<string, unknown>[])[0]!.type).toBe('MULTIPLE_RESPONSE');
  });

  it('maps timeline events and sorting piles/cards faithfully', () => {
    const tl = mapIntent(
      {
        kind: 'timeline',
        intro: [],
        events: [{ date: '1957', title: '', body: '<p>Roma</p>' }],
      },
      mints(),
    ).blocks[0]!;
    expect(tl.family).toBe('interactive-fullscreen');
    expect((tl.items as Record<string, unknown>[])[0]!).toMatchObject({
      date: '1957',
      description: '<p>Roma</p>',
    });

    const so = mapIntent(
      {
        kind: 'sorting',
        intro: [],
        piles: ['A', 'B'],
        cards: [
          { title: 'x', pile: 1 },
          { title: 'y', pile: 2 },
        ],
      },
      mints(),
    ).blocks[0]! as Record<string, unknown>;
    expect(so.piles).toEqual([
      { id: 1, title: 'A' },
      { id: 2, title: 'B' },
    ]);
    expect((so.items as Record<string, unknown>[])[1]!).toMatchObject({ pileId: 2 });
  });

  it('maps a process into a single block with an intro item (no lead-in text block)', () => {
    const { blocks } = mapIntent(
      {
        kind: 'process',
        heading: 'Ceļš',
        intro: ['<p>ievads</p>'],
        items: [{ title: 'Solis 1', body: '<p>a</p>' }],
      },
      mints(),
    );
    expect(blocks).toHaveLength(1);
    const items = blocks[0]!.items as Record<string, unknown>[];
    expect(items[0]).toMatchObject({ type: 'intro', title: 'Ceļš', description: '<p>ievads</p>' });
    expect(items[1]).toMatchObject({ type: 'step', title: 'Solis 1' });
  });

  it('emits an empty video block (no media anywhere) for video placeholders', () => {
    const { blocks, notes } = mapIntent({ kind: 'video-placeholder', label: 'x' }, mints());
    expect(blocks[0]).toMatchObject({ family: 'multimedia', variant: 'video' });
    const item = (blocks[0]!.items as Record<string, unknown>[])[0]!;
    expect(Object.keys(item)).toEqual(['id']);
    expect(notes.some((n) => n.includes('pilots pārbauda'))).toBe(true);
  });

  it('maps note to impact/note and links to a buttons/button stack (donor shapes)', () => {
    const note = mapIntent({ kind: 'note', paragraphs: ['<p>n</p>'] }, mints()).blocks[0]!;
    expect(note).toMatchObject({ family: 'impact', variant: 'note', type: 'text' });
    expect((note.items as Record<string, unknown>[])[0]!.paragraph).toBe('<p>n</p>');

    const { blocks } = mapIntent(
      {
        kind: 'links',
        heading: 'Resursi',
        intro: [],
        buttons: [
          { label: 'Atvērt LES', destination: 'https://x/les', description: '<p>d</p>' },
        ],
        trailing: ['<p>pēc</p>'],
      },
      mints(),
    );
    expect(blocks.map((b) => `${b.family}/${b.variant}`)).toEqual([
      'text/heading paragraph',
      'buttons/button stack',
      'text/paragraph',
    ]);
    expect((blocks[1]!.items as Record<string, unknown>[])[0]!).toMatchObject({
      type: 'link',
      label: 'Atvērt LES',
      destination: 'https://x/les',
      description: '<p>d</p>',
    });
  });

  it('escapes HTML-sensitive text in flashcards and storyline placeholders', () => {
    const fc = mapIntent(
      { kind: 'flashcards', intro: [], items: [{ title: 'a < b', body: '' }] },
      mints(),
    ).blocks[0]!;
    const front = (fc.items as { front: { description: string } }[])[0]!.front;
    expect(front.description).toBe('<p>a &lt; b</p>');

    const sl = mapIntent(
      { kind: 'storyline-placeholder', label: 'skat. slaidu nr. 13 <te>' },
      mints(),
    ).blocks[0]!;
    expect((sl.items as Record<string, unknown>[])[0]!.paragraph).toContain('&lt;te&gt;');
  });
});

describe('mapLesson', () => {
  it('threads provenance into per-block records and prefixes notes with the slide', () => {
    const planned: PlannedBlock[] = [
      {
        intent: { kind: 'text', paragraphs: ['<p>a</p>'] },
        provenance: { slideNo: 7, tableRow: 9, experience: 'Teksts', comments: '', rawScreenText: 'a' },
        notes: ['kaut kas'],
      },
    ];
    const lesson = mapLesson('Tēma X', planned, mints());
    expect(lesson.records).toEqual([
      { blockId: lesson.blocks[0]!.id, slideNo: 7, kind: 'text' },
    ]);
    expect(lesson.notes[0]!).toBe('[slaids 7] kaut kas');
  });
});
