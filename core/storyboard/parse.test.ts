import { describe, expect, it } from 'vitest';
import type { SdCell, SdDoc, SdPara, SdRun } from './docx';
import { parseStoryboard } from './parse';
import { StoryboardError } from './types';

// --- SdDoc fixture helpers -------------------------------------------------

function runOf(text: string, f: Partial<SdRun> = {}): SdRun {
  return { text, bold: false, italic: false, ...f };
}

function p(
  text: string,
  opts: Partial<SdRun> & { numId?: string; style?: string; runs?: SdRun[] } = {},
): SdPara {
  const { numId, style, runs, ...fmt } = opts;
  return {
    runs: runs ?? [runOf(text, fmt)],
    ...(style ? { style } : {}),
    ...(numId !== undefined ? { numId } : {}),
  };
}

function cell(...paras: SdPara[]): SdCell {
  return { paras };
}

/** A 5-cell content row: [slide-number cell, experience, audio, screen, comments]. */
function row(experience: string, screen: SdPara[], opts: { audio?: string; comments?: string } = {}): SdCell[] {
  return [
    cell({ runs: [], numId: '4' }), // auto-numbered slide cell (no text)
    cell(p(experience)),
    cell(p(opts.audio ?? '–')),
    cell(...screen),
    cell(p(opts.comments ?? '')),
  ];
}

function divider(title: string): SdCell[] {
  return [cell(p(title, { style: 'Heading2' }))];
}

const HEADER: SdCell[] = [
  cell(p('Slaida nr.')),
  cell(p('Mācību pieredze')),
  cell(p('Audio teksts')),
  cell(p('Teksts uz ekrāna')),
  cell(p('Komentāri')),
];

function doc(rows: SdCell[][]): SdDoc {
  return {
    body: [
      { kind: 'para', ...p('1.1. Testa kurss', { style: 'Heading1' }) },
      { kind: 'table', rows: [HEADER, ...rows] },
    ],
    numFmt: { '4': 'decimal', '7': 'bullet', '8': 'decimal' },
  };
}

const GREEN = { color: '00B050' };

// --- tests ------------------------------------------------------------------

describe('parseStoryboard — structure', () => {
  it('takes the course title from Heading1 and lessons from divider rows', () => {
    const planned = parseStoryboard(
      doc([
        divider('Tēma 1: Pirmā'),
        row('Teksts', [p('Sveiki')]),
        divider('Tēma 2: Otrā'),
        row('Teksts', [p('Atkal')]),
      ]),
    );
    expect(planned.title).toBe('1.1. Testa kurss');
    expect(planned.lessons.map((l) => l.title)).toEqual(['Tēma 1: Pirmā', 'Tēma 2: Otrā']);
    expect(planned.lessons[0]!.blocks).toHaveLength(1);
    expect(planned.unparsed).toEqual([]);
  });

  it('fails loudly without a Heading1 or without the storyboard table', () => {
    expect(() =>
      parseStoryboard({ body: [{ kind: 'table', rows: [HEADER] }], numFmt: {} }),
    ).toThrow(StoryboardError);
    expect(() =>
      parseStoryboard({
        body: [{ kind: 'para', ...p('T', { style: 'Heading1' }) }],
        numFmt: {},
      }),
    ).toThrow(/Slaida nr/);
  });

  it('computes rendered slide numbers from the auto-number list, not row index', () => {
    const twoNumbered: SdCell[] = [
      cell({ runs: [], numId: '4' }, { runs: [], numId: '4' }), // consumes 1 AND 2
      cell(p('Teksts')),
      cell(p('–')),
      cell(p('A')),
      cell(p('')),
    ];
    const planned = parseStoryboard(doc([divider('Tēma'), twoNumbered, row('Teksts', [p('B')])]));
    const b1 = planned.lessons[0]!.blocks[0]!;
    const b2 = planned.lessons[0]!.blocks[1]!;
    expect(b1.provenance.slideNo).toBe(1);
    expect(b2.provenance.slideNo).toBe(3); // shifted past the double-numbered row
  });

  it('skips HIDDEN (vanish) numbered paragraphs — they consume no slide number', () => {
    // The VAS SD's first slide cell holds a hidden numbered paragraph before
    // the real one; Word renders one number, so the parser must too.
    const withHidden: SdCell[] = [
      cell({ runs: [], numId: '4', hidden: true }, { runs: [], numId: '4' }),
      cell(p('Teksts')),
      cell(p('–')),
      cell(p('A')),
      cell(p('')),
    ];
    const planned = parseStoryboard(doc([divider('Tēma'), withHidden, row('Teksts', [p('B')])]));
    expect(planned.lessons[0]!.blocks[0]!.provenance.slideNo).toBe(1);
    expect(planned.lessons[0]!.blocks[1]!.provenance.slideNo).toBe(2);
  });

  it('flags rows with an unexpected cell count as unparsed', () => {
    const bad = [cell({ runs: [], numId: '4' }), cell(p('Teksts')), cell(p('x'))];
    const planned = parseStoryboard(doc([divider('T'), bad]));
    expect(planned.unparsed).toHaveLength(1);
    expect(planned.unparsed[0]!.reason).toMatch(/3 šūnas/);
  });
});

