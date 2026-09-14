import { describe, expect, it } from 'vitest';
import type { BlueprintBlock } from '@/core/creator/blueprint';
import {
  LABELED_GRAPHIC_PLACEHOLDER_IMAGE,
  mapIntent,
  mapLesson,
  markerPositions,
  type Mints,
} from './map';

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

  it('maps continue to the divider donor and attachment placeholders to flagged text', () => {
    const cont = mapIntent({ kind: 'continue', label: 'SĀKT' }, mints()).blocks[0]!;
    expect(cont).toMatchObject({ family: 'continue', variant: 'continue', type: 'divider' });
    expect((cont.items as Record<string, unknown>[])[0]!).toMatchObject({
      type: '',
      title: 'SĀKT',
      buttonColor: 'brand',
    });
    expect(Object.keys(cont).sort()).toEqual(EDITOR_KEYS);

    const att = mapIntent(
      { kind: 'attachment-placeholder', label: 'Pievienot failu: "Instrukcija"' },
      mints(),
    ).blocks[0]!;
    expect(att.variant).toBe('paragraph');
    expect((att.items as Record<string, unknown>[])[0]!.paragraph).toContain('📎');
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

describe('mapIntent — docx-storyboard additions (fill-in, matching, table, labeled graphic)', () => {
  it('maps fill-in-the-blank to one knowledgeCheck/fillin block per question, answers all correct', () => {
    const { blocks } = mapIntent(
      {
        kind: 'fill-in-the-blank',
        heading: 'Ieraksti',
        intro: [],
        questions: [
          { stem: '<p>Pirmais posms ir _____.</p>', answers: ['Sākums', 'sākums'], feedback: '<p>fb</p>' },
          { stem: '<p>Otrais?</p>', answers: ['Vidus'] },
        ],
      },
      mints(),
    );
    expect(blocks.map((b) => `${b.family}/${b.variant}`)).toEqual([
      'text/heading paragraph',
      'knowledgeCheck/fillin',
      'knowledgeCheck/fillin',
    ]);
    const item = (blocks[1]!.items as Record<string, unknown>[])[0]!;
    expect(item).toMatchObject({ type: 'FILL_IN_THE_BLANK', title: '<p>Pirmais posms ir _____.</p>', feedback: '<p>fb</p>' });
    // Accepted answers are PLAIN text (they must equal what the learner types) — never <p>-wrapped.
    expect(item.answers).toEqual([
      expect.objectContaining({ title: 'Sākums', correct: true }),
      expect.objectContaining({ title: 'sākums', correct: true }),
    ]);
    expect((blocks[2]!.items as Record<string, unknown>[])[0]!).not.toHaveProperty('feedback');
    expect(Object.keys(blocks[1]!).sort()).toEqual(EDITOR_KEYS);
  });

  it('maps matching to one MATCHING item: left → title, right → matchTitle, all correct', () => {
    const { blocks } = mapIntent(
      {
        kind: 'matching',
        intro: [],
        stem: '<p>Savieno</p>',
        pairs: [
          { left: 'ECB', right: 'monetārā politika' },
          { left: 'Revīzijas palāta', right: 'ārējā revīzija' },
        ],
      },
      mints(),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'knowledgeCheck', family: 'knowledgeCheck', variant: 'matching' });
    const item = (blocks[0]!.items as Record<string, unknown>[])[0]!;
    expect(item.type).toBe('MATCHING');
    expect(item.answers).toEqual([
      expect.objectContaining({ title: 'ECB', matchTitle: 'monetārā politika', correct: true }),
      expect.objectContaining({ title: 'Revīzijas palāta', matchTitle: 'ārējā revīzija', correct: true }),
    ]);
    expect(Object.keys(blocks[0]!).sort()).toEqual(EDITOR_KEYS);
  });

  it('maps table to text/table whose paragraph is th/td HTML with cells inserted verbatim', () => {
    const { blocks } = mapIntent(
      {
        kind: 'table',
        intro: [],
        columns: ['<strong>A</strong>', 'B'],
        rows: [
          ['1', '<em>2</em>'],
          ['3', ''],
        ],
      },
      mints(),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'text', family: 'text', variant: 'table' });
    expect((blocks[0]!.items as Record<string, unknown>[])[0]!.paragraph).toBe(
      '<table><thead><tr><th><strong>A</strong></th><th>B</th></tr></thead>' +
        '<tbody><tr><td>1</td><td><em>2</em></td></tr><tr><td>3</td><td></td></tr></tbody></table>',
    );
  });

  it('maps labeled-graphic onto the built-in placeholder image with generated, non-overlapping markers', () => {
    const { blocks, notes } = mapIntent(
      {
        kind: 'labeled-graphic',
        intro: [],
        items: [
          { title: 'A', body: '<p>a</p>' },
          { title: 'B', body: '<p>b</p>' },
          { title: 'C', body: '<p>c</p>' },
        ],
      },
      mints(),
    );
    expect(blocks).toHaveLength(1);
    const lg = blocks[0]! as Record<string, unknown>;
    expect(lg).toMatchObject({ type: 'interactive', family: 'interactive-fullscreen', variant: 'labeledgraphic' });
    // Library key only — no plane-specific `src`, nothing under rise/courses/.
    expect(lg.media).toEqual({ image: { key: LABELED_GRAPHIC_PLACEHOLDER_IMAGE, type: 'image' } });
    expect(Object.keys(lg).sort()).toEqual([...EDITOR_KEYS, 'media'].sort());
    const items = lg.items as Record<string, unknown>[];
    expect(items.map((i) => Object.keys(i).sort())).toEqual(
      items.map(() => ['description', 'icon', 'id', 'isActive', 'title', 'x', 'y']),
    );
    expect(items[0]).toMatchObject({ icon: '01', isActive: false, title: 'A', description: '<p>a</p>' });
    const positions = new Set(items.map((i) => `${i.x},${i.y}`));
    expect(positions.size).toBe(3);
    for (const i of items) {
      expect(Number(i.x)).toBeGreaterThan(0);
      expect(Number(i.x)).toBeLessThan(100);
      expect(Number(i.y)).toBeGreaterThan(0);
      expect(Number(i.y)).toBeLessThan(100);
    }
    expect(notes.some((n) => /placeholder image/.test(n))).toBe(true);
  });

  it('spreads markers on a near-square grid for any count', () => {
    expect(markerPositions(1)).toEqual([{ x: '50.00', y: '50.00' }]);
    expect(markerPositions(4).map((p) => p.x)).toEqual(['25.00', '75.00', '25.00', '75.00']);
    expect(new Set(markerPositions(7).map((p) => `${p.x},${p.y}`)).size).toBe(7);
  });
});

