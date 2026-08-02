import { describe, it, expect } from 'vitest';
import { IdMap } from './ids';
import {
  SERVER_OWNED_FIELDS,
  blankForeignMediaKeys,
  blankUploadedMediaKeys,
  findForeignMediaKeys,
  findSurvivingSourceKeys,
  freshClientIds,
  registerClientIds,
  remapIds,
  remapMediaKeys,
  stripMediaReference,
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

  it('preserves authored HTML text around an embedded image (H10)', () => {
    const doc = {
      paragraph:
        '<p>Intro text <img src="https://articulateusercontent.com/rise/courses/ABC/pic.png" alt="x"> and more text</p>',
    };
    const out = blankUploadedMediaKeys(doc) as typeof doc;
    expect(out.paragraph).toContain('Intro text');
    expect(out.paragraph).toContain('and more text');
    expect(out.paragraph).not.toContain('rise/courses/ABC');
    expect(out.paragraph).not.toContain('<img');
    // The result must still satisfy the no-foreign-keys assertion.
    expect(findForeignMediaKeys(out, [])).toEqual([]);
  });

  it('keeps an embed URL in a string that ALSO carried an uploaded key', () => {
    const doc = {
      html: '<p>Watch https://www.youtube.com/watch?v=1 <img src="https://articulateusercontent.com/rise/courses/ABC/a.jpg"></p>',
    };
    const out = blankUploadedMediaKeys(doc) as typeof doc;
    expect(out.html).toContain('youtube.com/watch?v=1');
    expect(out.html).not.toContain('rise/courses/ABC');
  });
});

describe('stripMediaReference', () => {
  it('blanks a bare key / bare usercontent URL to the empty string', () => {
    expect(stripMediaReference('rise/courses/ABC/a.jpg', 'rise/courses/ABC/a.jpg')).toBe('');
    expect(
      stripMediaReference(
        'https://articulateusercontent.com/rise/courses/ABC/a.jpg',
        'rise/courses/ABC/a.jpg',
      ),
    ).toBe('');
  });

  it('strips only the url(...) construct out of inline CSS', () => {
    const s =
      'color:red;background-image:url("https://articulateusercontent.com/rise/courses/ABC/bg.jpg");margin:0';
    const out = stripMediaReference(s, 'rise/courses/ABC/bg.jpg');
    expect(out).toContain('color:red');
    expect(out).toContain('margin:0');
    expect(out).not.toContain('rise/courses/ABC');
    expect(out).not.toContain('url(');
  });

  it('leaves strings not containing the key untouched', () => {
    expect(stripMediaReference('<p>plain</p>', 'rise/courses/ABC/a.jpg')).toBe('<p>plain</p>');
  });
});