describe('parseStoryboard — classification', () => {
  it('routes storyline/mighty (incl. via comments) to placeholders with slide refs', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Uzdevums (teksta ievade)', [p('X')], { comments: '4 jautājumi (Rise Mighty)' }),
      ]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    expect(b.intent.kind).toBe('storyline-placeholder');
    if (b.intent.kind !== 'storyline-placeholder') return;
    expect(b.intent.label).toContain('slaidu nr. 1');
  });

  it('routes video rows to video placeholders and captures the filming script', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Eksperta video lekcija (~5 min)\nŽaneta', [p('Ekrāna teksts')], {
          audio: 'Aptuvenais teksts: runā brīvi…',
        }),
      ]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    expect(b.intent.kind).toBe('video-placeholder');
    expect(planned.production).toHaveLength(1);
    expect(planned.production[0]!.audioText).toContain('runā brīvi');
  });

  it('picks the FIRST named widget when the designer offers several', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Rise elements (interaktīvs)\nProcess, Accordion', [
          p('V', { bold: true }),
          p('apraksts'),
          p('Solis 1', { bold: true }),
          p('viens'),
        ]),
      ]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    expect(b.intent.kind).toBe('process');
    expect(b.notes.some((n) => n.includes('vairāki elementi'))).toBe(true);
  });

  it('maps Labeled Graphic to flashcards with the decision note', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Rise elements: Labeled Graphic', [
          p('V', { bold: true }),
          p('apraksts'),
          p('Kartīte', { bold: true }),
          p('saturs'),
        ]),
      ]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    expect(b.intent.kind).toBe('flashcards');
    expect(b.notes.some((n) => n.includes('Flipcards'))).toBe(true);
  });

  it('sends an interactive row without a recognized widget to unparsed', () => {
    const planned = parseStoryboard(
      doc([divider('T'), row('Rise elements (interaktīva karte)', [p('Karte')])]),
    );
    expect(planned.lessons[0]!.blocks).toHaveLength(0);
    expect(planned.unparsed[0]!.reason).toMatch(/bez atpazīstama Rise bloka/);
  });
});

