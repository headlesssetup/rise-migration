// SBDOC prose — flowing-document writer (docs/rise-storyboard-format.md).
//
// Renders the SbCourse model as a flowing prose .docx that reads like the Rise
// course itself: headings, body text, embedded image thumbnails, and small gray
// identity tokens between blocks. Designed for proofreading — not for mimicking
// the original course's visual richness.
//
// Layout: A4 portrait, Aptos font, no per-lesson tables.
// Correct answers: lime highlight (not green font color).
// Images: embedded at display size (max ~14 cm banner, ~8 cm other).
// Block identity: `⟦B:id R:rev edit⟧` as small gray paragraph after each block.

import { strToU8, zipSync } from 'fflate';
import type { SbCard, SbCourse, SbLesson, SbPara, SbRow, SbRun } from './model';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const WP = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const PIC = 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const GRAY = '999999';
const WARN = 'C00000';
/** Light-red run shading for authored-but-hidden-from-learners text. */
const HIDDEN_SHD = 'FFC7CE';
const TOKEN_SZ = 16; // 8 pt
const TOKEN_FONT = 'Consolas';
const EMU_PER_CM = 360000;
const MAX_BANNER_W_CM = 15;
const MAX_IMAGE_W_CM = 10;

export interface ResolvedImage {
  key: string;
  bytes: Uint8Array;
  ext: string;
  width: number;
  height: number;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface DocState {
  rels: Map<string, string>;
  numberInstances: number[];
  nextNumId: number;
  images: Map<string, { rId: string; partName: string }>;
  nextImageId: number;
  mediaFiles: Map<string, Uint8Array>;
}

function relFor(state: DocState, url: string): string {
  let id = state.rels.get(url);
  if (!id) {
    id = `rIdH${state.rels.size + 1}`;
    state.rels.set(url, id);
  }
  return id;
}

function imageRelFor(state: DocState, key: string, ext: string, bytes: Uint8Array): string {
  const existing = state.images.get(key);
  if (existing) return existing.rId;
  const n = state.nextImageId++;
  const rId = `rIdImg${n}`;
  const partName = `media/image${n}.${ext}`;
  state.images.set(key, { rId, partName });
  state.mediaFiles.set(`word/${partName}`, bytes);
  return rId;
}

// ---------------------------------------------------------------- XML helpers

function runXml(run: SbRun, opts: { sz?: number; highlight?: string; shd?: string } = {}): string {
  const props: string[] = [];
  if (run.link) props.push('<w:rStyle w:val="Hyperlink"/>');
  if (run.bold) props.push('<w:b/>');
  if (run.italic) props.push('<w:i/>');
  if (run.color) props.push(`<w:color w:val="${esc(run.color)}"/>`);
  if (opts.sz) props.push(`<w:sz w:val="${opts.sz}"/><w:szCs w:val="${opts.sz}"/>`);
  if (opts.highlight) props.push(`<w:highlight w:val="${opts.highlight}"/>`);
  if (opts.shd) props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${opts.shd}"/>`);
  const rPr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  const body = run.text
    .split('\n')
    .map((seg) => `<w:t xml:space="preserve">${esc(seg)}</w:t>`)
    .join('<w:br/>');
  return `<w:r>${rPr}${body}</w:r>`;
}

function paraXml(
  p: SbPara,
  state: DocState,
  opts: { style?: string; numId?: number; sz?: number; highlight?: string; jc?: string } = {},
): string {
  const pPr: string[] = [];
  if (opts.style) pPr.push(`<w:pStyle w:val="${opts.style}"/>`);
  if (opts.numId !== undefined) {
    pPr.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${opts.numId}"/></w:numPr>`);
  }
  if (p.indent) {
    // 720 twips (0.5") per level; list paras keep their hanging marker.
    const left = p.indent * 720 + (opts.numId !== undefined ? 360 : 0);
    pPr.push(`<w:ind w:left="${left}"${opts.numId !== undefined ? ' w:hanging="180"' : ''}/>`);
  }
  if (opts.jc) pPr.push(`<w:jc w:val="${opts.jc}"/>`);
  const pre = pPr.length > 0 ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';

  // Hidden-from-learners text is exposed but shaded light red (see SbPara.hidden).
  const shd = p.hidden ? HIDDEN_SHD : undefined;
  const parts: string[] = [];
  let i = 0;
  while (i < p.runs.length) {
    const run = p.runs[i]!;
    if (!run.link) {
      parts.push(runXml(run, { sz: opts.sz, highlight: opts.highlight, shd }));
      i++;
      continue;
    }
    const url = run.link;
    let j = i;
    while (j < p.runs.length && p.runs[j]!.link === url) j++;
    const inner = p.runs.slice(i, j).map((r) => runXml(r, { sz: opts.sz, shd })).join('');
    parts.push(`<w:hyperlink r:id="${relFor(state, url)}">${inner}</w:hyperlink>`);
    i = j;
  }
  return `<w:p>${pre}${parts.join('')}</w:p>`;
}

function textPara(
  text: string,
  state: DocState,
  opts: { style?: string; bold?: boolean; italic?: boolean; color?: string; sz?: number; jc?: string; highlight?: string } = {},
): string {
  return paraXml(
    { runs: [{ text, ...(opts.bold ? { bold: true } : {}), ...(opts.italic ? { italic: true } : {}), ...(opts.color ? { color: opts.color } : {}) }] },
    state,
    { style: opts.style, sz: opts.sz, jc: opts.jc, highlight: opts.highlight },
  );
}

function tokenRun(text: string, highlighted = false): string {
  const style = highlighted
    ? `<w:b/><w:color w:val="000000"/><w:highlight w:val="yellow"/>`
    : `<w:color w:val="${GRAY}"/>`;
  return (
    `<w:r><w:rPr>` +
    `<w:rFonts w:ascii="${TOKEN_FONT}" w:hAnsi="${TOKEN_FONT}" w:cs="${TOKEN_FONT}"/>` +
    `<w:sz w:val="${TOKEN_SZ}"/><w:szCs w:val="${TOKEN_SZ}"/>` +
    style +
    `</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
  );
}

function tokenPara(text: string, state: DocState, spaceBefore = 240): string {
  const pPr = spaceBefore > 0
    ? `<w:pPr><w:spacing w:before="${spaceBefore}" w:after="40"/></w:pPr>`
    : '';
  return `<w:p>${pPr}${tokenRun(text)}</w:p>`;
}

/** Block identity token with the block-TYPE designator highlighted (yellow +
 *  black + bold) so an SME can spot interactivity types while scanning. Text
 *  blocks highlight only the word `text` — their variant is layout detail. */
function blockTokenPara(row: SbRow, lessonNo: number): string {
  const label = blockTypeLabel(row.family, row.variant);
  const hl = row.family === 'text' ? 'text' : label;
  const rest = label.slice(hl.length);
  const pPr = `<w:pPr><w:spacing w:before="240" w:after="40"/></w:pPr>`;
  return (
    `<w:p>${pPr}` +
    tokenRun(`⟦${lessonNo}.${row.no} `) +
    tokenRun(hl, true) +
    tokenRun(`${rest} B:${row.blockId} R:${row.rev}⟧`) +
    `</w:p>`
  );
}

// ------------------------------------------------------------------- images

function imageXml(rId: string, wEmu: number, hEmu: number, name: string): string {
  return (
    '<w:drawing>' +
    `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${wEmu}" cy="${hEmu}"/>` +
    `<wp:docPr id="0" name="${esc(name)}"/>` +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:pic ${PIC}>` +
    `<pic:nvPicPr><pic:cNvPr id="0" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>'
  );
}

function emitImage(
  resolved: ResolvedImage,
  state: DocState,
  maxWidthCm: number,
): string {
  const rId = imageRelFor(state, resolved.key, resolved.ext, resolved.bytes);
  let w = resolved.width;
  let h = resolved.height;
  const maxPx = maxWidthCm * 96 / 2.54;
  if (w > maxPx) {
    h = Math.round(h * maxPx / w);
    w = Math.round(maxPx);
  }
  const wEmu = Math.round(w / 96 * 2.54 * EMU_PER_CM);
  const hEmu = Math.round(h / 96 * 2.54 * EMU_PER_CM);
  const xml = imageXml(rId, wEmu, hEmu, resolved.key);
  return `<w:p><w:r><w:rPr/>${xml}</w:r></w:p>`;
}

// ------------------------------------------------------------ content paras

function contentParas(paras: SbPara[], state: DocState, opts: { sz?: number; highlight?: string } = {}): string {
  if (paras.length === 0) return '';
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

// ----------------------------------------------------- block-level rendering

function blockTypeLabel(family: string, variant: string): string {
  if (family === variant) return family;
  return `${family}/${variant}`;
}

function renderBlockProse(
  row: SbRow,
  lessonNo: number,
  state: DocState,
  images: Map<string, ResolvedImage>,
): string {
  const parts: string[] = [];

  // Identity token FIRST — number + block type (highlighted) + id + rev
  parts.push(blockTokenPara(row, lessonNo));

  // Image thumbnail (if resolved)
  if (row.image) {
    const resolved = images.get(row.image.key);
    if (resolved) {
      const isBanner = row.family === 'image' && row.variant === 'banner';
      parts.push(emitImage(resolved, state, isBanner ? MAX_BANNER_W_CM : MAX_IMAGE_W_CM));
    }
  }

  // Flashcards — a 2-column table, one card per row: front | back.
  if (row.cards && row.cards.length > 0) {
    parts.push(flashcardTable(row.cards, state));
    return parts.join('');
  }

  // Prose hint overrides
  if (row.prose === 'impact') {
    for (const p of row.content) {
      parts.push(paraXml(
        { runs: p.runs.map((r) => ({ ...r, bold: true })) },
        state,
        { jc: 'center', sz: 28 },
      ));
    }
  } else if (row.prose === 'continue') {
    for (const p of row.content) {
      parts.push(paraXml(p, state, { jc: 'center', sz: 22 }));
    }
  } else if (row.prose === 'divider') {
    parts.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="BFBFBF"/></w:pBdr></w:pPr></w:p>');
  } else {
    const isKc = row.family === 'knowledgeCheck';
    if (isKc) {
      parts.push(contentParasKc(row.content, state));
    } else {
      parts.push(contentParas(row.content, state));
    }
  }

  return parts.join('');
}

// Flashcard table: two equal columns filling the text width (A4 − margins =
// 9638 twips), min row height ≈ half the column width for square-ish cells.
const CARD_COL = 4819;
const CARD_ROW_MIN = 2400;

function flashcardTable(cards: SbCard[], state: DocState): string {
  const cell = (paras: SbPara[]): string =>
    `<w:tc><w:tcPr><w:tcW w:w="${CARD_COL}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>` +
    (paras.length > 0 ? contentParas(paras, state) : '<w:p/>') +
    '</w:tc>';
  const rows = cards
    .map(
      (card) =>
        `<w:tr><w:trPr><w:trHeight w:val="${CARD_ROW_MIN}" w:hRule="atLeast"/></w:trPr>` +
        cell(card.front) +
        cell(card.back) +
        '</w:tr>',
    )
    .join('');
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${CARD_COL * 2}" w:type="dxa"/>` +
    `${TABLE_BORDERS}<w:tblLayout w:type="fixed"/></w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="${CARD_COL}"/><w:gridCol w:w="${CARD_COL}"/></w:tblGrid>` +
    `${rows}</w:tbl><w:p/>`
  );
}

/** KC rendering: correct answers get lime highlight instead of green font. */
function contentParasKc(paras: SbPara[], state: DocState): string {
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
    // Rewrite green-colored runs → lime highlight
    const hasGreen = p.runs.some((r) => r.color === '00B050');
    if (hasGreen) {
      const rewritten: SbPara = {
        ...p,
        runs: p.runs.map((r) =>
          r.color === '00B050' ? { ...r, color: undefined } : r,
        ),
      };
      out.push(paraXml(rewritten, state, { numId, highlight: 'green' }));
    } else {
      out.push(paraXml(p, state, { numId }));
    }
  }
  return out.join('');
}