describe('blankForeignMediaKeys', () => {
  it('keeps a target-owned img and authored text, strips only the foreign img', () => {
    const doc = {
      html:
        '<p>keep <img src="https://articulateusercontent.com/rise/courses/TGT/ok.jpg"> and ' +
        '<img src="https://articulateusercontent.com/rise/courses/SRC/bad.jpg"> tail</p>',
    };
    const out = blankForeignMediaKeys(doc, ['TGT']) as typeof doc;
    expect(out.html).toContain('keep');
    expect(out.html).toContain('tail');
    expect(out.html).toContain('rise/courses/TGT/ok.jpg');
    expect(out.html).not.toContain('rise/courses/SRC');
    expect(findForeignMediaKeys(out, ['TGT'])).toEqual([]);
  });

  it('blanks a bare foreign value whole, keeps a bare target value', () => {
    const doc = { a: 'rise/courses/SRC/x.jpg', b: 'rise/courses/TGT/y.jpg' };
    const out = blankForeignMediaKeys(doc, ['TGT']) as typeof doc;
    expect(out.a).toBe('');
    expect(out.b).toBe('rise/courses/TGT/y.jpg');
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

  it('BLANKS a key mapped to "" instead of leaving the dead source key (C2)', () => {
    // '' is the blanking convention for orphaned/oversize/unsupported media —
    // the old truthiness check left the source key verbatim.
    const doc = {
      bare: 'rise/courses/OLD/gone.jpg',
      html: '<p>text <img src="https://articulateusercontent.com/rise/courses/OLD/gone.jpg"> tail</p>',
    };
    const out = remapMediaKeys(doc, new Map([['rise/courses/OLD/gone.jpg', '']])) as typeof doc;
    expect(out.bare).toBe('');
    expect(out.html).toContain('text');
    expect(out.html).toContain('tail');
    expect(out.html).not.toContain('rise/courses/OLD');
    expect(findForeignMediaKeys(out, [])).toEqual([]);
  });

  it('mixes a real remap and a blank in one string', () => {
    const doc = {
      html:
        '<img src="https://articulateusercontent.com/rise/courses/OLD/keep.jpg">' +
        '<img src="https://articulateusercontent.com/rise/courses/OLD/gone.jpg">',
    };
    const out = remapMediaKeys(
      doc,
      new Map([
        ['rise/courses/OLD/keep.jpg', 'rise/courses/NEW/kept.jpg'],
        ['rise/courses/OLD/gone.jpg', ''],
      ]),
    ) as typeof doc;
    expect(out.html).toContain('rise/courses/NEW/kept.jpg');
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

describe('findForeignMediaKeys', () => {
  it('flags any uploaded key not under a target owner (incl. foreign owners)', () => {
    const doc = {
      a: { key: 'rise/courses/TGT/x.jpg' }, // target owner — ok
      b: { key: 'rise/courses/SRC/y.jpg' }, // source owner — foreign
      c: { key: 'rise/courses/OTHER/z.jpg' }, // a 3rd course — foreign
      bank: { key: 'rise/questionBanks/NEWBANK/q.png' }, // target bank — ok
    };
    const foreign = findForeignMediaKeys(doc, ['TGT', 'NEWBANK']);
    expect(foreign).toContain('rise/courses/SRC/y.jpg');
    expect(foreign).toContain('rise/courses/OTHER/z.jpg');
    expect(foreign).not.toContain('rise/courses/TGT/x.jpg');
    expect(foreign).not.toContain('rise/questionBanks/NEWBANK/q.png');
  });

  it('keeps cdn/embeds out of scope', () => {
    const doc = { cover: 'https://cdn.articulate.com/x.jpg', e: 'https://youtu.be/1' };
    expect(findForeignMediaKeys(doc, ['TGT'])).toEqual([]);
  });
});

describe('freshClientIds — non-cuid block/item ids (Rise sample courses)', () => {
  const mint = () => {
    let n = 0;
    return () => `cfresh${String(++n).padStart(19, '0')}`;
  };

  const numberedBlock = {
    id: '3',
    family: 'list',
    variant: 'numbered',
    items: [
      { id: '1', paragraph: 'a', refs: ['items:1/paragraph'] },
      { id: '2', paragraph: 'b' },
    ],
    settings: { paddingTop: 3, columns: '2' },
  };

  it('re-mints the block + item ids and rewrites items: refs', () => {
    const out = freshClientIds(numberedBlock, mint()) as typeof numberedBlock;
    expect(out.id).toBe('cfresh0000000000000000001');
    expect(out.items[0]!.id).toBe('cfresh0000000000000000002');
    expect(out.items[1]!.id).toBe('cfresh0000000000000000003');
    // the id is swapped, the path suffix preserved
    expect(out.items[0]!.refs).toEqual(['items:cfresh0000000000000000002/paragraph']);
    // untouched content — a bare "2" that is NOT an id position stays put
    expect(out.settings.columns).toBe('2');
    expect(out.family).toBe('list');
  });

  it('gives the SAME source id different values per call (the collision fix)', () => {
    const m = mint();
    const a = freshClientIds(numberedBlock, m) as typeof numberedBlock;
    const b = freshClientIds(numberedBlock, m) as typeof numberedBlock;
    expect(a.id).not.toBe(b.id);
    expect(a.items[0]!.id).not.toBe(b.items[0]!.id);
  });

  it('leaves cuid-shaped ids alone (the global IdMap pass owns those)', () => {
    const cuid = {
      id: 'cmsahv00e002j3b7vsfxtdddt',
      items: [{ id: 'cmsahv00e0170357is3ygm7ch' }],
    };
    expect(freshClientIds(cuid, mint())).toEqual(cuid);
  });

  it('never touches ids outside the items chain (storyline meta, bank questions)', () => {
    const block = {
      id: '1',
      items: [
        {
          id: '1',
          media: { storyline: { meta: { slides: [{ id: '61v06kIDyzq', title: 'Intro' }] } } },
        },
        { id: '2', type: 'DRAW_FROM_QUESTION_BANK', questions: [{ id: '7', title: 'q' }] },
      ],
    };
    const out = freshClientIds(block, mint()) as typeof block;
    // structural ids changed…
    expect(out.id).not.toBe('1');
    expect(out.items[0]!.id).not.toBe('1');
    // …nested non-structural ids did NOT
    expect(out.items[0]!.media!.storyline.meta.slides[0]!.id).toBe('61v06kIDyzq');
    expect(out.items[1]!.questions![0]!.id).toBe('7');
  });

  it('is a no-op for a block with no ids at all', () => {
    const b = { family: 'divider', settings: {} };
    expect(freshClientIds(b, mint())).toEqual(b);
  });
});
