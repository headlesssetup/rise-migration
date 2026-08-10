import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { cellText, coalesceRuns, DocxError, paraText, parseSdDocx } from './docx';

const DOC_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function docx(parts: {
  document: string;
  numbering?: string;
  rels?: string;
}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${DOC_NS}><w:body>${parts.document}</w:body></w:document>`,
    ),
  };
  if (parts.numbering) {
    files['word/numbering.xml'] = strToU8(
      `<?xml version="1.0"?><w:numbering ${DOC_NS}>${parts.numbering}</w:numbering>`,
    );
  }
  if (parts.rels) {
    files['word/_rels/document.xml.rels'] = strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts.rels}</Relationships>`,
    );
  }
  return zipSync(files);
}

function run(text: string, props = ''): string {
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

describe('parseSdDocx', () => {
  it('reads paragraphs with bold/italic/color formatting', () => {
    const sd = parseSdDocx(
      docx({
        document: `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run('Title', '<w:b/>')}</w:p><w:p>${run('a', '<w:i/>')}${run('b', '<w:color w:val="00b050"/>')}</w:p>`,
      }),
    );
    expect(sd.body).toHaveLength(2);
    const h = sd.body[0]!;
    const p = sd.body[1]!;
    if (h.kind !== 'para' || p.kind !== 'para') throw new Error('expected paras');
    expect(h.style).toBe('Heading1');
    expect(h.runs[0]!).toMatchObject({ text: 'Title', bold: true });
    expect(p.runs[0]!).toMatchObject({ text: 'a', italic: true });
    expect(p.runs[1]!).toMatchObject({ text: 'b', color: '00B050' });
  });

  it('coalesces fragmented identically-formatted runs', () => {
    const sd = parseSdDocx(
      docx({ document: `<w:p>${run('Sā')}${run('kums')}${run('!', '<w:b/>')}</w:p>` }),
    );
    const p = sd.body[0]!;
    if (p.kind !== 'para') throw new Error('expected para');
    expect(p.runs).toHaveLength(2);
    expect(p.runs[0]!.text).toBe('Sākums');
  });

  it('resolves hyperlink targets through the rels part', () => {
    const sd = parseSdDocx(
      docx({
        document: `<w:p><w:hyperlink r:id="rId9">${run('Atvērt LES')}</w:hyperlink></w:p>`,
        rels: '<Relationship Id="rId9" Type="t" Target="https://eur-lex.europa.eu/x" TargetMode="External"/>',
      }),
    );
    const p = sd.body[0]!;
    if (p.kind !== 'para') throw new Error('expected para');
    expect(p.runs[0]!.link).toBe('https://eur-lex.europa.eu/x');
  });

  it('reads tables into rows/cells and numbering into numFmt', () => {
    const sd = parseSdDocx(
      docx({
        document: `<w:tbl><w:tr><w:tc><w:p>${run('Slaida nr.')}</w:p></w:tc><w:tc><w:p>${run('X')}</w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="4"/></w:numPr></w:pPr></w:p></w:tc><w:tc><w:p>${run('body')}</w:p></w:tc></w:tr></w:tbl>`,
        numbering:
          '<w:abstractNum w:abstractNumId="25"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="4"><w:abstractNumId w:val="25"/></w:num>',
      }),
    );
    const tbl = sd.body[0]!;
    if (tbl.kind !== 'table') throw new Error('expected table');
    expect(tbl.rows).toHaveLength(2);
    expect(cellText(tbl.rows[0]![0]!)).toBe('Slaida nr.');
    expect(tbl.rows[1]![0]!.paras[0]!.numId).toBe('4');
    expect(sd.numFmt['4']).toBe('decimal');
  });

  it('marks vanish paragraphs hidden and drops vanish runs (Word shows neither)', () => {
    const sd = parseSdDocx(
      docx({
        document:
          `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="4"/></w:numPr><w:rPr><w:vanish/></w:rPr></w:pPr></w:p>` +
          `<w:p>${run('shown')}<w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden run</w:t></w:r></w:p>`,
      }),
    );
    const [hiddenP, normal] = [sd.body[0]!, sd.body[1]!];
    if (hiddenP.kind !== 'para' || normal.kind !== 'para') throw new Error('expected paras');
    expect(hiddenP.hidden).toBe(true);
    expect(normal.hidden).toBeUndefined();
    expect(paraText(normal)).toBe('shown');
  });

  it('keeps tracked insertions and skips deletions (accepted view)', () => {
    const sd = parseSdDocx(
      docx({
        document: `<w:p><w:ins w:id="1" w:author="a">${run('kept')}</w:ins><w:del w:id="2" w:author="a"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>`,
      }),
    );
    const p = sd.body[0]!;
    if (p.kind !== 'para') throw new Error('expected para');
    expect(paraText(p)).toBe('kept');
  });

  it('fails loudly on a non-docx file', () => {
    expect(() => parseSdDocx(strToU8('not a zip'))).toThrow(DocxError);
    expect(() => parseSdDocx(zipSync({ 'other.txt': strToU8('x') }))).toThrow(
      /word\/document\.xml missing/,
    );
  });
});

describe('coalesceRuns', () => {
  it('merges only identically-formatted neighbours', () => {
    const merged = coalesceRuns([
      { text: 'a', bold: true, italic: false },
      { text: 'b', bold: true, italic: false },
      { text: 'c', bold: false, italic: false },
    ]);
    expect(merged.map((r) => r.text)).toEqual(['ab', 'c']);
  });
});
