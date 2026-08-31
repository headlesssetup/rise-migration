import { describe, it, expect } from 'vitest';
import {
  applyAssetMap,
  blockumentManifest,
  blockumentTransaction,
  collectBlockumentIds,
  collectBlockumentRefs,
  collectGraphAssets,
  createBlockumentFromBlank,
  crushMondrianAsset,
  mondrianApiBase,
  remapBlockumentGraph,
  signedAssetUrl,
} from './index';
import type { BlockumentGraph } from './index';

const SRC_BID = '1133557f-ae63-402e-bdf3-959e5cf4506c';
const NEW_BID = '55639d4b-04f0-45f6-a58a-a1e8a34d7b6d';

// Shape mirrors the 2026-08-31 manifest captures (redacted content).
function fixtureGraph(): BlockumentGraph {
  return {
    blockuments: {
      [SRC_BID]: {
        id: SRC_BID,
        title: 'Template - Quotation Cards',
        children: [{ id: 'root-item-0000-0000-000000000001', visualOrder: 0, clonedFromId: 'tpl-child' }],
        triggers: [],
        authoringOpened: true,
        createdFromTemplateId: '5aa0ea84-12fe-4e27-ac4a-3fa287055e89',
        responsive: false,
        _v: 47,
      },
    },
    items: {
      'root-item-0000-0000-000000000001': {
        id: 'root-item-0000-0000-000000000001',
        blockumentId: SRC_BID,
        parentId: SRC_BID,
        type: 'group',
        name: 'Canvas',
        states: { default: { fill: { opacity: 1 } } },
      },
      'text-item-0000-0000-000000000002': {
        id: 'text-item-0000-0000-000000000002',
        blockumentId: SRC_BID,
        parentId: 'root-item-0000-0000-000000000001',
        type: 'text',
        clonedFromId: 'tpl-item',
        states: { default: { text: { type: 'tiptap', json: { type: 'doc' } } } },
      },
      'img-item-00000-0000-000000000003': {
        id: 'img-item-00000-0000-000000000003',
        blockumentId: SRC_BID,
        parentId: 'root-item-0000-0000-000000000001',
        type: 'image',
        states: { default: { fill: { opacity: 1, assetId: 'cmtgvpgwa036d073v6gvrao0x' } } },
        assets: {
          cmtgvpgwa036d073v6gvrao0x: {
            id: 'cmtgvpgwa036d073v6gvrao0x',
            path: `mondrian/assets/blockument/${SRC_BID}/cmtgvpgwa036d073v6gvrao0x.png`,
            name: 'astronaut.png',
            type: 'image',
            width: 2476,
            height: 2476,
          },
        },
      },
    },
    fonts: { 'var(--mon-theme-font-body)': null },
  };
}

describe('mondrianApiBase', () => {
  it('is strictly per plane and loud on an unknown plane', () => {
    expect(mondrianApiBase('us')).toBe('https://mondrian-api.articulate.com');
    expect(mondrianApiBase('eu')).toBe('https://mondrian-api.eu.articulate.com');
    expect(() => mondrianApiBase(null)).toThrow(/plane unknown/i);
  });
});

describe('envelopes', () => {
  it('createFromBlank carries the parent course (capture shape)', () => {
    const spec = createBlockumentFromBlank('eu', 'COURSE1');
    expect(spec.url).toBe('https://mondrian-api.eu.articulate.com/api/blockuments/createFromBlank');
    expect(JSON.parse(spec.body!)).toEqual({ parentId: 'COURSE1', parentType: 'course' });
  });

  it('transaction wraps a full-state doc or item upsert', () => {
    const doc = blockumentTransaction('eu', NEW_BID, { blockument: { id: NEW_BID } });
    expect(doc.url).toContain(`/api/blockuments/${NEW_BID}/transaction`);
    expect(JSON.parse(doc.body!)).toEqual({ blockument: { id: NEW_BID } });
    const item = blockumentTransaction('eu', NEW_BID, { items: { i1: { id: 'i1' } } });
    expect(JSON.parse(item.body!)).toEqual({ items: { i1: { id: 'i1' } } });
  });

  it('signed-asset-url + manifest + crush build the captured shapes', () => {
    const s = signedAssetUrl('eu', 'astronaut.png', NEW_BID);
    expect(JSON.parse(s.body!)).toEqual({ name: 'astronaut.png', blockumentId: NEW_BID });
    expect(blockumentManifest('us', SRC_BID).url).toBe(
      `https://mondrian-api.articulate.com/api/blockuments/${SRC_BID}/manifest`,
    );
    const c = crushMondrianAsset('COURSE1', 'mondrian/assets/blockument/x/y.png');
    expect(JSON.parse(c.body!)).toEqual({
      type: 'rise/uploads/CRUSH_IMAGE',
      payload: { courseId: 'COURSE1', original: 'mondrian/assets/blockument/x/y.png' },
    });
  });
});

