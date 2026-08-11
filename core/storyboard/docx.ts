// Storyboard phase 1 — read an SD `.docx` into a formatting-aware document
// model. A docx is a zip of XML parts; we need three:
//   word/document.xml            body: paragraphs + tables
//   word/numbering.xml           numId → numFmt (the auto-numbered `Slaida nr.`
//                                column stores NO text — numbers are computed)
//   word/_rels/document.xml.rels rId → hyperlink target URL
//
// The model keeps exactly the formatting the SD conventions are built on:
// bold / italic / run color / list membership / hyperlinks. Tracked changes are
// tolerated in ACCEPTED view (w:ins content included, w:del skipped) — the
// conversion is meant to run on the accepted final document, but a stray
// leftover revision must not corrupt the read.

import { unzipSync } from 'fflate';
import {
  elementChildren,
  kid,
  kids,
  parseXml,
  textContent,
  type XmlEl,
} from './xml';

export interface SdRun {
  text: string;
  bold: boolean;
  italic: boolean;
  /** Run color as an RRGGBB hex string (e.g. `00B050`), if explicitly set. */
  color?: string;
  /** Hyperlink target URL, when the run sits inside `w:hyperlink`. */
  link?: string;
}

export interface SdPara {
  runs: SdRun[];
  /** Paragraph style id (e.g. `Heading1`, `ListParagraph`). */
  style?: string;
  /** Numbering id when the paragraph belongs to a numbered/bulleted list. */
  numId?: string;
  /** `w:vanish` on the paragraph mark — HIDDEN text: Word neither displays it
   *  nor lets it consume a list number (slide numbering must skip it). */
  hidden?: boolean;
}

export interface SdCell {
  paras: SdPara[];
}

export interface SdTable {
  kind: 'table';
  rows: SdCell[][];
}

export interface SdBodyPara extends SdPara {
  kind: 'para';
}

export interface SdDoc {
  body: (SdBodyPara | SdTable)[];
  /** numId → 'decimal' | 'bullet' | other numFmt string (level 0). */
  numFmt: Record<string, string>;
}

export class DocxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxError';
  }
}

const DECODER = new TextDecoder();

function part(files: Record<string, Uint8Array>, name: string): string | null {
  const bytes = files[name];
  return bytes ? DECODER.decode(bytes) : null;
}

/** rId → target URL from a relationships part. */
function parseRels(xml: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!xml) return out;
  const root = parseXml(xml);
  for (const rel of elementChildren(root)) {
    const id = rel.attrs['Id'];
    const target = rel.attrs['Target'];
    if (id && target) out[id] = target;
  }
  return out;
}

/** numId → level-0 numFmt, resolved through abstractNum (no overrides seen in
 *  SDs; a lvlOverride with a startOverride would not change the format). */
function parseNumbering(xml: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!xml) return out;
  const root = parseXml(xml);
  const fmtByAbstract: Record<string, string> = {};
  for (const ab of kids(root, 'w:abstractNum')) {
    const id = ab.attrs['w:abstractNumId'];
    const lvl0 = kids(ab, 'w:lvl').find((l) => l.attrs['w:ilvl'] === '0');
    const fmt = lvl0 ? kid(lvl0, 'w:numFmt')?.attrs['w:val'] : undefined;
    if (id !== undefined && fmt) fmtByAbstract[id] = fmt;
  }
  for (const num of kids(root, 'w:num')) {
    const numId = num.attrs['w:numId'];
    const abstract = kid(num, 'w:abstractNumId')?.attrs['w:val'];
    if (numId !== undefined && abstract !== undefined) {
      const fmt = fmtByAbstract[abstract];
      if (fmt) out[numId] = fmt;
    }
  }
  return out;
}

/** True when `w:val` of a toggle property means "on" (absent val = on). */
function toggleOn(el: XmlEl | undefined): boolean {
  if (!el) return false;
  const v = el.attrs['w:val'];
  return v === undefined || v === '1' || v === 'true' || v === 'on';
}

function parseRun(r: XmlEl, link: string | undefined): SdRun | null {
  const rPr = kid(r, 'w:rPr');
  // Hidden (vanish) runs are invisible in Word — never content.
  if (rPr && toggleOn(kid(rPr, 'w:vanish'))) return null;
  let text = '';
  for (const c of elementChildren(r)) {
    if (c.tag === 'w:t') text += textContent(c);
    else if (c.tag === 'w:tab') text += '\t';
    else if (c.tag === 'w:br' || c.tag === 'w:cr') text += '\n';
    // w:delText (inside w:del) never reaches here — deletions are skipped.
  }
  if (text === '') return null;
  const colorVal = rPr ? kid(rPr, 'w:color')?.attrs['w:val'] : undefined;
  const color =
    colorVal && colorVal.toLowerCase() !== 'auto' ? colorVal.toUpperCase() : undefined;
  return {
    text,
    bold: toggleOn(rPr ? kid(rPr, 'w:b') : undefined),
    italic: toggleOn(rPr ? kid(rPr, 'w:i') : undefined),
    ...(color ? { color } : {}),
    ...(link ? { link } : {}),
  };
}