// ------------------------------------------------------------------ lesson

function lessonXml(lesson: SbLesson, isFirst: boolean, state: DocState, images: Map<string, ResolvedImage>): string {
  const parts: string[] = [];

  parts.push(
    `<w:p><w:pPr><w:pStyle w:val="Heading2"/>${isFirst ? '' : '<w:pageBreakBefore/>'}</w:pPr>` +
    `<w:r><w:t xml:space="preserve">${esc(lesson.title)}</w:t></w:r></w:p>`,
  );

  parts.push(tokenPara(`⟦L:${lesson.id} type:${lesson.type}⟧`, state, 0));

  // Author-entered lesson description, straight under the heading.
  if (lesson.description && lesson.description.length > 0) {
    parts.push(contentParas(lesson.description, state));
  }

  if (lesson.note) {
    parts.push(textPara(lesson.note, state, { italic: true, color: GRAY }));
  }

  for (const row of lesson.rows) {
    parts.push(renderBlockProse(row, lesson.no, state, images));
  }

  return parts.join('');
}

// ---------------------------------------------------------------- meta table

const META_COLS = [2400, 7200];
const TABLE_BORDERS =
  '<w:tblBorders>' +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
    .join('') +
  '</w:tblBorders>';

function humanDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function metaTable(course: SbCourse, state: DocState): string {
  const rows: [string, string][] = [
    ['Course ID', course.courseId],
    ['Generated', `${humanDate(course.generatedAt)}  ·  v${course.toolVersion}`],
    ['Language', course.locale ?? 'monolingual'],
    ['Content', `${course.lessons.length} lessons · ${course.blockCount} blocks`],
  ];
  const rowsXml = rows
    .map(([k, v]) => {
      const kCell = `<w:tc><w:tcPr><w:tcW w:w="${META_COLS[0]}" w:type="dxa"/></w:tcPr>${textPara(k, state, { bold: true, sz: 18 })}</w:tc>`;
      const vCell = `<w:tc><w:tcPr><w:tcW w:w="${META_COLS[1]}" w:type="dxa"/></w:tcPr>${textPara(v, state, { sz: 18 })}</w:tc>`;
      return `<w:tr>${kCell}${vCell}</w:tr>`;
    })
    .join('');
  const grid = META_COLS.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${META_COLS.reduce((a, b) => a + b, 0)}" w:type="dxa"/>` +
    `${TABLE_BORDERS}<w:tblLayout w:type="fixed"/></w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${rowsXml}</w:tbl>`
  );
}

