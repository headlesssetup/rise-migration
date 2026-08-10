// Storyboard phase 1 — a minimal, strict XML parser for OOXML part files.
//
// Why hand-rolled: tests run in Node (no DOMParser) and the extension ships no
// XML dependency. Scope is deliberately narrow — Word-generated, well-formed
// XML (document.xml / numbering.xml / *.rels): prolog, elements, attributes,
// text, comments, CDATA, character/entity references. No DTD, no processing
// beyond skipping `<?…?>`. Malformed input fails LOUDLY (never a silent
// best-effort parse — a wrong read of the client's storyboard must not pass).

export interface XmlEl {
  /** Qualified tag name verbatim (e.g. `w:p`). Word emits stable prefixes. */
  tag: string;
  attrs: Record<string, string>;
  children: (XmlEl | string)[];
}

export class XmlError extends Error {
  constructor(message: string, pos: number) {
    super(`XML parse error at offset ${pos}: ${message}`);
    this.name = 'XmlError';
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decode character and the five predefined entity references. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

const RE_NAME = /[^\s=/>]+/y;
const RE_WS = /\s*/y;

/** Parse one XML document; returns the root element. */
export function parseXml(src: string): XmlEl {
  let pos = 0;

  function skipWs(): void {
    RE_WS.lastIndex = pos;
    RE_WS.exec(src);
    pos = RE_WS.lastIndex;
  }

  function skipMisc(): void {
    // Prolog, comments, PIs between/before elements.
    for (;;) {
      skipWs();
      if (src.startsWith('<?', pos)) {
        const end = src.indexOf('?>', pos);
        if (end === -1) throw new XmlError('unterminated processing instruction', pos);
        pos = end + 2;
      } else if (src.startsWith('<!--', pos)) {
        const end = src.indexOf('-->', pos);
        if (end === -1) throw new XmlError('unterminated comment', pos);
        pos = end + 3;
      } else {
        return;
      }
    }
  }

  function parseName(): string {
    RE_NAME.lastIndex = pos;
    const m = RE_NAME.exec(src);
    if (!m || m.index !== pos || m[0].length === 0) {
      throw new XmlError('expected a name', pos);
    }
    pos += m[0].length;
    return m[0];
  }

  function parseAttrs(): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (;;) {
      skipWs();
      const ch = src[pos];
      if (ch === '>' || ch === '/' || ch === undefined) return attrs;
      const name = parseName();
      skipWs();
      if (src[pos] !== '=') throw new XmlError(`attribute ${name} missing '='`, pos);
      pos++;
      skipWs();
      const quote = src[pos];
      if (quote !== '"' && quote !== "'") {
        throw new XmlError(`attribute ${name} missing quote`, pos);
      }
      pos++;
      const end = src.indexOf(quote, pos);
      if (end === -1) throw new XmlError(`attribute ${name} unterminated`, pos);
      attrs[name] = decodeEntities(src.slice(pos, end));
      pos = end + 1;
    }
  }

  function parseElement(): XmlEl {
    if (src[pos] !== '<') throw new XmlError('expected element', pos);
    pos++;
    const tag = parseName();
    const attrs = parseAttrs();
    const el: XmlEl = { tag, attrs, children: [] };
    skipWs();
    if (src.startsWith('/>', pos)) {
      pos += 2;
      return el;
    }
    if (src[pos] !== '>') throw new XmlError(`element ${tag} not closed`, pos);
    pos++;
    // Children until matching close tag.
    for (;;) {
      if (pos >= src.length) throw new XmlError(`element ${tag} never closed`, pos);
      if (src.startsWith('</', pos)) {
        pos += 2;
        const close = parseName();
        if (close !== tag) {
          throw new XmlError(`mismatched close: <${tag}> closed by </${close}>`, pos);
        }
        skipWs();
        if (src[pos] !== '>') throw new XmlError(`close tag ${close} malformed`, pos);
        pos++;
        return el;
      }
      if (src.startsWith('<!--', pos)) {
        const end = src.indexOf('-->', pos);
        if (end === -1) throw new XmlError('unterminated comment', pos);
        pos = end + 3;
        continue;
      }
      if (src.startsWith('<![CDATA[', pos)) {
        const end = src.indexOf(']]>', pos);
        if (end === -1) throw new XmlError('unterminated CDATA', pos);
        el.children.push(src.slice(pos + 9, end));
        pos = end + 3;
        continue;
      }
      if (src.startsWith('<?', pos)) {
        const end = src.indexOf('?>', pos);
        if (end === -1) throw new XmlError('unterminated processing instruction', pos);
        pos = end + 2;
        continue;
      }
      if (src[pos] === '<') {
        el.children.push(parseElement());
        continue;
      }
      const next = src.indexOf('<', pos);
      const end = next === -1 ? src.length : next;
      el.children.push(decodeEntities(src.slice(pos, end)));
      pos = end;
    }
  }

  skipMisc();
  const root = parseElement();
  skipMisc();
  if (pos < src.length) throw new XmlError('trailing content after root element', pos);
  return root;
}

/** Direct children with the given tag. */
export function kids(el: XmlEl, tag: string): XmlEl[] {
  return el.children.filter((c): c is XmlEl => typeof c !== 'string' && c.tag === tag);
}

/** First direct child with the given tag, or undefined. */
export function kid(el: XmlEl, tag: string): XmlEl | undefined {
  return kids(el, tag)[0];
}

/** All element children (any tag), in order. */
export function elementChildren(el: XmlEl): XmlEl[] {
  return el.children.filter((c): c is XmlEl => typeof c !== 'string');
}

/** Concatenated text content of an element's subtree. */
export function textContent(el: XmlEl): string {
  let out = '';
  for (const c of el.children) {
    out += typeof c === 'string' ? c : textContent(c);
  }
  return out;
}
