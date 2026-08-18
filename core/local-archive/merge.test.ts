import { describe, expect, it } from 'vitest';
import {
  mergeById,
  parseIdRows,
  parseManifestCourses,
  type ManifestCourseEntry,
} from './merge';

describe('mergeById', () => {
  it('unions successive batches: old rows kept, new ids appended', () => {
    const monday = [{ id: 'a' }, { id: 'b' }];
    const tuesday = [{ id: 'c' }];
    expect(mergeById(monday, tuesday).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the newest metadata for a re-exported id, in place', () => {
    const prev = [
      { id: 'a', title: 'Old', updatedAt: '2026-01-01' },
      { id: 'b', title: 'B' },
    ];
    const next = [{ id: 'a', title: 'New', updatedAt: '2026-07-01' }];
    expect(mergeById(prev, next)).toEqual([
      { id: 'a', title: 'New', updatedAt: '2026-07-01' },
      { id: 'b', title: 'B' },
    ]);
  });

  it('does not let an undefined field erase what is on disk', () => {
    const prev = [{ id: 'a', title: 'Recorded' }];
    const next: ManifestCourseEntry[] = [{ id: 'a', title: undefined }];
    expect(mergeById(prev, next)).toEqual([{ id: 'a', title: 'Recorded' }]);
  });

  it('is a no-op on an empty batch either way', () => {
    expect(mergeById([{ id: 'a' }], [])).toEqual([{ id: 'a' }]);
    expect(mergeById([], [{ id: 'a' }])).toEqual([{ id: 'a' }]);
  });
});

describe('parseIdRows', () => {
  it('reads a bare array and the {items:[…]} wrapper', () => {
    expect(parseIdRows('[{"id":"a"},{"id":"b"}]')).toHaveLength(2);
    expect(parseIdRows('{"items":[{"id":"a"}]}')).toHaveLength(1);
  });

  it('drops rows without a string id, and tolerates junk', () => {
    expect(parseIdRows('[{"id":"a"},{"id":7},null,"x",{}]').map((r) => r.id)).toEqual(['a']);
    expect(parseIdRows('not json')).toEqual([]);
    expect(parseIdRows('null')).toEqual([]);
    expect(parseIdRows('12')).toEqual([]);
    expect(parseIdRows(null)).toEqual([]);
  });
});

describe('parseManifestCourses', () => {
  it('reads manifest.courses', () => {
    const raw = JSON.stringify({
      courseCount: 2,
      courses: [{ id: 'a', title: 'A' }, { id: 'b' }],
    });
    expect(parseManifestCourses(raw)).toEqual([{ id: 'a', title: 'A' }, { id: 'b' }]);
  });

  it('returns [] for a missing/older/corrupt manifest', () => {
    expect(parseManifestCourses(null)).toEqual([]);
    expect(parseManifestCourses('{}')).toEqual([]);
    expect(parseManifestCourses('{"courses":"nope"}')).toEqual([]);
    expect(parseManifestCourses('{oops')).toEqual([]);
  });
});
