import { describe, expect, it } from 'vitest';
import { classifyAssetFailures } from './import';

describe('classifyAssetFailures', () => {
  it('treats ONLY 403/404 as deleted-at-source orphans', () => {
    const { orphans, unresolved } = classifyAssetFailures([
      { key: 'a', status: 404 },
      { key: 'b', status: 403 },
    ]);
    expect(orphans.map((o) => o.key)).toEqual(['a', 'b']);
    expect(unresolved).toEqual([]);
  });

  it('keeps transient failures out of the orphan set (they must not drop media)', () => {
    const { orphans, unresolved } = classifyAssetFailures([
      { key: 'srv', status: 500 },
      { key: 'net', status: 0, error: 'TypeError: Failed to fetch' },
      { key: 'unknown', error: 'aborted' },
      { key: 'gone', status: 404 },
    ]);
    expect(orphans.map((o) => o.key)).toEqual(['gone']);
    expect(unresolved.map((u) => u.key)).toEqual(['srv', 'net', 'unknown']);
    expect(unresolved[1]).toMatchObject({ status: 0, error: 'TypeError: Failed to fetch' });
  });

  it('tolerates a manifest with no failures', () => {
    expect(classifyAssetFailures(undefined)).toEqual({ orphans: [], unresolved: [] });
    expect(classifyAssetFailures([])).toEqual({ orphans: [], unresolved: [] });
  });
});
