import { describe, expect, it } from 'vitest';
import { buildAssetManifest, assetManifestToJson, sha256Hex } from '@/core/assets';
import {
  createManifestV1,
  inspectLocalArchive,
  inspectSelectedArchive,
  type LocalArchiveReader,
} from '.';

const enc = new TextEncoder();

async function hash(value: string | Uint8Array): Promise<string> {
  return sha256Hex(typeof value === 'string' ? enc.encode(value) : value);
}

function reader(args: {
  manifest?: string | null;
  courses?: Record<string, string>;
  assetManifests?: Record<string, string>;
  assets?: Record<string, Uint8Array>;
}): LocalArchiveReader {
  const courses = args.courses ?? {};
  return {
    readManifest: async () => args.manifest ?? null,
    readCourse: async (id) => courses[id] ?? null,
    hasCourse: async (id) => id in courses,
    listSaved: async () => Object.keys(courses),
    hasAssetManifest: async (_scope, id) => id in (args.assetManifests ?? {}),
    readAssetManifest: async (_scope, id) => args.assetManifests?.[id] ?? null,
    hasAsset: async (name) => name in (args.assets ?? {}),
  };
}

function course(id = 'c1', mediaKey?: string): string {
  return JSON.stringify({
    course: { id, title: 'Course', type: null },
    lessons: [
      {
        id: 'l1',
        type: 'blocks',
        title: 'Lesson',
        items: mediaKey
          ? [
              {
                id: 'b1',
                type: 'image',
                family: 'image',
                variant: 'centered',
                items: [{ id: 'i1', media: { image: { key: mediaKey } } }],
                settings: {},
              },
            ]
          : [],
      },
    ],
  });
}

