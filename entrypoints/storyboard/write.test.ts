import { describe, expect, it } from 'vitest';
import type { BuiltCourse } from '@/core/storyboard';
import type { Storage } from '@/core/storage/storage';
import { inspectLocalArchive } from '@/core/local-archive';
import { readCreatorBuildWarning, writeBuiltCourse } from './write';

function fakeStorage(initialLock?: string) {
  const courses = new Map<string, string>();
  const artifacts = new Map<string, string>();
  if (initialLock) artifacts.set('build.lock', initialLock);
  const manifestStates: string[] = [];
  let manifest: string | null = null;
  const storage = {
    writeCourse: async (id: string, raw: string) => void courses.set(id, raw),
    readCourse: async (id: string) => courses.get(id) ?? null,
    listSaved: async () => [...courses.keys()],
    readManifest: async () => manifest,
    writeManifest: async (value: unknown) => {
      manifest = JSON.stringify(value);
      manifestStates.push((value as { state: string }).state);
    },
    readAssetManifest: async () => null,
    readAsset: async () => null,
    writeCreatorArtifact: async (name: string, contents: string) =>
      void artifacts.set(name, contents),
    readCreatorArtifact: async (name: string) => artifacts.get(name) ?? null,
    removeCreatorArtifact: async (name: string) => void artifacts.delete(name),
  } as unknown as Storage;
  return { storage, courses, artifacts, manifestStates };
}

const BUILT: BuiltCourse = {
  courseId: 'sb-c1',
  raw: '{"course":{"id":"sb-c1","title":"Testa kurss","type":null},"lessons":[]}',
  manifestEntry: { id: 'sb-c1', title: 'Testa kurss' },
  planJson: '{"blueprint":true}',
  productionMd: '# skripti',
  lessonCount: 1,
  blockCount: 2,
  notes: [],
  registryRevision: '2026-08-14.1',
  registryWarnings: ['text: compiler-tested'],
};

describe('writeBuiltCourse', () => {
  it('writes one complete v1 Creator package and clears the build lock last', async () => {
    const fs = fakeStorage();
    const files = await writeBuiltCourse(
      fs.storage,
      BUILT,
      '2026-08-10T00:00:00Z',
      '0.8.0',
      'source.docx',
    );

    expect(fs.courses.get('sb-c1')).toBe(BUILT.raw);
    expect(fs.manifestStates).toEqual(['building', 'ready']);
    expect(fs.artifacts.has('build.lock')).toBe(false);
    expect(fs.artifacts.get('sb-c1.blueprint.json')).toBe('{"blueprint":true}');
    expect(fs.artifacts.get('sb-c1.production.md')).toBe('# skripti');
    expect(files).toMatchObject({
      courseFile: 'courses/sb-c1.json',
      manifestFile: 'manifest.json',
      planFile: '_creator/sb-c1.blueprint.json',
      productionFile: '_creator/sb-c1.production.md',
    });

    const inspected = await inspectLocalArchive(fs.storage);
    expect(inspected).toMatchObject({ kind: 'v1', ready: true, origin: 'creator' });
    expect(inspected.courses).toEqual([
      { id: 'sb-c1', title: 'Testa kurss', type: null },
    ]);
  });

  it('warns but does not block when a previous interrupted-build lock exists', async () => {
    const fs = fakeStorage(
      JSON.stringify({ startedAt: '2026-08-09T01:02:03Z', sourceFile: 'old.pptx' }),
    );
    expect(await readCreatorBuildWarning(fs.storage)).toMatch(/old\.pptx.*did not finish/);

    const files = await writeBuiltCourse(fs.storage, BUILT, 'now', '0.8.0');
    expect(files.priorBuildWarning).toMatch(/did not finish/);
    expect(fs.artifacts.has('build.lock')).toBe(false);
  });
});