describe('mapLesson', () => {
  it('threads provenance into per-block records and prefixes notes with the slide', () => {
    const planned: BlueprintBlock[] = [
      {
        intent: { kind: 'text', paragraphs: ['<p>a</p>'] },
        sourceRef: { label: 'Storyboard slide 7', slideNo: 7, row: 9, excerpt: 'a' },
        notes: ['kaut kas'],
      },
    ];
    const lesson = mapLesson('Tēma X', planned, mints());
    expect(lesson.records).toEqual([
      { blockId: lesson.blocks[0]!.id, slideNo: 7, kind: 'text', blueprintIndex: 0 },
    ]);
    expect(lesson.notes[0]!).toBe('[slaids 7] kaut kas');
  });

  it('prefixes notes with the table row when a docx storyboard carries no slide number', () => {
    const lesson = mapLesson(
      'Tēma Y',
      [
        {
          intent: { kind: 'text', paragraphs: ['<p>a</p>'] },
          sourceRef: { label: 'Row 12', slideNo: null, row: 12, excerpt: 'a' },
          notes: ['piezīme'],
        },
      ],
      mints(),
    );
    expect(lesson.notes[0]!).toBe('[rinda 12] piezīme');
    expect(lesson.records[0]!.slideNo).toBeNull();
  });
});