// ---------------------------------------------------------------- document

const GUARD_TEXT =
  'This document is generated from a Rise course archive for proofreading. ' +
  'Gray ⟦…⟧ tokens are identity markers — do not modify them. ' +
  'Images are thumbnails for reference only.';

/** Cover legend: one line demonstrating each marker in its actual formatting. */
function legendXml(): string {
  const item = (rPr: string, sample: string, meaning: string): string =>
    `<w:r><w:rPr>${rPr}<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>` +
    `<w:t xml:space="preserve">${esc(sample)}</w:t></w:r>` +
    `<w:r><w:rPr><w:color w:val="${GRAY}"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>` +
    `<w:t xml:space="preserve"> ${esc(meaning)}   </w:t></w:r>`;
  return (
    '<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>' +
    `<w:r><w:rPr><w:b/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>` +
    '<w:t xml:space="preserve">Legend:   </w:t></w:r>' +
    item('<w:highlight w:val="green"/>', 'green', '= correct quiz answer') +
    item('<w:b/><w:highlight w:val="yellow"/>', 'yellow', '= block type') +
    item(`<w:shd w:val="clear" w:color="auto" w:fill="${HIDDEN_SHD}"/>`, 'red', '= in the course but hidden from learners') +
    '</w:p>'
  );
}

