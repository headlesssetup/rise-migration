// SBDOC — write the storyboard model as a .docx (docs/rise-storyboard-format.md).
//
// Hand-built OOXML zipped with fflate — the same zero-dependency stance as the
// SD reader (`../docx.ts`), and deliberately limited to the parts that reader
// understands, so every SBDOC we emit round-trips through our own
// `parseSdDocx` (the render test asserts it). Parts written:
//   [Content_Types].xml, _rels/.rels,
//   word/document.xml, word/_rels/document.xml.rels,
//   word/styles.xml, word/numbering.xml
//
// Layout: A4 landscape; one 5-column table per lesson (No. | Block | Content |
// Notes | ID); `ro` rows shaded; ID/token text gray 7pt. Numbered lists get
// ONE numbering instance per contiguous run so every list restarts at 1.

import { strToU8, zipSync } from 'fflate';
import type { SbCourse, SbLesson, SbPara, SbRow, SbRun } from './model';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const GRAY = '808080';
const WARN = 'C00000';
const SHADE_RO = 'EFEFEF';
const SHADE_HEAD = 'D9D9D9';
/** Column widths (twips) — sum = A4 landscape 16838 minus 720-twip margins. */
const COLS = [600, 2200, 8400, 2400, 1798];
const META_COLS = [3000, 12398];

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface RunOpts {
  /** Half-point font size override (14 = 7pt) for token/meta text. */
  sz?: number;
}

interface DocState {
  /** URL → relationship id for hyperlinks. */
  rels: Map<string, string>;
  /** Allocated decimal-numbering instance ids (each restarts at 1). */
  numberInstances: number[];
  nextNumId: number;
}

function relFor(state: DocState, url: string): string {
  let id = state.rels.get(url);
  if (!id) {
    id = `rIdH${state.rels.size + 1}`;
    state.rels.set(url, id);
  }
  return id;
}

function runXml(run: SbRun, opts: RunOpts): string {
  const props: string[] = [];
  if (run.link) props.push('<w:rStyle w:val="Hyperlink"/>');
  if (run.bold) props.push('<w:b/>');
  if (run.italic) props.push('<w:i/>');
  if (run.color) props.push(`<w:color w:val="${esc(run.color)}"/>`);
  if (opts.sz) props.push(`<w:sz w:val="${opts.sz}"/><w:szCs w:val="${opts.sz}"/>`);
  const rPr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  // Newlines inside a run become soft line breaks.
  const body = run.text
    .split('\n')
    .map((seg) => `<w:t xml:space="preserve">${esc(seg)}</w:t>`)
    .join('<w:br/>');
  return `<w:r>${rPr}${body}</w:r>`;
}

function paraXml(p: SbPara, state: DocState, opts: RunOpts & { style?: string; numId?: number } = {}): string {
  const pPr: string[] = [];
  if (opts.style) pPr.push(`<w:pStyle w:val="${opts.style}"/>`);
  if (opts.numId !== undefined) {
    pPr.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${opts.numId}"/></w:numPr>`);
  }
  const pre = pPr.length > 0 ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';

  // Group consecutive same-link runs under one w:hyperlink.
  const parts: string[] = [];
  let i = 0;
  while (i < p.runs.length) {
    const run = p.runs[i]!;
    if (!run.link) {
      parts.push(runXml(run, opts));
      i++;
      continue;
    }
    const url = run.link;
    let j = i;
    while (j < p.runs.length && p.runs[j]!.link === url) j++;
    const inner = p.runs.slice(i, j).map((r) => runXml(r, opts)).join('');
    parts.push(`<w:hyperlink r:id="${relFor(state, url)}">${inner}</w:hyperlink>`);
    i = j;
  }
  return `<w:p>${pre}${parts.join('')}</w:p>`;
}

function textPara(text: string, state: DocState, opts: RunOpts & { style?: string; bold?: boolean; italic?: boolean; color?: string } = {}): string {
  return paraXml(
    { runs: [{ text, ...(opts.bold ? { bold: true } : {}), ...(opts.italic ? { italic: true } : {}), ...(opts.color ? { color: opts.color } : {}) }] },
    state,
    { style: opts.style, sz: opts.sz },
  );
}

/** Paragraph sequence for one cell — allocates one decimal numbering instance
 *  per contiguous numbered group; always at least one (empty) paragraph. */
function cellParas(paras: SbPara[], state: DocState, opts: RunOpts = {}): string {
  if (paras.length === 0) return '<w:p/>';
  const out: string[] = [];
  let currentNumId: number | undefined;
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]!;
    let numId: number | undefined;
    if (p.list === 'bullet') {
      numId = 1;
      currentNumId = undefined;
    } else if (p.list === 'number') {
      if (currentNumId === undefined || paras[i - 1]?.list !== 'number') {
        currentNumId = state.nextNumId++;
        state.numberInstances.push(currentNumId);
      }
      numId = currentNumId;
    } else {
      currentNumId = undefined;
    }
    out.push(paraXml(p, state, { ...opts, numId }));
  }
  return out.join('');
}

function cellXml(parasXml: string, width: number, shade?: string): string {
  const shd = shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : '';
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shd}</w:tcPr>${parasXml}</w:tc>`;
}

const TABLE_BORDERS =
  '<w:tblBorders>' +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
    .join('') +
  '</w:tblBorders>';

function tableXml(cols: number[], rowsXml: string): string {
  const grid = cols.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${cols.reduce((a, b) => a + b, 0)}" w:type="dxa"/>` +
    `${TABLE_BORDERS}<w:tblLayout w:type="fixed"/></w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${rowsXml}</w:tbl>`
  );
}

