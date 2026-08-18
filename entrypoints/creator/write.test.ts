import { describe, expect, it } from 'vitest';
import type { BuiltCourse } from '@/core/creator/compiler';
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
    hasCourse: async (id: string) => courses.has(id),
    listSaved: async () => [...courses.keys()],
    readManifest: async () => manifest,
    writeManifest: async (value: unknown) => {
      manifest = JSON.stringify(value);
      manifestStates.push((value as { state: string }).state);
    },
    hasAssetManifest: async () => false,
    readAssetManifest: async () => null,
    hasAsset: async () => false,
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

  it('skips the production file entirely when there is no narration', async () => {
    const fs = fakeStorage();
    const files = await writeBuiltCourse(
      fs.storage,
      { ...BUILT, productionMd: null },
      '2026-08-10T00:00:00Z',
      '0.8.0',
    );
    expect(fs.artifacts.has('sb-c1.production.md')).toBe(false);
    expect(files.productionFile).toBeUndefined();
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

  it('MERGES into an existing creator-origin manifest: successive builds accumulate', async () => {
    const fs = fakeStorage();
    await writeBuiltCourse(fs.storage, BUILT, '2026-08-10T00:00:00Z', '0.9.0', 'a.pptx');
    const second: BuiltCourse = {
      ...BUILT,
      courseId: 'sb-c2',
      raw: '{"course":{"id":"sb-c2","title":"Otrais","type":null},"lessons":[]}',
      manifestEntry: { id: 'sb-c2', title: 'Otrais' },
      productionMd: null,
    };
    await writeBuiltCourse(fs.storage, second, '2026-08-11T00:00:00Z', '0.9.0', 'b.pptx');

    const inspected = await inspectLocalArchive(fs.storage);
    expect(inspected).toMatchObject({ kind: 'v1', ready: true, origin: 'creator' });
    expect(inspected.courses.map((c) => c.id).sort()).toEqual(['sb-c1', 'sb-c2']);

    // The latest build wins the manifest metadata; earlier courses stay listed.
    const manifest = JSON.parse((await fs.storage.readManifest())!) as {
      createdAt: string;
      creatorSummary: { sourceFile: string };
    };
    expect(manifest.createdAt).toBe('2026-08-11T00:00:00Z');
    expect(manifest.creatorSummary.sourceFile).toBe('b.pptx');
  });

  it('rebuilding the SAME course id refreshes its entry without duplicating it', async () => {
    const fs = fakeStorage();
    await writeBuiltCourse(fs.storage, BUILT, 't1', '0.9.0');
    await writeBuiltCourse(
      fs.storage,
      {
        ...BUILT,
        raw: '{"course":{"id":"sb-c1","title":"Atjaunots","type":null},"lessons":[]}',
        manifestEntry: { id: 'sb-c1', title: 'Atjaunots' },
      },
      't2',
      '0.9.0',
    );
    const inspected = await inspectLocalArchive(fs.storage);
    expect(inspected.courses).toEqual([{ id: 'sb-c1', title: 'Atjaunots', type: null }]);
  });

  it('REFUSES a rise-export folder before writing anything (the manifest-clobber guard)', async () => {
    const fs = fakeStorage();
    const exportManifest = {
      format: 'rise-local-archive',
      formatVersion: 1,
      state: 'ready',
      origin: 'rise-export',
      createdAt: 'earlier',
      toolVersion: '0.8.1',
      courses: [{ id: 'real-1', title: 'Exported', file: 'courses/real-1.json', sha256: 'f'.repeat(64) }],
      sourceAccount: { name: 'ACME US', sub: null, email: null, plane: 'us' },
    };
    await fs.storage.writeManifest(exportManifest);
    const manifestBefore = await fs.storage.readManifest();

    await expect(writeBuiltCourse(fs.storage, BUILT, 'now', '0.9.0')).rejects.toThrow(
      /rise-export archive \(1 course\(s\), source: ACME US\).*dedicated Creator folder/s,
    );
    // NOTHING was written: no course file, no lock, manifest byte-identical.
    expect(fs.courses.has('sb-c1')).toBe(false);
    expect(fs.artifacts.size).toBe(0);
    expect(await fs.storage.readManifest()).toBe(manifestBefore);
  });

  it('REFUSES a folder holding a non-v1/unknown manifest', async () => {
    const fs = fakeStorage();
    await fs.storage.writeManifest({ some: 'legacy index' });
    await expect(writeBuiltCourse(fs.storage, BUILT, 'now', '0.9.0')).rejects.toThrow(
      /not a rise-local-archive v1/,
    );
    expect(fs.courses.size).toBe(0);
    expect(fs.artifacts.size).toBe(0);
  });
});