describe('parseStoryboard — cell parsing', () => {
  it('parses text with heading, drops buttons and italic designer notes (noted)', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Tēmas ievads', [
          p('Virsraksts', { bold: true }),
          p('Rindkopa viena.'),
          p('Neredzama piezīme', { italic: true }),
          p('[TĀLĀK]'),
        ]),
      ]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    expect(b.intent).toMatchObject({ kind: 'text', heading: 'Virsraksts' });
    if (b.intent.kind !== 'text') return;
    expect(b.intent.paragraphs).toEqual(['<p>Rindkopa viena.</p>']);
    expect(b.notes.some((n) => n.includes('[TĀLĀK]'))).toBe(true);
    expect(b.notes.some((n) => n.includes('Neredzama piezīme'))).toBe(true);
  });

  it('turns a text row with list paragraphs into a list intent (ordered by numFmt)', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Teksts + saraksts', [
          p('Virsraksts', { bold: true }),
          p('Ievads.'),
          p('Pirmais', { numId: '7' }),
          p('Otrais', { numId: '7' }),
        ]),
      ]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    expect(b.intent).toMatchObject({ kind: 'list', ordered: false });
    if (b.intent.kind !== 'list') return;
    expect(b.intent.items).toEqual(['<p>Pirmais</p>', '<p>Otrais</p>']);
  });

  it('parses accordion items from bold titles + following bodies', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Rise elements: Accordion', [
          p('Bloka virsraksts', { bold: true }),
          p('Klikšķini uz katras!'),
          p('Panelis A', { bold: true }),
          p('A apraksts.'),
          p('Panelis B', { bold: true }),
          p('B apraksts.'),
        ]),
      ]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    if (b.intent.kind !== 'accordion') throw new Error('expected accordion');
    expect(b.intent.heading).toBe('Bloka virsraksts');
    expect(b.intent.items).toEqual([
      { title: 'Panelis A', body: '<p>A apraksts.</p>' },
      { title: 'Panelis B', body: '<p>B apraksts.</p>' },
    ]);
  });

  it('parses bold-bracket items ([Panelis] = clickable element, [TĀLĀK] = button)', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Rise elements: Tabs', [
          p('Kompetenču jomas', { bold: true }),
          p('Atver katru cilni.'),
          p('[Ekskluzīvā kompetence]', { bold: true }),
          p('Muitas savienība; monetārā politika.'),
          p('Arī starptautiski nolīgumi.'),
          p('[Dalītā kompetence]', { bold: true }),
          p('Iekšējais tirgus; vide. Galvenais jautājums: kas?', { bold: true }),
          p('[TĀLĀK]'),
        ]),
      ]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    if (b.intent.kind !== 'tabs') throw new Error('expected tabs');
    expect(b.intent.heading).toBe('Kompetenču jomas');
    expect(b.intent.items).toHaveLength(2);
    expect(b.intent.items[0]!.title).toBe('Ekskluzīvā kompetence');
    expect(b.intent.items[0]!.body).toBe(
      '<p>Muitas savienība; monetārā politika.</p><p>Arī starptautiski nolīgumi.</p>',
    );
    // A bold body paragraph must NOT start a new item in bracket mode.
    expect(b.intent.items[1]!.body).toContain('Galvenais jautājums');
    expect(b.notes.some((n) => n.includes('[TĀLĀK]'))).toBe(true);
  });

  it('parses timeline events from bracket paragraphs', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Rise elements: Timeline', [
          p('Līgumu attīstība', { bold: true }),
          p('Nospied uz katra līguma.'),
          p('[1951/1952: EOTK dibināšana]'),
          p('[1992/1993: Māstrihtas līgums]'),
          p('[TĀLĀK]'),
        ]),
      ]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    if (b.intent.kind !== 'timeline') throw new Error('expected timeline');
    expect(b.intent.events).toEqual([
      { date: '1951/1952', title: '', body: '<p>EOTK dibināšana</p>' },
      { date: '1992/1993', title: '', body: '<p>Māstrihtas līgums</p>' },
    ]);
    expect(b.notes.some((n) => n.includes('[TĀLĀK]'))).toBe(true);
  });

  it('parses sorting piles (bold) and cards (list), tolerating italics', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Uzdevums (sorting activity)', [
          p('Uzdevums: kurā kategorijā?', { bold: true }),
          p('Ievelc katru jomu.'),
          p('Kartītes parādās sajauktā secībā.', { italic: true }),
          p('Ekskluzīvā', { bold: true, italic: true }),
          p('muita', { numId: '7', italic: true }),
          p('Dalītā', { bold: true, italic: true }),
          p('vide', { numId: '7', italic: true }),
          p('transports', { numId: '7', italic: true }),
        ]),
      ]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    if (b.intent.kind !== 'sorting') throw new Error('expected sorting');
    expect(b.intent.piles).toEqual(['Ekskluzīvā', 'Dalītā']);
    expect(b.intent.cards).toEqual([
      { title: 'muita', pile: 1 },
      { title: 'vide', pile: 2 },
      { title: 'transports', pile: 2 },
    ]);
  });

  it('parses a multi-question knowledge check with green = correct + feedback', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Zināšanu pārbaude', [
          p('Pārbaudi sevi: LES vai LESD?', { bold: true }),
          p('Izvēlies pareizo.'),
          p('1. jautājums', { bold: true }),
          p('Savienība ir dibināta…'),
          p('LES', { numId: '8', ...GREEN }),
          p('LESD', { numId: '8' }),
          p('Atgriezeniskā saite:', { italic: true }),
          p('Šis ir LES 2. pants.'),
          p('2. jautājums', { bold: true }),
          p('Regulas ir vispārpiemērojamas…'),
          p('LES', { numId: '8' }),
          p('LESD', { numId: '8', ...GREEN }),
        ]),
      ]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    if (b.intent.kind !== 'knowledge-check') throw new Error('expected KC');
    expect(b.intent.heading).toBe('Pārbaudi sevi: LES vai LESD?');
    expect(b.intent.questions).toHaveLength(2);
    const q1 = b.intent.questions[0]!;
    const q2 = b.intent.questions[1]!;
    expect(q1.options).toEqual([
      { text: 'LES', correct: true },
      { text: 'LESD', correct: false },
    ]);
    expect(q1.feedback).toContain('LES 2. pants');
    expect(q2.options[1]!.correct).toBe(true);
  });

  it('detects multiple-response questions (several green options)', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Zināšanu pārbaude', [
          p('Kurās jomās ekskluzīva kompetence?', { bold: true }),
          p('muita', { numId: '8', ...GREEN }),
          p('monetārā politika', { numId: '8', ...GREEN }),
          p('tūrisms', { numId: '8' }),
        ]),
      ]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    if (b.intent.kind !== 'knowledge-check') throw new Error('expected KC');
    expect(b.intent.questions[0]!.options.filter((o) => o.correct)).toHaveLength(2);
  });

  it('refuses a quiz whose options carry no green marking (unparsed, never guessed)', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Zināšanu pārbaude', [
          p('Jautājums?', { bold: true }),
          p('A', { numId: '8' }),
          p('B', { numId: '8' }),
        ]),
      ]),
    );
    expect(planned.lessons[0]!.blocks).toHaveLength(0);
    expect(planned.unparsed[0]!.reason).toMatch(/zaļā/);
  });

  it('falls back to text (with a review note) for an uzdevums row without options', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Teksts + kopsavilkums + uzdevums', [p('Apraksts bez atbilžu variantiem.')]),
      ]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    expect(b.intent.kind).toBe('text');
    expect(b.notes.some((n) => n.includes('pārnests kā teksts'))).toBe(true);
  });

  it('keeps hyperlinks in text paragraphs', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Resursu bloks (saites)', [
          p('Kur atrast līgumus', { bold: true }),
          { runs: [{ text: 'Atvērt LES', bold: false, italic: false, link: 'https://eur-lex.europa.eu/x' }] },
        ]),
      ]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    if (b.intent.kind !== 'links') throw new Error('expected links');
    expect(b.intent.heading).toBe('Kur atrast līgumus');
    expect(b.intent.buttons).toEqual([
      { label: 'Atvērt LES', destination: 'https://eur-lex.europa.eu/x', description: '' },
    ]);
  });

  it('parses a resources row into button groups (bold title + description + link)', () => {
    const planned = parseStoryboard(
      doc([
        divider('T'),
        row('Resursu bloks (saites)', [
          p('Kur atrast līgumus', { bold: true }),
          p('Ikdienas darbā izmanto konsolidēto versiju.'),
          p('LES', { bold: true }),
          p('EUR-Lex konsolidētā versija.'),
          { runs: [{ text: 'Atvērt LES', bold: false, italic: false, link: 'https://eur-lex.europa.eu/les' }] },
          p('LESD', { bold: true }),
          {
            // Bracketed button form, hyperlink inside: `[Atvērt LESD]`.
            runs: [
              { text: '[', bold: false, italic: false },
              { text: 'Atvērt LESD', bold: false, italic: false, link: 'https://eur-lex.europa.eu/lesd' },
              { text: ']', bold: false, italic: false },
            ],
          },
          p('[TĀLĀK]'),
        ]),
      ]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    if (b.intent.kind !== 'links') throw new Error('expected links');
    expect(b.intent.intro).toEqual(['<p>Ikdienas darbā izmanto konsolidēto versiju.</p>']);
    expect(b.intent.buttons).toEqual([
      {
        label: 'Atvērt LES',
        destination: 'https://eur-lex.europa.eu/les',
        description: '<p><strong>LES</strong></p><p>EUR-Lex konsolidētā versija.</p>',
      },
      {
        label: 'Atvērt LESD',
        destination: 'https://eur-lex.europa.eu/lesd',
        description: '<p><strong>LESD</strong></p>',
      },
    ]);
  });

  it('falls back to text (with a note) when a links row has no hyperlinks', () => {
    const planned = parseStoryboard(
      doc([divider('T'), row('Saite uz papildu informāciju', [p('Skat. materiālus bibliotēkā.')])]),
    );
    const b = planned.lessons[0]!.blocks[0]!;
    expect(b.intent.kind).toBe('text');
    expect(b.notes.some((n) => n.includes('nav nevienas hipersaites'))).toBe(true);
  });
});