function headerRow(state: DocState): string {
  const cells = ['No.', 'Block', 'Content', 'Notes', 'ID']
    .map((h, i) => cellXml(textPara(h, state, { bold: true }), COLS[i]!, SHADE_HEAD))
    .join('');
  return `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cells}</w:tr>`;
}

function blockRow(row: SbRow, state: DocState): string {
  const shade = row.fidelity === 'ro' ? SHADE_RO : undefined;
  const token = `⟦B:${row.blockId} R:${row.rev} ${row.fidelity}⟧`;
  const blokCell =
    textPara(row.label, state) + textPara(`${row.family}/${row.variant}`, state, { sz: 14, color: GRAY });
  const notesXml =
    row.notes.length === 0 ? '<w:p/>' : row.notes.map((n) => textPara(n, state, { sz: 16 })).join('');
  const cells = [
    cellXml(textPara(String(row.no), state), COLS[0]!, shade),
    cellXml(blokCell, COLS[1]!, shade),
    cellXml(cellParas(row.content, state), COLS[2]!, shade),
    cellXml(notesXml, COLS[3]!, shade),
    cellXml(textPara(token, state, { sz: 14, color: GRAY }), COLS[4]!, shade),
  ];
  return `<w:tr>${cells.join('')}</w:tr>`;
}

function lessonXml(lesson: SbLesson, state: DocState): string {
  const parts: string[] = [
    textPara(`${lesson.no}. ${lesson.title}`, state, { style: 'Heading2' }),
    textPara(`⟦L:${lesson.id} type:${lesson.type}⟧`, state, { sz: 14, color: GRAY }),
  ];
  if (lesson.note) parts.push(textPara(lesson.note, state, { italic: true }));
  if (lesson.rows.length > 0) {
    parts.push(tableXml(COLS, headerRow(state) + lesson.rows.map((r) => blockRow(r, state)).join('')));
    parts.push('<w:p/>'); // spacer — two adjacent tables would merge in Word
  }
  return parts.join('');
}

const GUARD_TEXT =
  'Edit only the “Content” column in white rows. Do not modify: ' +
  'the “ID” column, gray ⟦…⟧ tokens, shaded (read-only) rows, or ' +
  'the table structure. Deleting a row = requesting block deletion.';

function metaTable(course: SbCourse, state: DocState): string {
  const rows: [string, string][] = [
    ['Format', 'SBDOC 1'],
    ['Course ID', course.courseId],
    ['Generated', course.generatedAt],
    ['Tool version', course.toolVersion],
    ['Language', course.locale ?? '—'],
    ['Lessons', String(course.lessons.length)],
    ['Blocks', String(course.blockCount)],
  ];
  const rowsXml = rows
    .map(
      ([k, v]) =>
        `<w:tr>${cellXml(textPara(k, state, { bold: true }), META_COLS[0]!)}${cellXml(
          textPara(v, state),
          META_COLS[1]!,
        )}</w:tr>`,
    )
    .join('');
  return tableXml(META_COLS, rowsXml);
}

const SECT_PR =
  '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>' +
  '<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';

function documentXml(course: SbCourse, state: DocState): string {
  const body: string[] = [
    textPara(course.title, state, { style: 'Heading1' }),
    textPara(GUARD_TEXT, state, { italic: true, color: GRAY }),
    metaTable(course, state),
    '<w:p/>',
  ];
  for (const flag of course.flags) {
    body.push(textPara(`⚠ ${flag}`, state, { bold: true, color: WARN }));
  }
  for (const lesson of course.lessons) body.push(lessonXml(lesson, state));
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document ${W} ${R}><w:body>${body.join('')}${SECT_PR}</w:body></w:document>`
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
  '</Types>';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

function documentRels(state: DocState): string {
  const hyperlinks = [...state.rels.entries()]
    .map(
      ([url, id]) =>
        `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(url)}" TargetMode="External"/>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    hyperlinks +
    '</Relationships>'
  );
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  `<w:styles ${W}>` +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="80"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="120"/></w:pPr>' +
  '<w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="240" w:after="120"/></w:pPr>' +
  '<w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
  '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>' +
  '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
  '</w:styles>';

function numberingXml(state: DocState): string {
  const decimalNums = state.numberInstances
    .map(
      (id) =>
        `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/>` +
        '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>',
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:numbering ${W}>` +
    '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>' +
    '<w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="180"/></w:pPr></w:lvl></w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/>' +
    '<w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="180"/></w:pPr></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    decimalNums +
    '</w:numbering>'
  );
}

/** Render the storyboard model to .docx bytes. Pure and deterministic. */
export function writeStoryboardDocx(course: SbCourse): Uint8Array {
  const state: DocState = { rels: new Map(), numberInstances: [], nextNumId: 2 };
  const doc = documentXml(course, state); // fills rels + numbering instances
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(doc),
    'word/_rels/document.xml.rels': strToU8(documentRels(state)),
    'word/styles.xml': strToU8(STYLES),
    'word/numbering.xml': strToU8(numberingXml(state)),
  };
  // Fixed mtime: identical input must yield identical bytes (determinism is
  // what makes an SBDOC re-render diffable at the file level).
  return zipSync(files, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
}
