// Mondrian (Custom block) blockument migration — plan + executor facet
// (docs/rise-api-reference.md §mondrian; 2026-08-31 captures).
import { describe, it, expect } from 'vitest';
import { buildPlan, type PlanInput } from './plan';
import { executePlan } from './executor';
import { IdMap } from './ids';
import { counterMint, mockRelay, happyHandlers } from './executor.fixtures';
import type { BlockumentGraph } from '@/core/mondrian';

const SRC_BID = '1133557f-ae63-402e-bdf3-959e5cf4506c';
const NEW_BID = 'aaaa1111-0000-4000-8000-000000000001';
const CANVAS_ID = 'bbbb2222-0000-4000-8000-000000000002';

function counterUuid(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

function graph(): BlockumentGraph {
  return {
    blockuments: {
      [SRC_BID]: {
        id: SRC_BID,
        title: 'Quotation Cards',
        children: [{ id: 'root-0000', visualOrder: 0 }],
        triggers: [],
        authoringOpened: true,
        responsive: false,
        _v: 47,
      },
    },
    items: {
      'root-0000': {
        id: 'root-0000',
        blockumentId: SRC_BID,
        parentId: SRC_BID,
        type: 'group',
        name: 'Canvas',
        states: { default: {} },
      },
      'img-0001': {
        id: 'img-0001',
        blockumentId: SRC_BID,
        parentId: 'root-0000',
        type: 'image',
        states: { default: { fill: { opacity: 1, assetId: 'coldasset000000000000000' } } },
        assets: {
          coldasset000000000000000: {
            id: 'coldasset000000000000000',
            path: `mondrian/assets/blockument/${SRC_BID}/coldasset000000000000000.png`,
            name: 'pic.png',
            type: 'image',
          },
        },
      },
    },
    fonts: null,
  };
}

function mondrianCourse(): PlanInput {
  return {
    author: 'auth0|target',
    targetFolderId: 'all',
    assets: [
      {
        key: `mondrian/assets/blockument/${SRC_BID}/coldasset000000000000000.png`,
        kind: 'media-mondrian-asset',
        file: 'assets/m.png',
        ext: 'png',
      },
      { key: 'rise/courses/SRC/bg.png', kind: 'media-image', file: 'assets/bg.png', ext: 'png' },
    ],
    banksById: new Map(),
    blockuments: new Map([[SRC_BID, graph()]]),
    course: {
      course: { id: 'SRC', title: 'Custom course', theme: { themeId: 'classic' } },
      lessons: [
        {
          id: 'L1',
          position: 0,
          type: 'blocks',
          title: 'Lesson 1',
          icon: 'Article',
          items: [
            {
              id: 'cmondrianblock000000000000',
              family: 'mondrian',
              variant: 'mondrian',
              type: 'custom',
              settings: {},
              background: { media: { image: { key: 'rise/courses/SRC/bg.png', type: 'image' } } },
              blockumentId: SRC_BID,
            },
          ],
        },
      ],
    },
  };
}

const mondrianHandlers = {
  ...happyHandlers,
  createFromBlank: () => ({
    blockuments: { [NEW_BID]: { id: NEW_BID, title: 'Custom Block', children: [], _v: 47 } },
    items: {
      [CANVAS_ID]: { id: CANVAS_ID, blockumentId: NEW_BID, parentId: NEW_BID, type: 'group' },
    },
  }),
  'signed-asset-url': () => ({
    asset: {
      id: 'cnewasset000000000000000',
      path: `mondrian/assets/blockument/${NEW_BID}/cnewasset000000000000000.png`,
      name: 'pic.png',
      type: 'image',
    },
    mimeType: 'image/png',
    url: 'https://s3/mondrian-put',
  }),
  '/transaction': () => 'OK',
  CRUSH_IMAGE: () => ({ payload: { key: 'rise/courses/NEWCOURSE/crushed.png' } }),
};

describe('plan — mondrian blocks', () => {
  it('emits create-blockument BEFORE the lesson create-blocks', () => {
    const steps = buildPlan(mondrianCourse());
    const kinds = steps.map((s) => s.kind);
    const cb = kinds.indexOf('create-blockument');
    const blocks = kinds.indexOf('create-blocks');
    expect(cb).toBeGreaterThanOrEqual(0);
    expect(cb).toBeLessThan(blocks);
    const step = steps[cb] as Extract<(typeof steps)[number], { kind: 'create-blockument' }>;
    expect(step.sourceBlockumentId).toBe(SRC_BID);
    expect(step.itemCount).toBe(2);
  });

  it('ABORTS the plan when a referenced blockument has no archived graph', () => {
    const input = mondrianCourse();
    input.blockuments = new Map();
    expect(() => buildPlan(input)).toThrow(/Mondrian cross-ref not covered by the archive/);
    input.blockuments = undefined;
    expect(() => buildPlan(input)).toThrow(/re-export the course/);
  });
});

describe('executePlan — mondrian happy path', () => {
  async function run() {
    const input = mondrianCourse();
    const steps = buildPlan(input);
    const { relay, calls } = mockRelay(mondrianHandlers);
    const sent: { url: string; body: unknown }[] = [];
    const recordingRelay: typeof relay = async (spec) => {
      sent.push({ url: spec.url, body: spec.body ? JSON.parse(spec.body) : undefined });
      return relay(spec);
    };
    const res = await executePlan(steps, {
      input,
      relay: recordingRelay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/png' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
      mintUuid: counterUuid(),
      targetPlane: 'eu',
    });
    return { res, calls, sent };
  }

  it('creates the blockument, uploads its asset, writes transactions, swaps the block ref', async () => {
    const { res, sent } = await run();
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.survivingKeys).toEqual([]);

    // createFromBlank parented to the NEW course, on the EU host.
    const create = sent.find((s) => s.url.includes('createFromBlank'))!;
    expect(create.url).toBe(
      'https://mondrian-api.eu.articulate.com/api/blockuments/createFromBlank',
    );
    expect(create.body).toEqual({ parentId: 'NEWCOURSE', parentType: 'course' });

    // asset chain: signed-asset-url → S3 PUT → CRUSH_IMAGE on the mondrian path
    const signed = sent.find((s) => s.url.includes('signed-asset-url'))!;
    expect(signed.body).toEqual({ name: 'pic.png', blockumentId: NEW_BID });
    expect(sent.some((s) => s.url === 'https://s3/mondrian-put')).toBe(true);
    const crush = sent.find((s) => s.url.includes('CRUSH_IMAGE'))!;
    expect((crush.body as { payload: { original: string } }).payload.original).toBe(
      `mondrian/assets/blockument/${NEW_BID}/cnewasset000000000000000.png`,
    );

    // transactions: doc first, then ALL items in ONE atomic upsert — per-item
    // writes 400 on the server's pruneManifest (children refs must exist in
    // the post-transaction state; live 2026-08-31).
    const txs = sent.filter((s) => s.url.includes('/transaction'));
    expect(txs.length).toBe(2); // 1 doc + 1 items map
    expect(txs[0]!.url).toContain(NEW_BID);
    const docTx = txs[0]!.body as { blockument: { id: string; children: { id: string }[] } };
    expect(docTx.blockument.id).toBe(NEW_BID);
    expect(docTx.blockument.children[0]!.id).toBe(CANVAS_ID);
    const itemsTx = txs[1]!.body as { items: Record<string, { parentId: string }> };
    const itemIds = Object.keys(itemsTx.items);
    expect(itemIds).toHaveLength(2); // canvas + image, one consistent set
    expect(itemIds).toContain(CANVAS_ID);
    // no old ids/paths anywhere in the transactions
    const blob = JSON.stringify(txs);
    expect(blob).not.toContain(SRC_BID);
    expect(blob).not.toContain('coldasset000000000000000');
    expect(blob).not.toContain('img-0001');

    // the CREATE_BLOCKS payload carries the NEW blockumentId
    const cb = sent.find((s) => s.url.includes('CREATE_BLOCKS'))!;
    const payload = (cb.body as { payload: { blocks: { blockumentId: string }[] } }).payload;
    expect(payload.blocks[0]!.blockumentId).toBe(NEW_BID);

    // the block's MEDIA PATCH (a full-state UPDATE_BLOCK_DEBOUNCE) must carry
    // the NEW blockumentId too — the pre-swap normalized block would REVERT it
    // to the dangling source id (live 2026-08-31, all 11 Spaceship blocks).
    const patch = sent.find((s) => s.url.includes('UPDATE_BLOCK_DEBOUNCE'))!;
    const item = (patch.body as { payload: { item: Record<string, unknown> } }).payload.item;
    expect(item.blockumentId).toBe(NEW_BID);
    expect(JSON.stringify(item)).not.toContain(SRC_BID);
  });

  it('dry-run predicts the same envelopes without sending', async () => {
    const input = mondrianCourse();
    const steps = buildPlan(input);
    const { relay, calls } = mockRelay(mondrianHandlers);
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => null,
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
      mintUuid: counterUuid(),
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    expect(res.survivingKeys).toEqual([]);
    expect(calls.length).toBe(0); // nothing sent
    const labels = res.envelopes.map((e) => e.label);
    expect(labels.some((l) => l.includes('createFromBlank'))).toBe(true);
    expect(labels.some((l) => l.includes('signed-asset-url'))).toBe(true);
    expect(labels.filter((l) => l.includes('transaction')).length).toBe(2);
  });

  it('fails loudly when the target plane is unknown (live run)', async () => {
    const input = mondrianCourse();
    const steps = buildPlan(input);
    const { relay } = mockRelay(mondrianHandlers);
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/png' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
      mintUuid: counterUuid(),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/plane unknown/i);
  });
});
