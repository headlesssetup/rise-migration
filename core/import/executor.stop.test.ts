import { describe, expect, it } from 'vitest';
import { executePlan } from './executor';
import { buildPlan, type PlanInput } from './plan';
import { IdMap } from './ids';
import { counterMint, mockRelay, happyHandlers } from './executor.fixtures';

function simpleCourse(): PlanInput {
  return {
    author: 'auth0|t',
    targetFolderId: 'all',
    assets: [],
    banksById: new Map(),
    course: {
      course: { id: 'SRC', title: 'My Course' },
      lessons: [
        { id: 'L1', position: 0, type: 'blocks', title: 'L1', items: [] },
        { id: 'L2', position: 1, type: 'blocks', title: 'L2', items: [] },
      ],
    },
  };
}

describe('executePlan — graceful stop marks the partial course title', () => {
  it('amends the title to "!unfinished: <title>" once the course exists', async () => {
    const input = simpleCourse();
    const steps = buildPlan(input);

    let titleSet: string | undefined;
    // Note: our key must precede happyHandlers' 'UPDATE_COURSE' (substring match).
    const { relay } = mockRelay({
      UPDATE_COURSE_FIELD_THROTTLE: (body: any) => {
        titleSet = body?.payload?.course?.title;
        return { payload: {} };
      },
      ...happyHandlers,
    });

    // Stop right after the course shell is created (2nd checkpoint).
    let checks = 0;
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => ({ base64: '', contentType: '' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
      shouldStop: () => ++checks > 1,
    });

    expect(res.stopped).toBe(true);
    expect(res.newCourseId).toBe('NEWCOURSE');
    expect(titleSet).toBe('!unfinished: My Course');
  });

  it('paces the stop-path title write like any other authoring write (8a)', async () => {
    const input = simpleCourse();
    const steps = buildPlan(input);
    // Record the interleaving of paced gaps and relayed writes.
    const events: string[] = [];
    const { relay } = mockRelay(happyHandlers);
    const tracingRelay: typeof relay = async (spec) => {
      events.push(`relay:${spec.label}`);
      return relay(spec);
    };
    let checks = 0;
    const res = await executePlan(steps, {
      input,
      relay: tracingRelay,
      readAsset: async () => ({ base64: '', contentType: '' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
      pace: async () => {
        events.push('pace');
      },
      shouldStop: () => ++checks > 1, // stop right after the course shell exists
    });
    expect(res.stopped).toBe(true);
    const titleIdx = events.findIndex((e) => e.includes('UPDATE_COURSE_FIELD_THROTTLE'));
    expect(titleIdx).toBeGreaterThan(0);
    expect(events[titleIdx - 1]).toBe('pace'); // the write was paced, not fired raw
  });

  it('does not amend when no course was created yet (stop at step 1)', async () => {
    const input = simpleCourse();
    const steps = buildPlan(input);
    let titleSet: string | undefined;
    const { relay } = mockRelay({
      UPDATE_COURSE_FIELD_THROTTLE: (body: any) => {
        titleSet = body?.payload?.course?.title;
        return { payload: {} };
      },
      ...happyHandlers,
    });
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => ({ base64: '', contentType: '' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
      shouldStop: () => true, // stop before the very first step
    });
    expect(res.stopped).toBe(true);
    expect(res.newCourseId).toBeUndefined();
    expect(titleSet).toBeUndefined();
  });
});
