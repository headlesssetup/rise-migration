import { describe, expect, it } from 'vitest';
import type { BuiltCourse } from '@/core/storyboard';
import type { Storage } from '@/core/storage/storage';
import { writeBuiltCourse } from './write';

/** Minimal fake Storage: only the members the write path touches. */
function fakeStorage(initialManifest?: string) {
  const courses = new Map<string, string>();
  const artifacts = new Map<string, string>();
  let manifest = initialManifest ?? null;
  const storage = {
    writeCourse: async (id: string, raw: string) => void courses.set(id, raw),
    readManifest: async () => manifest,
    writeManifest: async (m: unknown) => void (manifest = JSON.stringify(m)),
    writeImportArtifact: async (name: string, contents: string) =>
      void artifacts.set(name, contents),
  } as unknown as Storage;
  return {
    storage,
    courses,
    artifacts,
    manifest: () => (manifest ? (JSON.parse(manifest) as Record<string, unknown>) : null),
  };
}

const BUILT: BuiltCourse = {
  courseId: 'sb-c1',
  raw: '{"course":{"id":"sb-c1"},"lessons":[]}',
  manifestEntry: { id: 'sb-c1', title: 'Testa kurss' },
  planJson: '{"plan":true}',
  productionMd: '# skripti',
  lessonCount: 1,
  blockCount: 2,
  notes: [],
};

describe('writeBuiltCourse', () => {
  it('writes the course, MERGES the manifest course list, and stores artifacts', async () => {
    const prior = JSON.stringify({
      sourceAccount: { name: 'ACME US', plane: 'us' },
      courses: [{ id: 'old1', title: 'Vecais kurss' }],
    });
    const fs = fakeStorage(prior);
    const files = await writeBuiltCourse(fs.storage, BUILT, '2026-08-10T00:00:00Z');

    expect(fs.courses.get('sb-c1')).toBe(BUILT.raw);
    const m = fs.manifest()!;
    // Merged, never overwritten — and unrelated manifest fields preserved.
    expect(m.courses).toEqual([
      { id: 'old1', title: 'Vecais kurss' },
      { id: 'sb-c1', title: 'Testa kurss' },
    ]);
    expect((m.sourceAccount as { name: string }).name).toBe('ACME US');
    expect(fs.artifacts.get('storyboard-sb-c1.plan.json')).toBe('{"plan":true}');
    expect(fs.artifacts.get('storyboard-sb-c1.production.md')).toBe('# skripti');
    expect(files.courseFile).toBe('courses/sb-c1.json');
  });

  it('creates a manifest when the archive has none', async () => {
    const fs = fakeStorage();
    await writeBuiltCourse(fs.storage, BUILT, '2026-08-10T00:00:00Z');
    expect(fs.manifest()!.courses).toEqual([{ id: 'sb-c1', title: 'Testa kurss' }]);
  });

  it('re-approving the same course updates its row instead of duplicating it', async () => {
    const fs = fakeStorage();
    await writeBuiltCourse(fs.storage, BUILT, 't1');
    await writeBuiltCourse(
      fs.storage,
      { ...BUILT, manifestEntry: { id: 'sb-c1', title: 'Jauns nosaukums' } },
      't2',
    );
    expect(fs.manifest()!.courses).toEqual([{ id: 'sb-c1', title: 'Jauns nosaukums' }]);
  });
});
