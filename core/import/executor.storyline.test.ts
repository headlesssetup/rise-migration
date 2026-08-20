import { describe, expect, it } from 'vitest';
import { executePlan, blockKey } from './executor';
import { buildPlan, type PlanInput } from './plan';
import { IdMap } from './ids';
import { counterMint, mockRelay, happyHandlers } from './executor.fixtures';

function storylineCourse(attach: PlanInput['storylineAttach']): PlanInput {
  return {
    author: 'auth0|t',
    targetFolderId: 'all',
    assets: [],
    banksById: new Map(),
    storylineAttach: attach,
    course: {
      course: { id: 'SRC', title: 'C' },
      lessons: [
        {
          id: 'L1',
          position: 0,
          type: 'blocks',
          title: 'L',
          items: [
            {
              id: 'cblock00000000000000000000',
              family: '360',
              variant: 'storyline',
              items: [{ id: 'citem000000000000000000000' }],
            },
          ],
        },
      ],
    },
  };
}

describe('executePlan — storyline attach', () => {
  it('copies the review item then patches media.storyline (no manual flag)', async () => {
    const input = storylineCourse(
      new Map([
        [
          blockKey('L1', 'cblock00000000000000000000'),
          { reviewPrefix: 'review/items/LEAF1', meta: { title: 'S1' }, title: 'S1' },
        ],
      ]),
    );
    const steps = buildPlan(input);
    let copyBody: any;
    let storyline: any;
    const { relay } = mockRelay({
      ...happyHandlers,
      copy_review_item: (body: any) => {
        copyBody = body;
        return [];
      },
      UPDATE_BLOCK_DEBOUNCE: (body: any) => {
        const sl = body?.payload?.item?.items?.[0]?.media?.storyline;
        if (sl) storyline = sl;
        return { payload: { success: true } };
      },
    });
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => ({ base64: '', contentType: '' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });

    expect(res.ok).toBe(true);
    expect(res.storylineAttached).toBe(1);
    expect(res.flags.some((f) => f.kind === 'storyline')).toBe(false);

    // copy_review_item fired with the review prefix + the new block id as jobId
    expect(copyBody).toMatchObject({ reviewPrefix: 'review/items/LEAF1', id: 'NEWCOURSE' });
    expect(typeof copyBody.jobId).toBe('string');

    // the block was patched with media.storyline pointing at the copied bundle
    expect(storyline).toMatchObject({
      contentPrefix: 'rise/courses/NEWCOURSE/LEAF1',
      src: 'rise/courses/NEWCOURSE/LEAF1/story.html',
      processing: false,
      type: 'storyline',
    });
  });

  it('falls back to a manual flag when the package was not uploaded', async () => {
    const input = storylineCourse(undefined);
    const steps = buildPlan(input);
    let copied = false;
    const { relay } = mockRelay({
      ...happyHandlers,
      copy_review_item: () => {
        copied = true;
        return [];
      },
    });
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => ({ base64: '', contentType: '' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.flags.some((f) => f.kind === 'storyline')).toBe(true);
    expect(res.storylineAttached ?? 0).toBe(0);
    expect(copied).toBe(false);
  });

  it('creates a visible text placeholder for a known legacy package', async () => {
    const input = storylineCourse(
      new Map([
        [
          blockKey('L1', 'cblock00000000000000000000'),
          { reviewPrefix: 'review/items/STALE' },
        ],
      ]),
    );
    const item = input.course.lessons![0]!.items![0] as any;
    item.items[0].media = {
      storyline: {
        contentPrefix: 'rise/courses/SRC/OLD',
        meta: { version: '3.48.24159.0' },
      },
    };
    let created: any[] = [];
    let copied = false;
    const { relay } = mockRelay({
      ...happyHandlers,
      CREATE_BLOCKS: (body: any) => {
        created = body.payload.blocks;
        return {
          payload: {
            success: true,
            blockMetadata: created.map((block) => ({ id: block.id })),
          },
        };
      },
      copy_review_item: () => {
        copied = true;
        return [];
      },
    });
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => null,
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    expect(created[0]).toMatchObject({
      family: 'text',
      variant: 'paragraph',
      items: [{ paragraph: expect.stringContaining('Legacy Storyline block') }],
    });
    expect(res.flags[0]?.detail).toContain('incompatible with Review 360');
    expect(copied).toBe(false);
  });
});

// Regression (observed 2026-08-20, live course went PARTIAL): the attach's
// UPDATE_BLOCK_DEBOUNCE used to rebuild its payload from the RAW source block —
// for a non-cuid source block id (freshClientIds re-mints those per call) the
// item payload carried the source id and the server 404'd "Block not found in
// lesson". The attach must rebuild from the block AS CREATED.
describe('executePlan — storyline attach with a non-cuid source block id', () => {
  it('the attach update targets the CREATED block id', async () => {
    const sourceId = 'a7aee4ad-095d-443a-8cde-aedd7fb35e0f';
    const input = storylineCourse(
      new Map([
        [
          blockKey('L1', sourceId),
          { reviewPrefix: 'review/items/LEAF1', meta: { title: 'S1' }, title: 'S1' },
        ],
      ]),
    );
    (input.course.lessons![0]!.items![0] as { id: string }).id = sourceId;
    let createdId: string | undefined;
    let update: any;
    const { relay } = mockRelay({
      ...happyHandlers,
      CREATE_BLOCKS: (body: any) => {
        createdId = body.payload.blocks[0].id;
        return { payload: { success: true, blockMetadata: [{ id: createdId, globalBlockId: 'g1' }] } };
      },
      copy_review_item: () => [],
      UPDATE_BLOCK_DEBOUNCE: (body: any) => {
        update = body.payload;
        return { payload: { success: true } };
      },
    });
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => ({ base64: '', contentType: '' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });

    expect(res.ok).toBe(true);
    expect(res.storylineAttached).toBe(1);
    expect(createdId).toBeTruthy();
    expect(update).toBeTruthy();
    expect(update.id).toBe(createdId);
    expect(update.item.id).toBe(createdId);
    expect(JSON.stringify(update)).not.toContain(sourceId);
  });
});
