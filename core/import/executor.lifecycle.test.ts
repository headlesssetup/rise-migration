import { describe, it, expect } from 'vitest';
import { buildPlan, type PlanInput } from './plan';
import { executePlan, type Relay, type RelayResponse } from './executor';
import { IdMap } from './ids';
import { counterMint, mockRelay, imageCourse, happyHandlers } from './executor.fixtures';

describe('executePlan — transactional rollback (no phantom in root)', () => {
  // A relay that creates the shell, records any soft-delete, and lets the caller
  // override any authoring write (return null to fall through to happy defaults,
  // which let a course materialize via CREATE_LESSON).
  function rollbackRelay(onWrite: (label: string) => RelayResponse | null): {
    relay: Relay;
    deleted: string[][];
  } {
    const deleted: string[][] = [];
    const relay: Relay = async (spec) => {
      if (spec.url.includes('/manage/api/content/soft-delete')) {
        deleted.push((JSON.parse(spec.body!) as { ids: string[] }).ids);
        return { ok: true, status: 200, text: '{}' };
      }
      const override = onWrite(spec.label);
      if (override) return override;
      if (spec.url.includes('/manage/api/content')) {
        return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      }
      if (spec.label.includes('GET_COURSE')) {
        return { ok: true, status: 200, text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }) };
      }
      if (spec.label.includes('CREATE_LESSON')) {
        return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON', createdAt: 't' } } }) };
      }
      if (spec.label.includes('CREATE_BLOCKS')) {
        const blocks = (JSON.parse(spec.body!) as { payload: { blocks: { id: string }[] } }).payload.blocks;
        return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: blocks.map((b) => ({ id: b.id, globalBlockId: 'g' })) } }) };
      }
      if (spec.label.includes('GET_YURL')) {
        return { ok: true, status: 200, text: JSON.stringify({ payload: { key: 'rise/courses/NEWCOURSE/s.jpg', url: 'https://s3/put', type: 'image/jpeg' } }) };
      }
      return { ok: true, status: 200, text: '{}' };
    };
    return { relay, deleted };
  }

  it('REPORTS (does not delete) an unconfirmed shell — no auto-delete', async () => {
    // POST /content returns an id, but the handshake GET_COURSE returns no course →
    // the shell didn't materialize. Automatic deletion is disabled (operator
    // decision): leave it in place and report orphanedCourseId for manual cleanup.
    const input = imageCourse();
    const { relay, deleted } = rollbackRelay((label) =>
      label.includes('GET_COURSE') ? { ok: true, status: 200, text: '{}' } : null,
    );
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => null,
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(false);
    expect(res.orphanedCourseId).toBe('NEWCOURSE');
    expect(deleted).toEqual([]); // nothing is auto-deleted
  });

  it('does NOT roll back once the course has materialized (partial import kept)', async () => {
    // Shell + first lesson succeed (course is now real), then a block write fails.
    const input = imageCourse();
    const { relay, deleted } = rollbackRelay((label) =>
      label.includes('CREATE_BLOCKS') ? { ok: false, status: 500, text: 'boom' } : null,
    );
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => null,
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(false); // the import failed…
    expect(res.rolledBack).toBeUndefined(); // …but the materialized course is kept
    expect(deleted).toEqual([]);
  });

  it('KEEPS a content-less shell (a bare titleless/lessonless course is valid)', async () => {
    // Capture-confirmed: POST /content alone is a real course. With the handshake
    // confirming it, a lesson-less import is a success, not a rollback.
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [],
      banksById: new Map(),
      course: { course: { id: 'SRC', title: 'Empty' }, lessons: [] },
    };
    const { relay, deleted } = rollbackRelay(() => null);
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => null,
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    expect(res.rolledBack).toBeUndefined();
    expect(deleted).toEqual([]);
  });

  it('does NOT roll back a materialized course (lesson created)', async () => {
    const input = imageCourse();
    const { relay, calls } = mockRelay(happyHandlers);
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    expect(res.rolledBack).toBeUndefined();
    expect(calls.some((c) => c.url.includes('/content/soft-delete'))).toBe(false);
  });

  it('does NOT roll back in dry-run', async () => {
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [],
      banksById: new Map(),
      course: { course: { id: 'SRC', title: 'Empty' }, lessons: [] },
    };
    const { relay, deleted } = rollbackRelay(() => null);
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => null,
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
      dryRun: true,
    });
    expect(deleted).toEqual([]);
    expect(res.rolledBack).toBeUndefined();
  });
});

describe('executePlan — dry run', () => {
  it('collects every envelope without relaying', async () => {
    const input = imageCourse();
    const steps = buildPlan(input);
    let relayed = 0;
    const relay: Relay = async () => {
      relayed++;
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => null,
      dryRun: true,
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(relayed).toBe(0); // nothing sent
    expect(res.ok).toBe(true);
    expect(res.envelopes.length).toBeGreaterThan(0);
    // dry-run still synthesizes a course id so downstream steps resolve
    expect(res.newCourseId).toBeTruthy();
    expect(res.envelopes.some((e) => e.label.includes('CREATE_BLOCKS'))).toBe(true);
    expect(res.envelopes.some((e) => e.label.includes('S3 PUT'))).toBe(true);
  });
});

describe('executePlan — loud fail', () => {
  it('aborts when CREATE_BLOCKS does not confirm the sent id', async () => {
    const input = imageCourse();
    const steps = buildPlan(input);
    const { relay } = mockRelay({
      ...happyHandlers,
      'CREATE_BLOCKS': () => ({ payload: { success: true, blockMetadata: [{ id: 'WRONG' }] } }),
    });
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/create-block/);
  });

  it('aborts on a non-ok HTTP response', async () => {
    const input = imageCourse();
    const steps = buildPlan(input);
    const relay: Relay = async (spec) => {
      if (spec.label.includes('GET_COURSE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }) };
      if (spec.label.includes('CREATE_LESSON')) return { ok: false, status: 500, text: 'boom' };
      return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
    };
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => null,
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/HTTP 500/);
  });
});

describe('executePlan — graceful stop', () => {
  it('stops cleanly between steps, keeps the partial course (no rollback) + returns the resume map', async () => {
    const input = imageCourse();
    const { relay, calls } = mockRelay(happyHandlers);
    let checks = 0;
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
      // Let the course shell (step 1) get created, then stop at the 4th step.
      shouldStop: () => ++checks > 3,
    });
    expect(res.stopped).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.newCourseId).toBe('NEWCOURSE'); // shell created before the stop
    expect(Object.keys(res.idMap).length).toBeGreaterThan(0); // resumable job log
    expect(res.orphanedCourseId).toBeUndefined(); // kept (resumable), not orphaned
    expect(calls.some((c) => c.url.includes('/content/soft-delete'))).toBe(false);
  });

  it('stops before the first step without creating anything', async () => {
    const input = imageCourse();
    const { relay, calls } = mockRelay(happyHandlers);
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => null,
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
      shouldStop: () => true,
    });
    expect(res.stopped).toBe(true);
    expect(res.newCourseId).toBeUndefined();
    expect(calls.length).toBe(0); // nothing was sent
  });
});
