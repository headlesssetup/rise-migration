// SBDOC renderer tests — model rendering + the docx ROUND-TRIP: every SBDOC
// we emit must be readable by our own SD docx reader (parseSdDocx), which is
// also how a future edited-SBDOC parser will consume it.

import { describe, expect, it } from 'vitest';
import type { GetCourseDocument } from '@/shared/types/rise';
import { cellText, paraText, parseSdDocx, type SdBodyPara, type SdTable } from '../docx';
import { writeStoryboardDocx } from './docx-write';
import { renderCourseModel } from './from-course';
import { htmlToParas, htmlToText } from './html';
import { fnv1a8 } from './model';

const OPTS = { generatedAt: '2026-08-12T00:00:00.000Z', toolVersion: '0.7.0-test' };

// ------------------------------------------------------------------- html ---

describe('htmlToParas', () => {
  it('splits paragraphs and keeps bold/italic/link formatting', () => {
    const paras = htmlToParas(
      '<p>Plain <strong>bold</strong> and <em>italic</em>.</p><p><a href="https://x.example/a?b=1&amp;c=2">link</a></p>',
    );
    expect(paras).toHaveLength(2);
    expect(paras[0]!.runs).toEqual([
      { text: 'Plain ' },
      { text: 'bold', bold: true },
      { text: ' and ' },
      { text: 'italic', italic: true },
      { text: '.' },
    ]);
    expect(paras[1]!.runs).toEqual([{ text: 'link', link: 'https://x.example/a?b=1&c=2' }]);
  });

  it('maps ul/ol to list kinds and decodes entities', () => {
    const paras = htmlToParas('<ul><li>viens &amp; divi</li></ul><ol><li>tr&#299;s</li></ol>');
    expect(paras).toEqual([
      { runs: [{ text: 'viens & divi' }], list: 'bullet' },
      { runs: [{ text: 'trīs' }], list: 'number' },
    ]);
  });

  it('keeps <br> as a newline inside the paragraph and drops empty paragraphs', () => {
    const paras = htmlToParas('<p>a<br>b</p><p>   </p><p></p>');
    expect(paras).toHaveLength(1);
    expect(paras[0]!.runs.map((r) => r.text).join('')).toBe('a\nb');
  });

  it('unwraps unknown tags and tolerates nested same-format tags', () => {
    expect(htmlToText('<p><span class="x"><strong><b>t</b></strong></span>ail</p>')).toBe('tail');
  });
});

// ------------------------------------------------------------------ model ---

function fixtureDoc(): GetCourseDocument {
  return {
    course: { id: 'CRS1', title: 'Testa kurss', type: null },
    lessons: [
      { id: 'les-sec', type: 'section', position: 0, title: '1. modulis', items: [] },
      {
        id: 'les-1',
        type: 'blocks',
        position: 1,
        title: 'Tēma 1.1',
        items: [
          {
            id: 'blk-text',
            type: 'text',
            family: 'text',
            variant: 'heading paragraph',
            items: [{ id: 'i1', heading: '<strong>Virsraksts</strong>', paragraph: '<p>Rindkopa ar <em>slīprakstu</em>.</p>' }],
            settings: {},
          },
          {
            id: 'blk-list',
            type: 'list',
            family: 'list',
            variant: 'numbered',
            items: [
              { id: 'i1', number: '1', paragraph: '<p>Pirmais</p>' },
              { id: 'i2', number: '2', paragraph: '<p>Otrais</p>' },
            ],
            settings: {},
          },
          {
            id: 'blk-acc',
            type: 'interactive',
            family: 'interactive',
            variant: 'accordion',
            items: [
              { id: 'i1', title: 'Panelis A', description: '<p>A saturs</p>' },
              { id: 'i2', title: 'Panelis B', description: '<p>B saturs</p>' },
            ],
            settings: {},
          },
          {
            id: 'blk-kc',
            type: 'knowledgeCheck',
            family: 'knowledgeCheck',
            variant: 'multiple choice',
            items: [
              {
                id: 'q1',
                type: 'MULTIPLE_CHOICE',
                title: '<p>Cik ir 2+2?</p>',
                answers: [
                  { id: 'a1', title: '<p>3</p>', correct: false },
                  { id: 'a2', title: '<p>4</p>', correct: true, feedback: '<p>Tieši tā!</p>' },
                ],
                feedback: '<p>Pamata aritmētika.</p>',
              },
            ],
            settings: {},
          },
          {
            id: 'blk-btn',
            type: 'interactive',
            family: 'buttons',
            variant: 'button stack',
            items: [{ id: 'i1', type: 'link', label: 'Materiāls', description: 'PDF', destination: 'https://x.example/doc' }],
            settings: {},
          },
          {
            id: 'blk-img',
            type: 'image',
            family: 'image',
            variant: 'full',
            items: [
              {
                id: 'i1',
                caption: 'Attēla paraksts',
                media: { image: { key: 'rise/courses/CRS1/imgabc.png', type: 'image' } },
              },
            ],
            settings: {},
          },
          {
            id: 'blk-new',
            type: 'future',
            family: 'hologram',
            variant: 'volumetric',
            items: [{ id: 'i1', title: 'Nākotnes bloks' }],
            settings: {},
          },
          {
            id: 'blk-sort',
            type: 'interactive',
            family: 'interactive-fullscreen',
            variant: 'sorting',
            piles: [
              { id: 1, title: 'Augļi' },
              { id: 2, title: 'Dārzeņi' },
            ],
            items: [
              { id: 'c1', title: 'Ābols', pileId: 1 },
              { id: 'c2', title: 'Burkāns', pileId: 2 },
            ],
            settings: {},
          },
        ],
      },
      {
        id: 'les-quiz',
        type: 'quiz',
        position: 2,
        title: 'Pārbaude',
        items: [
          {
            id: 'blk-q',
            type: 'knowledgeCheck',
            family: 'knowledgeCheck',
            variant: 'multiple choice',
            items: [{ id: 'q1', title: '<p>Quiz jautājums</p>', answers: [] }],
            settings: {},
          },
        ],
      },
    ],
  };
}

