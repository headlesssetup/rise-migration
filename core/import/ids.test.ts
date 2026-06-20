import { describe, it, expect } from 'vitest';
import { createIdFactory, IdMap, looksLikeClientId, newId } from './ids';

describe('createIdFactory', () => {
  it('mints cuid-style ids (leading c, ~25 lowercase alnum)', () => {
    const mint = createIdFactory();
    for (let i = 0; i < 50; i++) {
      const id = mint();
      expect(id).toMatch(/^c[a-z0-9]{20,30}$/);
      expect(looksLikeClientId(id)).toBe(true);
    }
  });

  it('does not collide across a tight loop (counter guards same-ms)', () => {
    const mint = createIdFactory(
      () => 1_700_000_000_000, // frozen clock
      () => 0.5, // frozen rng
    );
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(mint());
    expect(seen.size).toBe(1000);
  });

  it('the default factory works', () => {
    expect(looksLikeClientId(newId())).toBe(true);
  });
});

describe('looksLikeClientId', () => {
  it('accepts captured Rise ids', () => {
    for (const id of [
      'cmqjv8g0g002i3b7oabdf4pav',
      'clcor7zx5000k357c1o6xfhrm',
      's0y091ulciwiec3038eylovq',
    ]) {
      expect(looksLikeClientId(id)).toBe(true);
    }
  });

  it('rejects non-ids', () => {
    expect(looksLikeClientId('')).toBe(false);
    expect(looksLikeClientId('Z47')).toBe(false); // too short
    expect(looksLikeClientId('f2736c59-3152-408f')).toBe(false); // uuid (dashes)
    expect(looksLikeClientId(42)).toBe(false);
    expect(looksLikeClientId(undefined)).toBe(false);
  });
});

describe('IdMap', () => {
  it('remap is idempotent and consistent per source id', () => {
    let n = 0;
    const map = new IdMap(() => `new${n++}`);
    const a = map.remap('old-a');
    const b = map.remap('old-b');
    expect(map.remap('old-a')).toBe(a); // same source → same target
    expect(a).not.toBe(b);
    expect(map.has('old-a')).toBe(true);
    expect(map.get('old-a')).toBe(a);
  });

  it('set records a server-assigned mapping', () => {
    const map = new IdMap(() => 'unused');
    map.set('srcCourse', 'serverCourseId');
    expect(map.get('srcCourse')).toBe('serverCourseId');
  });

  it('round-trips through JSON for the resumable job log', () => {
    let n = 0;
    const map = new IdMap(() => `m${n++}`);
    map.remap('x');
    map.set('y', 'server-y');
    const json = map.toJSON();
    const restored = IdMap.fromJSON(json, () => 'fresh');
    expect(restored.get('x')).toBe(map.get('x'));
    expect(restored.get('y')).toBe('server-y');
    // a resumed run reuses prior mappings, only minting for unseen ids
    expect(restored.remap('x')).toBe(map.get('x'));
    expect(restored.remap('z')).toBe('fresh');
  });
});
