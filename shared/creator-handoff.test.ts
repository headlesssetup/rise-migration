import { describe, expect, it } from 'vitest';
import {
  getPendingBlueprint,
  putPendingBlueprint,
  removePendingBlueprint,
  type HandoffArea,
} from './creator-handoff';

function fakeArea(): HandoffArea & { size(): number } {
  const store = new Map<string, unknown>();
  return {
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
    remove: async (key) => void store.delete(key),
    size: () => store.size,
  };
}

describe('creator handoff slots', () => {
  it('round-trips a pasted blueprint through its own slot', async () => {
    const area = fakeArea();
    const id = await putPendingBlueprint('{"title":"x"}', 'deck.json', area);
    const got = await getPendingBlueprint(id, area);
    expect(got).toMatchObject({ pastedText: '{"title":"x"}', fileName: 'deck.json' });
    expect(typeof got?.createdAt).toBe('string');
  });

  it('keeps multiple pending blueprints in independent slots', async () => {
    const area = fakeArea();
    const a = await putPendingBlueprint('aaa', null, area);
    const b = await putPendingBlueprint('bbb', null, area);
    expect(a).not.toBe(b);
    expect((await getPendingBlueprint(a, area))?.pastedText).toBe('aaa');
    expect((await getPendingBlueprint(b, area))?.pastedText).toBe('bbb');
  });

  it('returns null for a missing/removed slot (the review page shows "expired")', async () => {
    const area = fakeArea();
    expect(await getPendingBlueprint('nope', area)).toBeNull();
    const id = await putPendingBlueprint('xyz', null, area);
    await removePendingBlueprint(id, area);
    expect(await getPendingBlueprint(id, area)).toBeNull();
    expect(area.size()).toBe(0);
  });

  it('surfaces a quota failure loudly and names the recovery', async () => {
    const area = fakeArea();
    area.set = async () => {
      throw new Error('QUOTA_BYTES exceeded');
    };
    await expect(putPendingBlueprint('big', null, area)).rejects.toThrow(
      /QUOTA_BYTES.*pasted text is untouched/s,
    );
  });
});