describe('inspectLocalArchive — v1', () => {
  it('accepts a ready course archive whose listed files exist', async () => {
    const raw = course();
    const manifest = createManifestV1({
      origin: 'creator',
      createdAt: '2026-08-14T00:00:00Z',
      toolVersion: '0.8.0',
      courses: [
        {
          id: 'c1',
          title: 'Course',
          type: null,
          file: 'courses/c1.json',
          sha256: await hash(raw),
        },
      ],
    });
    const inspected = await inspectLocalArchive(
      reader({ manifest: JSON.stringify(manifest), courses: { c1: raw } }),
    );
    expect(inspected.kind).toBe('v1');
    expect(inspected.ready).toBe(true);
    expect(inspected.origin).toBe('creator');
    expect(inspected.courses).toEqual([{ id: 'c1', title: 'Course', type: null }]);
    expect(inspected.issues).toEqual([]);
  });

  it('does not open course JSON, asset manifests, or asset bytes for the picker check', async () => {
    const raw = course();
    const manifest = createManifestV1({
      origin: 'rise-export',
      createdAt: '2026-08-14T00:00:00Z',
      toolVersion: '0.8.0',
      courses: [
        {
          id: 'c1',
          title: 'Course',
          file: 'courses/c1.json',
          sha256: await hash(raw),
          assetManifest: 'courses/c1.assets.json',
          assetManifestSha256: await hash('{}'),
        },
      ],
    });
    const inspected = await inspectLocalArchive({
      readManifest: async () => JSON.stringify(manifest),
      hasCourse: async () => true,
      readCourse: async () => {
        throw new Error('picker must not read course JSON');
      },
      listSaved: async () => ['c1'],
      hasAssetManifest: async () => true,
      readAssetManifest: async () => {
        throw new Error('picker must not read asset manifests');
      },
      hasAsset: async () => {
        throw new Error('picker must not walk assets');
      },
    });
    expect(inspected.ready).toBe(true);
    expect(inspected.courses).toEqual([{ id: 'c1', title: 'Course' }]);
  });

  it('allows an intentional local course edit without updating the export-time hash', async () => {
    const raw = course();
    const manifest = createManifestV1({
      origin: 'creator',
      createdAt: '2026-08-14T00:00:00Z',
      toolVersion: '0.8.0',
      courses: [
        {
          id: 'c1',
          file: 'courses/c1.json',
          sha256: await hash(raw),
        },
      ],
    });
    const inspected = await inspectSelectedArchive(
      reader({
        manifest: JSON.stringify(manifest),
        courses: { c1: raw.replace('Course', 'Tampered') },
      }),
      ['c1'],
    );
    expect(inspected.ready).toBe(true);
    expect(inspected.issues).toEqual([]);
  });

  it('requires asset files but allows their bytes to be intentionally replaced', async () => {
    const key = 'rise/courses/c1/picture.png';
    const raw = course('c1', key);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const assetHash = await hash(bytes);
    const assets = buildAssetManifest(
      'course',
      'c1',
      [{ key, kind: 'media-image', paths: ['$.lessons[0]'] }],
      [
        {
          key,
          kind: 'media-image',
          hash: assetHash,
          ext: 'png',
          file: `assets/${assetHash}.png`,
          size: bytes.byteLength,
        },
      ],
      [],
      '2026-08-14T00:00:00Z',
    );
    const assetRaw = assetManifestToJson(assets);
    const manifest = createManifestV1({
      origin: 'creator',
      createdAt: '2026-08-14T00:00:00Z',
      toolVersion: '0.8.0',
      courses: [
        {
          id: 'c1',
          file: 'courses/c1.json',
          sha256: await hash(raw),
          assetManifest: 'courses/c1.assets.json',
          assetManifestSha256: await hash(assetRaw),
        },
      ],
    });
    const good = await inspectSelectedArchive(
      reader({
        manifest: JSON.stringify(manifest),
        courses: { c1: raw },
        assetManifests: { c1: assetRaw },
        assets: { [`${assetHash}.png`]: bytes },
      }),
      ['c1'],
    );
    expect(good.ready).toBe(true);

    const bad = await inspectSelectedArchive(
      reader({
        manifest: JSON.stringify(manifest),
        courses: { c1: raw },
        assetManifests: { c1: assetRaw },
        assets: { [`${assetHash}.png`]: new Uint8Array([9]) },
      }),
      ['c1'],
    );
    expect(bad.ready).toBe(true);

    const missing = await inspectSelectedArchive(
      reader({
        manifest: JSON.stringify(manifest),
        courses: { c1: raw },
        assetManifests: { c1: assetRaw },
        assets: {},
      }),
      ['c1'],
    );
    expect(missing.ready).toBe(false);
    expect(missing.issues.some((i) => i.code === 'asset-missing')).toBe(true);
  });

  it('deep-checks only selected courses for parseability and media coverage', async () => {
    const good = course('good');
    const broken = '{not-json';
    const manifest = createManifestV1({
      origin: 'rise-export',
      createdAt: '2026-08-14T00:00:00Z',
      toolVersion: '0.8.0',
      courses: [
        { id: 'good', title: 'Good', file: 'courses/good.json', sha256: await hash(good) },
        { id: 'broken', title: 'Broken', file: 'courses/broken.json', sha256: await hash(broken) },
      ],
    });
    const store = reader({
      manifest: JSON.stringify(manifest),
      courses: { good, broken },
    });
    expect((await inspectLocalArchive(store)).ready).toBe(true);
    expect((await inspectSelectedArchive(store, ['good'])).ready).toBe(true);
    const selectedBroken = await inspectSelectedArchive(store, ['broken']);
    expect(selectedBroken.ready).toBe(false);
    expect(selectedBroken.issues.some((i) => i.code === 'course-json')).toBe(true);
  });

  it('rejects duplicate course ids and a non-ready state', async () => {
    const raw = course();
    const entry = {
      id: 'c1',
      file: 'courses/c1.json',
      sha256: await hash(raw),
    };
    const manifest = {
      ...createManifestV1({
        origin: 'creator',
        createdAt: '2026-08-14T00:00:00Z',
        toolVersion: '0.8.0',
        courses: [entry, entry],
      }),
      state: 'building',
    };
    const inspected = await inspectLocalArchive(
      reader({ manifest: JSON.stringify(manifest), courses: { c1: raw } }),
    );
    expect(inspected.ready).toBe(false);
    expect(inspected.issues.some((i) => i.code === 'manifest-state')).toBe(true);
  });
});

describe('inspectLocalArchive — legacy and corrupt', () => {
  it('accepts a readable legacy archive with a warning', async () => {
    const raw = course();
    const inspected = await inspectLocalArchive(
      reader({
        manifest: JSON.stringify({ courses: [{ id: 'c1', title: 'Recorded' }] }),
        courses: { c1: raw },
      }),
    );
    expect(inspected.kind).toBe('legacy');
    expect(inspected.ready).toBe(true);
    expect(inspected.courses[0]?.title).toBe('Recorded');
    expect(inspected.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'legacy', severity: 'warning' })]),
    );
  });

  it('does not treat a corrupt manifest as an empty legacy archive', async () => {
    const inspected = await inspectLocalArchive(
      reader({ manifest: '{oops', courses: { c1: course() } }),
    );
    expect(inspected.kind).toBe('invalid');
    expect(inspected.ready).toBe(false);
    expect(inspected.issues[0]?.code).toBe('manifest-json');
  });

  it('uses course files as a legacy fallback only when the manifest is absent', async () => {
    const inspected = await inspectLocalArchive(reader({ courses: { c1: course() } }));
    expect(inspected.kind).toBe('legacy');
    expect(inspected.ready).toBe(true);
    expect(inspected.courses).toHaveLength(1);
  });
});
