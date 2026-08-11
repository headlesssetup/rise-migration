import { describe, expect, it } from 'vitest';
import { decodeEntities, kid, kids, parseXml, textContent, XmlError } from './xml';

describe('parseXml', () => {
  it('parses elements, attributes, text and nesting', () => {
    const root = parseXml(
      '<?xml version="1.0"?><w:p w:rsidR="0A"><w:r><w:t xml:space="preserve">Hi </w:t></w:r></w:p>',
    );
    expect(root.tag).toBe('w:p');
    expect(root.attrs['w:rsidR']).toBe('0A');
    const r = kid(root, 'w:r')!;
    const t = kid(r, 'w:t')!;
    expect(textContent(t)).toBe('Hi ');
  });

  it('handles self-closing tags and multiple children', () => {
    const root = parseXml('<a><b w:val="1"/><b w:val="2"/><c/></a>');
    expect(kids(root, 'b').map((b) => b.attrs['w:val'])).toEqual(['1', '2']);
    expect(kid(root, 'c')).toBeDefined();
  });

  it('decodes entities in text and attributes', () => {
    const root = parseXml('<a t="A &amp; B">&lt;x&gt; &#65;&#x42;</a>');
    expect(root.attrs['t']).toBe('A & B');
    expect(textContent(root)).toBe('<x> AB');
  });

  it('keeps CDATA content and skips comments', () => {
    const root = parseXml('<a><!-- nope --><![CDATA[a<b]]></a>');
    expect(textContent(root)).toBe('a<b');
  });

  it('fails loudly on mismatched close tags', () => {
    expect(() => parseXml('<a><b></a></b>')).toThrow(XmlError);
  });

  it('fails loudly on trailing content', () => {
    expect(() => parseXml('<a/><b/>')).toThrow(XmlError);
  });
});

describe('decodeEntities', () => {
  it('leaves unknown entities alone', () => {
    expect(decodeEntities('&nope; &amp;')).toBe('&nope; &');
  });
});