describe('renderCourseModel', () => {
  const model = renderCourseModel(fixtureDoc(), OPTS);
  const lesson = model.lessons[1]!;
  const row = (id: string) => {
    const r = lesson.rows.find((x) => x.blockId === id);
    if (!r) throw new Error(`row ${id} missing`);
    return r;
  };

  it('renders course + lesson skeleton with literal ordinals', () => {
    expect(model.courseId).toBe('CRS1');
    expect(model.title).toBe('Testa kurss');
    expect(model.locale).toBeNull();
    expect(model.lessons).toHaveLength(3);
    expect(model.lessons[0]!.note).toContain('Section header');
    expect(model.lessons[0]!.rows).toHaveLength(0);
    expect(lesson.rows.map((r) => r.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(model.blockCount).toBe(9);
  });

  it('classifies fidelity per the format spec', () => {
    expect(row('blk-text').fidelity).toBe('edit');
    expect(row('blk-list').fidelity).toBe('edit');
    expect(row('blk-acc').fidelity).toBe('edit');
    expect(row('blk-kc').fidelity).toBe('edit');
    expect(row('blk-btn').fidelity).toBe('edit');
    expect(row('blk-sort').fidelity).toBe('edit');
    expect(row('blk-img').fidelity).toBe('ro');
    expect(row('blk-new').fidelity).toBe('ro');
    expect(row('blk-new').notes.join(' ')).toContain('Unknown block family');
  });

  it('renders SD conventions: bold titles, green correct, [label] links', () => {
    const acc = row('blk-acc');
    expect(acc.content[0]).toEqual({ runs: [{ text: 'Panelis A', bold: true }] });
    const kc = row('blk-kc');
    const correct = kc.content.find((p) => p.runs.some((r) => r.color === '00B050'));
    expect(correct?.runs[0]?.text).toBe('4');
    expect(correct?.list).toBe('bullet');
    const perAnswer = kc.content.find((p) => p.runs[0]?.text.startsWith('↳'));
    expect(perAnswer?.runs[0]?.italic).toBe(true);
    const btn = row('blk-btn');
    expect(btn.content[0]!.runs[0]).toEqual({ text: '[Materiāls]', link: 'https://x.example/doc' });
    const sort = row('blk-sort');
    expect(sort.content[0]).toEqual({ runs: [{ text: 'Augļi', bold: true }] });
    expect(sort.content[1]).toEqual({ runs: [{ text: 'Ābols' }], list: 'bullet' });
  });

  it('numbered list renders as number-list paragraphs', () => {
    const list = row('blk-list');
    expect(list.content.map((p) => p.list)).toEqual(['number', 'number']);
  });

  it('ro rows extract readable text and media chips', () => {
    const img = row('blk-img');
    expect(img.content.map((p) => paraTextOf(p))).toContain('Attēla paraksts');
    expect(img.notes.some((n) => /^⟦media:image #[0-9a-f]{6}⟧$/.test(n))).toBe(true);
  });

  it('quiz lessons render read-only', () => {
    const quiz = model.lessons[2]!;
    expect(quiz.note).toContain('quiz');
    expect(quiz.rows[0]!.fidelity).toBe('ro');
  });

  it('stamps an 8-hex rev per row', () => {
    for (const r of lesson.rows) expect(r.rev).toMatch(/^[0-9a-f]{8}$/);
  });

  it('escapes reserved ⟦⟧ tokens out of content and flags it', () => {
    const doc = fixtureDoc();
    (doc.lessons![1]!.items![0]!.items![0] as Record<string, unknown>).paragraph =
      '<p>teksts ar ⟦viltus marķieri⟧</p>';
    const m = renderCourseModel(doc, OPTS);
    const text = m.lessons[1]!.rows[0]!.content.map(paraTextOf).join(' ');
    expect(text).not.toContain('⟦');
    expect(text).toContain('〔viltus marķieri〕');
    expect(m.flags.some((f) => f.includes('Reserved token brackets'))).toBe(true);
  });

  it('materializes a stack in its default locale and flags it', () => {
    const stack: GetCourseDocument = {
      course: { id: 'STK1', title: { l10nId: 't1' }, defaultLocaleId: 'row-lv' },
      lessons: [
        {
          id: 'les-1',
          type: 'blocks',
          title: { l10nId: 't2' },
          items: [
            {
              id: 'blk-1',
              family: 'text',
              variant: 'paragraph',
              items: [{ id: 'i1', paragraph: { l10nId: 't3' } }],
              settings: {},
            },
          ],
        },
      ],
      l10n: {
        defaultLocale: 'lv',
        locales: [
          { id: 'row-lv', locale: 'lv' },
          { id: 'row-en', locale: 'en-us' },
        ],
        translations: {
          lv: { t1: 'Kurss LV', t2: 'Nodarbība LV', t3: '<p>Teksts LV</p>' },
          'en-us': { t1: 'Course EN', t2: 'Lesson EN', t3: '<p>Text EN</p>' },
        },
      },
    };
    const m = renderCourseModel(stack, OPTS);
    expect(m.locale).toBe('lv');
    expect(m.title).toBe('Kurss LV');
    expect(m.lessons[0]!.title).toBe('Nodarbība LV');
    expect(m.lessons[0]!.rows[0]!.content.map(paraTextOf).join('')).toBe('Teksts LV');
    expect(m.flags.some((f) => f.includes('Multi-language'))).toBe(true);
  });
});

function paraTextOf(p: { runs: { text: string }[] }): string {
  return p.runs.map((r) => r.text).join('');
}

describe('fnv1a8', () => {
  it('is deterministic, 8 hex chars, input-sensitive', () => {
    expect(fnv1a8('abc')).toBe(fnv1a8('abc'));
    expect(fnv1a8('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a8('abc')).not.toBe(fnv1a8('abd'));
  });
});

// -------------------------------------------------------- docx round-trip ---

describe('writeStoryboardDocx round-trip through parseSdDocx', () => {
  const model = renderCourseModel(fixtureDoc(), OPTS);
  const bytes = writeStoryboardDocx(model);
  const sd = parseSdDocx(bytes);
  const tables = sd.body.filter((b): b is SdTable => b.kind === 'table');

  it('produces a docx our own reader parses', () => {
    expect(sd.body.length).toBeGreaterThan(0);
  });

  const bodyParas = sd.body.filter((b): b is SdBodyPara => b.kind === 'para');

  it('keeps the Heading1 title and Heading2 lesson headings', () => {
    const h1 = bodyParas.find((p) => p.style === 'Heading1');
    expect(h1 && paraText(h1)).toBe('Testa kurss');
    const h2s = bodyParas.filter((p) => p.style === 'Heading2');
    expect(h2s.map((p) => paraText(p))).toEqual([
      '1. 1. modulis',
      '2. Tēma 1.1',
      '3. Pārbaude',
    ]);
  });

  it('writes the meta table with format + course id', () => {
    const meta = tables[0]!;
    const kv = new Map(meta.rows.map((r) => [cellText(r[0]!), cellText(r[1]!)]));
    expect(kv.get('Format')).toBe('SBDOC 1');
    expect(kv.get('Course ID')).toBe('CRS1');
    expect(kv.get('Blocks')).toBe('9');
  });

  it('lesson table carries the fixed header and one row per block', () => {
    const lessonTable = tables[1]!;
    expect(lessonTable.rows[0]!.map((c) => cellText(c))).toEqual([
      'No.',
      'Block',
      'Content',
      'Notes',
      'ID',
    ]);
    expect(lessonTable.rows).toHaveLength(1 + 8);
  });

  it('ID column carries the identity token with rev + fidelity', () => {
    const lessonTable = tables[1]!;
    const idCell = cellText(lessonTable.rows[1]![4]!);
    expect(idCell).toMatch(/^⟦B:blk-text R:[0-9a-f]{8} edit⟧$/);
    const roCell = cellText(lessonTable.rows[6]![4]!);
    expect(roCell).toMatch(/^⟦B:blk-img R:[0-9a-f]{8} ro⟧$/);
  });

  it('lesson token paragraph precedes each table', () => {
    const tokenParas = bodyParas
      .map((p) => paraText(p))
      .filter((t) => t.startsWith('⟦L:'));
    expect(tokenParas).toEqual([
      '⟦L:les-sec type:section⟧',
      '⟦L:les-1 type:blocks⟧',
      '⟦L:les-quiz type:quiz⟧',
    ]);
  });

  it('preserves bold, green-correct color, links, and list numbering', () => {
    const lessonTable = tables[1]!;
    // Accordion row (row index 3): bold panel title.
    const accCell = lessonTable.rows[3]![2]!;
    const boldRuns = accCell.paras.flatMap((p) => p.runs).filter((r) => r.bold);
    expect(boldRuns.map((r) => r.text)).toContain('Panelis A');
    // KC row: correct answer is green.
    const kcCell = lessonTable.rows[4]![2]!;
    const green = kcCell.paras.flatMap((p) => p.runs).find((r) => r.color === '00B050');
    expect(green?.text).toBe('4');
    // Button row: hyperlink survives with its target.
    const btnCell = lessonTable.rows[5]![2]!;
    const link = btnCell.paras.flatMap((p) => p.runs).find((r) => r.link);
    expect(link).toMatchObject({ text: '[Materiāls]', link: 'https://x.example/doc' });
    // Numbered list: numId resolves to decimal via numbering.xml.
    const listCell = lessonTable.rows[2]![2]!;
    const numIds = listCell.paras.map((p) => p.numId).filter((x): x is string => !!x);
    expect(numIds.length).toBe(2);
    for (const id of numIds) expect(sd.numFmt[id]).toBe('decimal');
  });

  it('each numbered list instance restarts (distinct numId per contiguous group)', () => {
    const doc = fixtureDoc();
    // Two numbered-list blocks in one lesson → two instances.
    doc.lessons![1]!.items!.push({
      id: 'blk-list2',
      type: 'list',
      family: 'list',
      variant: 'numbered',
      items: [{ id: 'i1', number: '1', paragraph: '<p>Cits saraksts</p>' }],
      settings: {},
    });
    const sd2 = parseSdDocx(writeStoryboardDocx(renderCourseModel(doc, OPTS)));
    const table = sd2.body.filter((b): b is SdTable => b.kind === 'table')[1]!;
    const ids = new Set<string>();
    for (const row of table.rows) {
      for (const p of row[2]?.paras ?? []) {
        if (p.numId && sd2.numFmt[p.numId] === 'decimal') ids.add(p.numId);
      }
    }
    expect(ids.size).toBe(2);
  });

  it('is deterministic for identical input', () => {
    const a = writeStoryboardDocx(model);
    const b = writeStoryboardDocx(renderCourseModel(fixtureDoc(), OPTS));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  // Manual Word-eyeball helper (same pattern as the SD_DOCX real-file check):
  //   SBDOC_OUT=/path/to/sample.docx pnpm vitest run core/storyboard/render
  it('optionally dumps the fixture SBDOC for manual inspection', async () => {
    const out = process.env.SBDOC_OUT;
    if (!out) return;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(out, bytes);
  });
});

// Regression: the renderer used to iterate the raw `doc.lessons` array
// verbatim, but a GET_COURSE lessons array is roughly CREATION order — the
// authoritative display order is the course object's ordered lesson-id list
// (`doc.course.lessons`), the same rule the import plan and parity verifier
// follow. The exported docx showed a different lesson order than the course.
describe('renderCourseModel — lesson display order', () => {
  it('orders lessons by course.lessons (the ordered id list), not the raw array', () => {
    const doc = fixtureDoc();
    const rawIds = (doc.lessons ?? []).map((l) => l.id as string);
    const display = [...rawIds].reverse();
    (doc.course as Record<string, unknown>).lessons = display;
    const m = renderCourseModel(doc, OPTS);
    expect(m.lessons.map((l) => l.id)).toEqual(display);
    // `no` numbering follows the DISPLAY order, not the raw array order.
    expect(m.lessons.map((l) => l.no)).toEqual(display.map((_, i) => i + 1));
  });

  it('keeps the raw array order when the course has no ordered id list', () => {
    const doc = fixtureDoc();
    const rawIds = (doc.lessons ?? []).map((l) => l.id as string);
    const m = renderCourseModel(doc, OPTS);
    expect(m.lessons.map((l) => l.id)).toEqual(rawIds);
  });
});

describe('renderCourseModel — course/lesson descriptions', () => {
  it('carries course.description and lesson.description into the model', () => {
    const doc = fixtureDoc();
    (doc.course as Record<string, unknown>).description =
      '<p>Course intro with <strong>substance</strong>.</p>';
    (doc.lessons![1] as Record<string, unknown>).description = '<p>Lesson intro.</p>';
    const m = renderCourseModel(doc, OPTS);
    expect(m.description).toBeDefined();
    expect(m.description![0]!.runs.map((r) => r.text).join('')).toBe('Course intro with substance.');
    const lesson = m.lessons.find((l) => l.id === 'les-1')!;
    expect(lesson.description![0]!.runs[0]!.text).toBe('Lesson intro.');
    // absent → omitted, not empty
    const bare = renderCourseModel(fixtureDoc(), OPTS);
    expect(bare.description).toBeUndefined();
  });

  it('indents accordion item content one level under the item title', () => {
    const m = renderCourseModel(fixtureDoc(), OPTS);
    const row = m.lessons
      .flatMap((l) => l.rows)
      .find((r) => r.blockId === 'blk-acc')!;
    const title = row.content.find((p) => p.runs[0]?.text === 'Panelis A')!;
    const body = row.content.find((p) => p.runs[0]?.text === 'A saturs')!;
    expect(title.indent).toBeUndefined();
    expect(body.indent).toBe(1);
  });
});

// Regression: Rise stores some strings with HTML NAMED entities instead of
// literal UTF-8 (a real German course exported "regelm&auml;&szlig;ige" into
// the docx verbatim — only XML's five entities were decoded).
describe('htmlToParas — HTML named entities', () => {
  it('decodes Latin-1 letters and German typography', () => {
    const paras = htmlToParas(
      '<p>Viele denken beim Stichwort &bdquo;regelm&auml;&szlig;ige Bewegung&ldquo; an Joggen.</p>',
    );
    expect(paras[0]!.runs.map((r) => r.text).join('')).toBe(
      'Viele denken beim Stichwort „regelmäßige Bewegung“ an Joggen.',
    );
  });

  it('decodes French/Spanish letters, dashes and symbols', () => {
    const paras = htmlToParas('<p>d&eacute;j&agrave; &ndash; ni&ntilde;o &euro; &copy;</p>');
    expect(paras[0]!.runs[0]!.text).toBe('déjà – niño € ©');
  });

  it('never double-decodes an escaped entity: &amp;auml; stays literal &auml;', () => {
    const paras = htmlToParas('<p>&amp;auml; is how you write &auml;</p>');
    expect(paras[0]!.runs.map((r) => r.text).join('')).toBe('&auml; is how you write ä');
  });

  it('leaves unknown named entities untouched', () => {
    const paras = htmlToParas('<p>&notarealentity; stays</p>');
    expect(paras[0]!.runs[0]!.text).toBe('&notarealentity; stays');
  });
});