const SECT_PR =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';

function tocXml(course: SbCourse, state: DocState): string {
  const parts: string[] = [];
  parts.push(textPara('Lessons', state, { bold: true, sz: 22 }));
  for (const lesson of course.lessons) {
    parts.push(textPara(`${lesson.no}. ${lesson.title}`, state, { sz: 20 }));
  }
  parts.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="BFBFBF"/></w:pBdr></w:pPr></w:p>');
  return parts.join('');
}

function documentXml(course: SbCourse, state: DocState, images: Map<string, ResolvedImage>): string {
  const body: string[] = [];

  // --- Page 1: the export COVER — title, metadata, contents. No content. ---
  body.push(textPara(course.title, state, { style: 'Heading1' }));
  body.push(textPara(GUARD_TEXT, state, { italic: true, color: GRAY, sz: 18 }));
  body.push(legendXml());
  body.push(metaTable(course, state));
  body.push('<w:p/>');

  for (const flag of course.flags) {
    body.push(textPara(`⚠ ${flag}`, state, { bold: true, color: WARN }));
  }

  body.push(tocXml(course, state));
  body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');

  // --- Page 2 onwards: the actual content — title again, the course
  // description (cover intro), then every lesson exactly as before. ---
  body.push(textPara(course.title, state, { style: 'Heading1' }));
  if (course.description && course.description.length > 0) {
    body.push(contentParas(course.description, state));
  }

  // Lessons — each on its own page (the first stays under the description)
  for (let i = 0; i < course.lessons.length; i++) {
    body.push(lessonXml(course.lessons[i]!, i === 0, state, images));
  }

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document ${W} ${R} ${WP} ${A} ${PIC}><w:body>${body.join('')}${SECT_PR}</w:body></w:document>`
  );
}

// ------------------------------------------------------------------- parts

function contentTypes(state: DocState): string {
  const imageExts = new Set<string>();
  for (const [, { partName }] of state.images) {
    const ext = partName.split('.').pop()!;
    imageExts.add(ext);
  }
  const MIME: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
  };
  const extOverrides = [...imageExts]
    .map((ext) => `<Default Extension="${ext}" ContentType="${MIME[ext] ?? `image/${ext}`}"/>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    extOverrides +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '</Types>'
  );
}

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
  const imageRels = [...state.images.values()]
    .map(
      ({ rId, partName }) =>
        `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${partName}"/>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    hyperlinks +
    imageRels +
    '</Relationships>'
  );
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  `<w:styles ${W}>` +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:cs="Aptos"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/>' +
  '</w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="360" w:after="120"/></w:pPr>' +
  '<w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/><w:color w:val="001C39"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="360" w:after="120"/>' +
  '<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="4" w:color="001C39"/></w:pBdr></w:pPr>' +
  '<w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/><w:color w:val="001C39"/></w:rPr></w:style>' +
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

/** Render the storyboard model to a flowing-prose .docx. */
export function writeStoryboardDocxProse(
  course: SbCourse,
  images: Map<string, ResolvedImage> = new Map(),
): Uint8Array {
  const state: DocState = {
    rels: new Map(),
    numberInstances: [],
    nextNumId: 2,
    images: new Map(),
    nextImageId: 1,
    mediaFiles: new Map(),
  };
  const doc = documentXml(course, state, images);
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes(state)),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/document.xml': strToU8(doc),
    'word/_rels/document.xml.rels': strToU8(documentRels(state)),
    'word/styles.xml': strToU8(STYLES),
    'word/numbering.xml': strToU8(numberingXml(state)),
  };
  for (const [path, bytes] of state.mediaFiles) {
    files[path] = bytes;
  }
  return zipSync(files, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
}
