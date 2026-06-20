import { describe, it, expect } from 'vitest';
import { IdMap } from './ids';
import {
  remapIds,
  blankUploadedMediaKeys,
  remapMediaKeys,
  findSurvivingSourceKeys,
  registerClientIds,
  SERVER_OWNED_FIELDS,
} from './remap';

// Deterministic id factory: old-id → NEW(old-id)
function fixedMap(): IdMap {
  return new IdMap(() => {
    throw new Error('should not mint without a source id');
  });
}
function seqMap(): IdMap {
  let n = 0;
  return new IdMap(() => `cnew${n++}aaaaaaaaaaaaaaaaaaaa`.slice(0, 25));
}

describe('remapIds', () => {
  it('regenerates client ids consistently and keeps refs valid', () => {
    const block = {
      family: 'image',
      id: 'cmqjv96a900353b7oj4kyekna',
      type: 'image',
      variant: 'hero',
      items: [{ id: 'cmqjv96a900363b7ov2hkynu1', caption: '' }],
      globalBlockId: 'f2736c59-3152-408f-add8-b8e307a6a014',
      createdAt: '2026-06-18T19:01:44.469Z',
    };
    const ids = seqMap();
    const out = remapIds(block, ids) as typeof block;

    // ids regenerated
    expect(out.id).not.toBe(block.id);
    expect(out.id).toBe(ids.get(block.id));
    expect((out.items[0] as { id: string }).id).toBe(
      ids.get('cmqjv96a900363b7ov2hkynu1'),
    );
    // server-owned fields stripped
    expect('globalBlockId' in out).toBe(false);
    expect('createdAt' in out).toBe(false);
    // verbatim fields preserved
    expect(out.family).toBe('image');
    expect(out.variant).toBe('hero');
  });

  it('remaps answer-id references (correct / corrects) to the new ids', () => {
    const q = {
      id: 'horl8m55yoad661yme9laqw6',
      type: 'MULTIPLE_RESPONSE',
      answers: [
        { id: 's0y091ulciwiec3038eylovq', title: 'A' },
        { id: 'f3y2w0utecmvj92axqj28y0n', title: 'B' },
      ],
      correct: 's0y091ulciwiec3038eylovq',
      corrects: ['s0y091ulciwiec3038eylovq', 'f3y2w0utecmvj92axqj28y0n'],
    };
    const ids = seqMap();
    const out = remapIds(q, ids) as typeof q;
    const a0 = ids.get('s0y091ulciwiec3038eylovq');
    const a1 = ids.get('f3y2w0utecmvj92axqj28y0n');
    expect((out.answers[0] as { id: string }).id).toBe(a0);
    expect(out.correct).toBe(a0); // reference followed the id
    expect(out.corrects).toEqual([a0, a1]);
  });

  it('rewrites items:<id> ref strings (refs / uploadId)', () => {
    const doc = {
      id: 'cblockaaaaaaaaaaaaaaaaaaa',
      items: [{ id: 'citemaaaaaaaaaaaaaaaaaaaa' }],
      refs: 'items:cblockaaaaaaaaaaaaaaaaaaa/items:citemaaaaaaaaaaaaaaaaaaaa',
    };
    const ids = seqMap();
    const out = remapIds(doc, ids) as typeof doc;
    const nb = ids.get('cblockaaaaaaaaaaaaaaaaaaa');
    const ni = ids.get('citemaaaaaaaaaaaaaaaaaaaa');
    expect(out.refs).toBe(`items:${nb}/items:${ni}`);
  });

  it('does not mutate the source document (immutable source of truth)', () => {
    const block = { id: 'caaaaaaaaaaaaaaaaaaaaaaaa', items: [{ id: 'cbbbbbbbbbbbbbbbbbbbbbbbb' }] };
    const snapshot = JSON.stringify(block);
    remapIds(block, seqMap());
    expect(JSON.stringify(block)).toBe(snapshot);
  });

  it('SERVER_OWNED_FIELDS covers the documented set', () => {
    expect(SERVER_OWNED_FIELDS.has('globalBlockId')).toBe(true);
    expect(SERVER_OWNED_FIELDS.has('updatedAt')).toBe(true);
  });
});

describe('registerClientIds', () => {
  it('pre-registers every client id so forward refs resolve', () => {
    const ids = seqMap();
    registerClientIds(
      { id: 'caaaaaaaaaaaaaaaaaaaaaaaa', items: [{ id: 'cbbbbbbbbbbbbbbbbbbbbbbbb' }] },
      ids,
    );
    expect(ids.has('caaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    expect(ids.has('cbbbbbbbbbbbbbbbbbbbbbbbb')).toBe(true);
  });
});

describe('blankUploadedMediaKeys', () => {
  it('blanks uploaded keys but keeps cdn/embeds verbatim', () => {
    const doc = {
      media: {
        image: { key: 'rise/courses/ABC/img.jpg', crushedKey: 'rise/courses/ABC/crush.jpg' },
      },
      cover: 'https://cdn.articulate.com/assets/rise/x.jpg',
      embed: 'https://youtube.com/watch?v=1',
    };
    const out = blankUploadedMediaKeys(doc) as typeof doc;
    expect(out.media.image.key).toBe('');
    expect(out.media.image.crushedKey).toBe('');
    expect(out.cover).toBe(doc.cover);
    expect(out.embed).toBe(doc.embed);
  });
});

describe('remapMediaKeys', () => {
  it('swaps source keys for new target keys', () => {
    const doc = { media: { image: { key: 'rise/courses/OLD/a.jpg' } } };
    const out = remapMediaKeys(
      doc,
      new Map([['rise/courses/OLD/a.jpg', 'rise/courses/NEW/z.jpg']]),
    ) as typeof doc;
    expect(out.media.image.key).toBe('rise/courses/NEW/z.jpg');
  });

  it('swaps keys embedded inside a usercontent URL in HTML', () => {
    const doc = {
      html: '<img src="https://articulateusercontent.com/rise/courses/OLD/a.png">',
    };
    const out = remapMediaKeys(
      doc,
      new Map([['rise/courses/OLD/a.png', 'rise/courses/NEW/b.png']]),
    ) as typeof doc;
    expect(out.html).toContain('rise/courses/NEW/b.png');
    expect(out.html).not.toContain('OLD');
  });
});

describe('findSurvivingSourceKeys', () => {
  it('flags keys still in the source owner space (invariant)', () => {
    const doc = {
      a: { key: 'rise/courses/SRC/x.jpg' },
      b: { key: 'rise/courses/TGT/y.jpg' },
      bank: { key: 'rise/questionBanks/SRCBANK/q.png' },
    };
    const survivors = findSurvivingSourceKeys(doc, ['SRC', 'SRCBANK']);
    expect(survivors).toContain('rise/courses/SRC/x.jpg');
    expect(survivors).toContain('rise/questionBanks/SRCBANK/q.png');
    expect(survivors).not.toContain('rise/courses/TGT/y.jpg');
  });

  it('returns empty when fully remapped', () => {
    const doc = { a: { key: 'rise/courses/TGT/x.jpg' } };
    expect(findSurvivingSourceKeys(doc, ['SRC'])).toEqual([]);
  });
});