describe('collectBlockumentRefs / collectBlockumentIds', () => {
  it('finds blockumentId fields anywhere in a course doc, with paths', () => {
    const doc = {
      lessons: [
        { items: [{ family: 'mondrian', blockumentId: SRC_BID }, { family: 'text' }] },
        { items: [{ family: 'mondrian', blockumentId: 'other-bid' }] },
      ],
    };
    const refs = collectBlockumentRefs(doc);
    expect(refs).toHaveLength(2);
    expect(refs[0]!.path).toBe('lessons[0].items[0].blockumentId');
    expect(collectBlockumentIds(doc).sort()).toEqual([SRC_BID, 'other-bid'].sort());
  });

  it('ignores empty values and non-strings', () => {
    expect(collectBlockumentIds({ blockumentId: '', x: { blockumentId: 7 } })).toEqual([]);
  });
});

describe('collectGraphAssets', () => {
  it('collects the asset records with their downloadable paths', () => {
    const assets = collectGraphAssets(fixtureGraph());
    expect(assets).toHaveLength(1);
    expect(assets[0]!.path).toBe(
      `mondrian/assets/blockument/${SRC_BID}/cmtgvpgwa036d073v6gvrao0x.png`,
    );
  });
});

describe('remapBlockumentGraph', () => {
  const mintUuid = () => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  };

  it('adopts the created canvas item and re-mints all other item ids', () => {
    const out = remapBlockumentGraph(fixtureGraph(), SRC_BID, NEW_BID, 'ADOPTED-CANVAS', mintUuid());
    expect(out.doc.id).toBe(NEW_BID);
    expect(out.doc.children![0]!.id).toBe('ADOPTED-CANVAS');
    // verbatim provenance/schema fields survive
    expect(out.doc.createdFromTemplateId).toBe('5aa0ea84-12fe-4e27-ac4a-3fa287055e89');
    expect(out.doc._v).toBe(47);
    const root = out.items.find((i) => i.id === 'ADOPTED-CANVAS')!;
    expect(root.parentId).toBe(NEW_BID);
    expect(root.blockumentId).toBe(NEW_BID);
    const others = out.items.filter((i) => i.id !== 'ADOPTED-CANVAS');
    expect(others).toHaveLength(2);
    for (const item of others) {
      expect(item.id).toMatch(/^00000000-0000-4000/);
      expect(item.blockumentId).toBe(NEW_BID);
      expect(item.parentId).toBe('ADOPTED-CANVAS');
    }
    // parents-first ordering: root canvas first
    expect(out.items[0]!.id).toBe('ADOPTED-CANVAS');
  });

  it('aborts loudly on a graph without exactly one root item', () => {
    const g = fixtureGraph();
    delete g.items['root-item-0000-0000-000000000001'];
    expect(() => remapBlockumentGraph(g, SRC_BID, NEW_BID, 'X', mintUuid())).toThrow(
      /expected exactly 1 root item/,
    );
  });

  it('does not touch asset ids/paths (those wait for applyAssetMap)', () => {
    const out = remapBlockumentGraph(fixtureGraph(), SRC_BID, NEW_BID, 'ADOPTED', mintUuid());
    const img = out.items.find((i) => i.type === 'image')!;
    expect(Object.keys(img.assets!)).toEqual(['cmtgvpgwa036d073v6gvrao0x']);
  });
});

describe('applyAssetMap', () => {
  it('rewrites record keys, record id/path, and fill.assetId references', () => {
    const mintUuid = () => 'unused';
    const out = remapBlockumentGraph(fixtureGraph(), SRC_BID, NEW_BID, 'ADOPTED', () => mintUuid());
    const remapped = applyAssetMap(
      out.items,
      new Map([
        [
          'cmtgvpgwa036d073v6gvrao0x',
          {
            id: 'cnewasset000000000000000',
            path: `mondrian/assets/blockument/${NEW_BID}/cnewasset000000000000000.png`,
          },
        ],
      ]),
    );
    const img = remapped.find((i) => i.type === 'image')!;
    expect(Object.keys(img.assets!)).toEqual(['cnewasset000000000000000']);
    const rec = img.assets!['cnewasset000000000000000']!;
    expect(rec.path).toBe(`mondrian/assets/blockument/${NEW_BID}/cnewasset000000000000000.png`);
    expect(rec.name).toBe('astronaut.png'); // metadata survives
    expect(rec.width).toBe(2476);
    const fill = (img.states as Record<string, { fill: { assetId: string } }>)['default']!.fill;
    expect(fill.assetId).toBe('cnewasset000000000000000');
    // no old references anywhere
    expect(JSON.stringify(remapped)).not.toContain('cmtgvpgwa036d073v6gvrao0x');
    expect(JSON.stringify(remapped)).not.toContain(SRC_BID);
  });
});
