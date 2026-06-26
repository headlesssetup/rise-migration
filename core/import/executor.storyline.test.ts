import { describe, expect, it } from 'vitest';
import { executePlan } from './executor';
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
      new Map([['cblock00000000000000000000', { reviewPrefix: 'review/items/LEAF1', meta: { title: 'S1' }, title: 'S1' }]]),
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
});