function sameFormat(a: SdRun, b: SdRun): boolean {
  return (
    a.bold === b.bold && a.italic === b.italic && a.color === b.color && a.link === b.link
  );
}

/** Merge adjacent identically-formatted runs — Word fragments text arbitrarily
 *  (spell-check / revision-id splits), so a visible phrase often spans many
 *  runs; conventions must see it whole. */
export function coalesceRuns(runs: SdRun[]): SdRun[] {
  const out: SdRun[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && sameFormat(last, r)) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

function parseParagraph(p: XmlEl, rels: Record<string, string>): SdPara {
  const pPr = kid(p, 'w:pPr');
  const style = pPr ? kid(pPr, 'w:pStyle')?.attrs['w:val'] : undefined;
  const numPr = pPr ? kid(pPr, 'w:numPr') : undefined;
  const numId = numPr ? kid(numPr, 'w:numId')?.attrs['w:val'] : undefined;
  // Paragraph-mark vanish (pPr > rPr > vanish): the whole paragraph is hidden.
  const pMarkRPr = pPr ? kid(pPr, 'w:rPr') : undefined;
  const hidden = pMarkRPr ? toggleOn(kid(pMarkRPr, 'w:vanish')) : false;

  const runs: SdRun[] = [];
  const walk = (el: XmlEl, link: string | undefined): void => {
    for (const c of elementChildren(el)) {
      if (c.tag === 'w:r') {
        const run = parseRun(c, link);
        if (run) runs.push(run);
      } else if (c.tag === 'w:hyperlink') {
        const rId = c.attrs['r:id'];
        walk(c, (rId && rels[rId]) || link);
      } else if (c.tag === 'w:ins' || c.tag === 'w:smartTag' || c.tag === 'w:sdt' || c.tag === 'w:sdtContent') {
        walk(c, link); // accepted view: keep insertions; unwrap containers
      }
      // w:del (and anything else) skipped: deletions vanish in accepted view.
    }
  };
  walk(p, undefined);

  return {
    runs: coalesceRuns(runs),
    ...(style ? { style } : {}),
    ...(numId !== undefined ? { numId } : {}),
    ...(hidden ? { hidden } : {}),
  };
}

function parseCell(tc: XmlEl, rels: Record<string, string>): SdCell {
  const paras: SdPara[] = [];
  const walk = (el: XmlEl): void => {
    for (const c of elementChildren(el)) {
      if (c.tag === 'w:p') paras.push(parseParagraph(c, rels));
      else if (c.tag === 'w:tbl') walk(c); // nested table: flatten its text
      else if (c.tag !== 'w:tcPr') walk(c);
    }
  };
  walk(tc);
  return { paras };
}

function parseTable(tbl: XmlEl, rels: Record<string, string>): SdTable {
  const rows: SdCell[][] = [];
  for (const tr of kids(tbl, 'w:tr')) {
    rows.push(kids(tr, 'w:tc').map((tc) => parseCell(tc, rels)));
  }
  return { kind: 'table', rows };
}

/** Parse SD docx bytes into the storyboard document model. Loud on anything
 *  that isn't a readable Word document. */
export function parseSdDocx(bytes: Uint8Array): SdDoc {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
    throw new DocxError(`not a readable .docx (zip) file: ${String(e)}`);
  }
  const docXml = part(files, 'word/document.xml');
  if (!docXml) throw new DocxError('word/document.xml missing — not a Word document');

  const rels = parseRels(part(files, 'word/_rels/document.xml.rels'));
  const numFmt = parseNumbering(part(files, 'word/numbering.xml'));

  const root = parseXml(docXml);
  if (root.tag !== 'w:document') {
    throw new DocxError(`unexpected root element <${root.tag}> in word/document.xml`);
  }
  const body = kid(root, 'w:body');
  if (!body) throw new DocxError('w:body missing in word/document.xml');

  const items: (SdBodyPara | SdTable)[] = [];
  for (const c of elementChildren(body)) {
    if (c.tag === 'w:p') items.push({ kind: 'para', ...parseParagraph(c, rels) });
    else if (c.tag === 'w:tbl') items.push(parseTable(c, rels));
    // sectPr etc. ignored.
  }
  return { body: items, numFmt };
}

/** Plain text of a paragraph (all runs concatenated). */
export function paraText(p: SdPara): string {
  return p.runs.map((r) => r.text).join('');
}

/** Plain text of a cell (paragraphs joined with newlines). */
export function cellText(c: SdCell): string {
  return c.paras.map(paraText).filter((t) => t.trim() !== '').join('\n');
}
