import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { isReview360StoryHtml } from '@/core/storyline/repackage';
import {
  exportStorylinePackages,
  isAuthError,
  MAX_UPLOAD_ZIP_BYTES,
  scanSavedCoursesForStoryline,
  updateStorylineImportability,
  uploadStorylineToReview360,
  renameReviewItemsToBlockTitles,
} from './storyline';
import type { ProgressEvent } from './shared';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const LEAF = 'k3sFdQgN6xRXAoBp';

// A saved course doc with one attached storyline block on lesson les_1.
const COURSE_DOC = {
  course: { id: 'C1', title: 'Geo 101' },
  lessons: [
    {
      id: 'les_1',
      items: [
        {
          id: 'blk_story',
          family: '360',
          variant: 'storyline',
          items: [
            {
              id: 'item_1',
              media: {
                storyline: { contentPrefix: `rise/courses/C1/${LEAF}`, meta: { title: 'Geo 101' } },
              },
            },
          ],
        },
      ],
    },
  ],
};

function courseWithVersions(
  entries: Array<{ blockId: string; leaf: string; version: string }>,
) {
  return {
    course: { id: 'C1', title: 'Versioned' },
    lessons: [
      {
        id: 'les_1',
        items: entries.map((entry) => ({
          id: entry.blockId,
          family: '360',
          variant: 'storyline',
          items: [
            {
              id: `item_${entry.blockId}`,
              media: {
                storyline: {
                  contentPrefix: `rise/courses/C1/${entry.leaf}`,
                  meta: { version: entry.version },
                },
              },
            },
          ],
        })),
      },
    ],
  };
}

// A modern web-export story.html the repackage transform recognises.
const MODERN_STORY_HTML = '<head><meta name="robots" content="noindex, nofollow"></head><!-- 360 -->';

// A web-export zip carrying that leaf's package.
function webExportZip(
  leaf = LEAF,
  storyHtml = MODERN_STORY_HTML,
): Uint8Array {
  return zipSync(
    {
      'content/runtime-data.js': enc('__jsonp("runtime-data.js","")'),
      [`content/assets/${leaf}/story.html`]: enc(storyHtml),
      [`content/assets/${leaf}/threeSixty.json`]: enc('{"title":"Geo 101"}'),
    },
    { mtime: Date.UTC(1980, 0, 1) },
  );
}

/** In-memory storage stub implementing only what the orchestrator touches. */
function makeStorage() {
  const courses = new Map<string, string>([['C1', JSON.stringify({ payload: COURSE_DOC })]]);
  const zips = new Map<string, Uint8Array>();
  const legacyZips = new Map<string, Uint8Array>();
  const manifests = new Map<string, string>();
  return {
    store: {
      listSaved: async () => [...courses.keys()],
      readCourse: async (id: string) => courses.get(id) ?? null,
      readStorylineManifest: async (id: string) => manifests.get(id) ?? null,
      writeStorylineManifest: async (id: string, json: string) => void manifests.set(id, json),
      writeStorylineZip: async (id: string, leaf: string, bytes: Uint8Array) =>
        void zips.set(`${id}/${leaf}`, bytes),
      writeLegacyStorylineZip: async (id: string, leaf: string, bytes: Uint8Array) =>
        void legacyZips.set(`${id}/${leaf}`, bytes),
      hasStorylineZip: async (id: string, leaf: string) => zips.has(`${id}/${leaf}`),
      hasLegacyStorylineZip: async (id: string, leaf: string) =>
        legacyZips.has(`${id}/${leaf}`),
    } as any,
    zips,
    legacyZips,
    manifests,
  };
}

const sink = (): { onEvent: (e: ProgressEvent) => void; logs: string[] } => {
  const logs: string[] = [];
  return {
    logs,
    onEvent: (e) => {
      if (e.kind === 'log') logs.push(e.message);
    },
  };
};

// C4: every run resolves ONE Rise tab up front and carries that pin on every
// message it issues. Tests inject the resolution so they never touch the
// background; `noPin` is the "could not pin" branch.
const PIN = { pinnedTabId: 42, expectedPlane: 'eu' as const };
const pinTab = async () => ({ pin: PIN });
const noPin = async () => ({ blocked: 'Could not pin the target Rise tab: no Rise tab.' });

describe('scanSavedCoursesForStoryline', () => {
  it('reports courses that contain storyline blocks', async () => {
    const { store } = makeStorage();
    const { onEvent } = sink();
    const scans = await scanSavedCoursesForStoryline(store, onEvent);
    expect(scans).toHaveLength(1);
    expect(scans[0]!.courseId).toBe('C1');
    expect(scans[0]!.title).toBe('Geo 101');
    expect(scans[0]!.blocks[0]!.leaf).toBe(LEAF);
  });
});

describe('scanSavedCoursesForStoryline — scoped to selection', () => {
  it('scans only the selected course ids', async () => {
    const docFor = (id: string) =>
      JSON.stringify({ payload: { ...COURSE_DOC, course: { id, title: id } } });
    const store = {
      listSaved: async () => ['C1', 'C2', 'C3'],
      readCourse: async (id: string) => docFor(id),
    } as any;
    const { onEvent, logs } = sink();
    const scans = await scanSavedCoursesForStoryline(store, onEvent, new Set(['C2']));
    expect(scans.map((s) => s.courseId)).toEqual(['C2']);
    expect(logs.some((l) => /1 selected course/.test(l))).toBe(true);
  });
});

describe('Storyline legacy reporting', () => {
  it('marks the inventory column and clears it again for a checked non-legacy course', async () => {
    let inventory = JSON.stringify([
      {
        id: 'C1',
        title: 'Versioned',
        type: 'COURSE',
        lessonCount: 1,
        multi_language: '',
        owner: '',
        ownerEmail: '',
        folderId: '',
        folderPath: '',
        shareId: '',
        createdAt: '',
        updatedAt: '',
        ready: '',
        deleted: '',
      },
    ]);
    let csv = '';
    const store = {
      readInventory: async () => inventory,
      writeInventory: async (json: string, nextCsv: string) => {
        inventory = json;
        csv = nextCsv;
      },
    } as any;
    const { onEvent } = sink();
    const base = { courseId: 'C1', title: 'Versioned', blocks: [] };
    await updateStorylineImportability(
      store,
      [{ ...base, legacyBlocks: [{ meta: { version: '3.48.24159.0' } } as any] }],
      onEvent,
    );
    expect(JSON.parse(inventory)[0].importability).toMatch(/legacy Storyline/i);
    expect(csv.split('\n')[0]).toContain('importability');

    await updateStorylineImportability(
      store,
      [{ ...base, legacyBlocks: [] }],
      onEvent,
    );
    expect(JSON.parse(inventory)[0].importability).toBe('');
  });
});

describe('exportStorylinePackages', () => {
  it('triggers export, downloads, repackages each leaf, writes a manifest', async () => {
    const { store, zips, manifests } = makeStorage();
    const { onEvent } = sink();
    const exportOne = vi.fn(async () => ({ ok: true as const, location: 'https://cdn/x.zip', jobId: '99' }));
    const fetchZip = vi.fn(async () => webExportZip());
    const refresh = vi.fn(async () => ({ advanced: true, valid: true }));

    const summary = await exportStorylinePackages(store, onEvent, {
      exportOne,
      fetchZip,
      refresh,
      pinTab,
      pacing: { baseMs: 0, jitterMs: 0 },
    });

    expect(summary).toMatchObject({ courses: 1, packaged: 1, skipped: 0, failed: 0 });
    expect(exportOne).toHaveBeenCalledWith('C1', 'Geo 101', PIN);
    expect(refresh).toHaveBeenCalledWith(PIN, 'C1');

    // the stored package zip is in Review-360 form
    const stored = zips.get(`C1/${LEAF}`)!;
    const out = unzipSync(stored);
    expect(isReview360StoryHtml(new TextDecoder().decode(out['story.html']!))).toBe(true);
    expect(out['threeSixty.json']).toBeTruthy();

    // manifest joins block → lesson → leaf → zip
    const manifest = JSON.parse(manifests.get('C1')!);
    expect(manifest.blocks[0]).toMatchObject({
      blockId: 'blk_story',
      lessonId: 'les_1',
      itemId: 'item_1',
      leaf: LEAF,
      zip: `storyline/C1/${LEAF}.zip`,
    });
  });

  it('skips a course that already has a manifest AND its zip on disk (resume)', async () => {
    const { store, manifests, zips } = makeStorage();
    manifests.set('C1', '{}');
    zips.set(`C1/${LEAF}`, new Uint8Array([1]));
    const { onEvent } = sink();
    const exportOne = vi.fn();
    const summary = await exportStorylinePackages(store, onEvent, {
      exportOne,
      fetchZip: vi.fn(),
      refresh: vi.fn(),
    });
    expect(summary).toMatchObject({ packaged: 0, skipped: 1 });
    expect(exportOne).not.toHaveBeenCalled();
  });

  it('never builds a course this account may not export; writes a manual-review manifest', async () => {
    const doc = {
      ...courseWithVersions([
        { blockId: 'old', leaf: 'OLD', version: '3.48.24159.0' },
        { blockId: 'new', leaf: 'NEW', version: '3.49.24347.0' },
      ]),
      // live 2026-10-27: an edit-only collaborator; build/raw answered 404
      authorPermissions: ['view', 'edit', 'review-export'],
    };
    const manifests = new Map<string, string>();
    const store = {
      listSaved: async () => ['C1'],
      readCourse: async () => JSON.stringify({ payload: doc }),
      readStorylineManifest: async (id: string) => manifests.get(id) ?? null,
      writeStorylineManifest: async (id: string, json: string) => void manifests.set(id, json),
      hasLegacyStorylineZip: async () => false,
    } as any;
    const { onEvent, logs } = sink();
    const exportOne = vi.fn();
    const deps = { exportOne, fetchZip: vi.fn(), refresh: vi.fn(), pinTab, pacing: { baseMs: 0, jitterMs: 0 } };

    const summary = await exportStorylinePackages(store, onEvent, deps);
    expect(summary).toMatchObject({ packaged: 0, skipped: 1, failed: 0, notExportable: 1 });
    expect(exportOne).not.toHaveBeenCalled();
    const manifest = JSON.parse(manifests.get('C1')!);
    expect(manifest.exportBlocked).toMatch(/lack `export`/);
    expect(manifest.blocks.map((b: { compatibility: string }) => b.compatibility)).toEqual([
      'legacy-unsupported',
      'source-placeholder',
    ]);
    expect(manifest.blocks.every((b: { zip?: string; archiveZip?: string }) => !b.zip && !b.archiveZip)).toBe(true);
    expect(logs.some((l) => l.includes('not exported'))).toBe(true);

    // a re-run (even forced) still never fires the build
    const again = await exportStorylinePackages(store, onEvent, { ...deps, force: true });
    expect(again).toMatchObject({ failed: 0, notExportable: 1 });
    expect(exportOne).not.toHaveBeenCalled();
  });

  it('keeps a blocked course ⚠ + counted on every run (never a green resume skip)', async () => {
    // Only MODERN blocks: run 1's manifest has no missing legacy zip, which used
    // to satisfy the "already exported" resume skip on run 2.
    const doc = {
      ...courseWithVersions([{ blockId: 'new', leaf: 'NEW', version: '3.49.24347.0' }]),
      authorPermissions: ['view', 'edit'],
    };
    const manifests = new Map<string, string>();
    const store = {
      listSaved: async () => ['C1'],
      readCourse: async () => JSON.stringify({ payload: doc }),
      readStorylineManifest: async (id: string) => manifests.get(id) ?? null,
      writeStorylineManifest: async (id: string, json: string) => void manifests.set(id, json),
      hasLegacyStorylineZip: async () => false,
    } as any;
    const { onEvent, logs } = sink();
    const deps = { exportOne: vi.fn(), fetchZip: vi.fn(), refresh: vi.fn(), pinTab, pacing: { baseMs: 0, jitterMs: 0 } };
    await exportStorylinePackages(store, onEvent, deps);
    const second = await exportStorylinePackages(store, onEvent, deps);
    expect(second).toMatchObject({ skipped: 1, notExportable: 1 });
    expect(logs.filter((l) => l.includes('already exported'))).toEqual([]);
    expect(logs.filter((l) => l.startsWith('⚠') && l.includes('not exported'))).toHaveLength(2);
    expect(deps.exportOne).not.toHaveBeenCalled();
  });

  it('builds a once-blocked course after export rights arrive (placeholder manifest is not "already exported")', async () => {
    // live 2026-10-30: run 1 blocked → placeholder manifest; owner granted
    // export, course re-fetched; a plain (non-Force) re-run logged a false ✓.
    const doc = {
      ...courseWithVersions([{ blockId: 'new', leaf: 'NEW', version: '3.90.32893.0' }]),
      authorPermissions: ['view', 'edit'],
    };
    const manifests = new Map<string, string>();
    const written = new Set<string>();
    const writeStorylineZip = vi.fn(async (id: string, leaf: string) => void written.add(`${id}/${leaf}`));
    const store = {
      listSaved: async () => ['C1'],
      readCourse: async () => JSON.stringify({ payload: doc }),
      readStorylineManifest: async (id: string) => manifests.get(id) ?? null,
      writeStorylineManifest: async (id: string, json: string) => void manifests.set(id, json),
      hasLegacyStorylineZip: async () => false,
      hasStorylineZip: async (id: string, leaf: string) => written.has(`${id}/${leaf}`),
      writeStorylineZip,
    } as any;
    const { onEvent, logs } = sink();
    const exportOne = vi.fn(async () => ({ ok: true as const, location: 'https://cdn/x.zip', jobId: '7' }));
    const fetchZip = vi.fn(async () => webExportZip('NEW'));
    const deps = { exportOne, fetchZip, refresh: vi.fn(), pinTab, pacing: { baseMs: 0, jitterMs: 0 } };

    await exportStorylinePackages(store, onEvent, deps);
    expect(exportOne).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('re-run Fetch courses'))).toBe(true);

    doc.authorPermissions = ['view', 'edit', 'export', 'publish:web'];
    const summary = await exportStorylinePackages(store, onEvent, deps);
    expect(summary).toMatchObject({ packaged: 1, notExportable: 0, failed: 0 });
    expect(exportOne).toHaveBeenCalledTimes(1);
    expect(writeStorylineZip).toHaveBeenCalledWith('C1', 'NEW', expect.anything());
    expect(logs.filter((l) => l.includes('already exported'))).toEqual([]);
    const manifest = JSON.parse(manifests.get('C1')!);
    expect(manifest.exportBlocked).toBeUndefined();
    expect(manifest.blocks[0]).toMatchObject({ compatibility: 'automatic', zip: 'storyline/C1/NEW.zip' });

    // now genuinely staged → the next plain run is a real resume skip
    const third = await exportStorylinePackages(store, onEvent, deps);
    expect(third).toMatchObject({ packaged: 0, skipped: 1 });
    expect(exportOne).toHaveBeenCalledTimes(1);
  });

  it('rebuilds a modern leaf whose zip is missing on disk even with a clean manifest (added/re-attached block)', async () => {
    // A block attached after the last export: the manifest exists and is not a
    // placeholder, but storyline/C1/NEW2.zip was never written.
    const doc = courseWithVersions([
      { blockId: 'a', leaf: 'NEW1', version: '3.90.32893.0' },
      { blockId: 'b', leaf: 'NEW2', version: '3.90.32893.0' },
    ]);
    const { store, zips, manifests } = makeStorage();
    store.readCourse = async () => JSON.stringify({ payload: doc });
    zips.set('C1/NEW1', new Uint8Array([1]));
    manifests.set('C1', JSON.stringify({
      courseId: 'C1',
      blocks: [{ blockId: 'a', lessonId: 'les_1', leaf: 'NEW1', compatibility: 'automatic', zip: 'storyline/C1/NEW1.zip' }],
      uploads: { NEW1: { reviewPrefix: 'review/items/NEW1' } },
    }));
    const { onEvent } = sink();
    const exportOne = vi.fn(async () => ({ ok: true as const, location: 'https://cdn/x.zip', jobId: '9' }));
    const twoLeaves = zipSync({
      'content/runtime-data.js': enc('__jsonp("runtime-data.js","")'),
      'content/assets/NEW1/story.html': enc(MODERN_STORY_HTML),
      'content/assets/NEW2/story.html': enc(MODERN_STORY_HTML),
    });
    const summary = await exportStorylinePackages(store, onEvent, {
      exportOne, fetchZip: vi.fn(async () => twoLeaves), refresh: vi.fn(), pinTab, pacing: { baseMs: 0, jitterMs: 0 },
    });
    expect(summary).toMatchObject({ packaged: 1, skipped: 0 });
    expect(zips.has('C1/NEW2')).toBe(true);
    const m = JSON.parse(manifests.get('C1')!);
    // only the missing leaf was rebuilt; the staged one keeps its upload record
    expect(m.uploads.NEW1.reviewPrefix).toBe('review/items/NEW1');
    expect(m.blocks.map((b: { leaf: string; zip?: string }) => [b.leaf, b.zip])).toEqual([
      ['NEW1', 'storyline/C1/NEW1.zip'],
      ['NEW2', 'storyline/C1/NEW2.zip'],
    ]);
  });

  it('drops the stale upload record of a leaf rebuilt with Force', async () => {
    const { store, zips, manifests } = makeStorage();
    zips.set(`C1/${LEAF}`, new Uint8Array([1]));
    manifests.set('C1', JSON.stringify({
      courseId: 'C1',
      blocks: [{ blockId: 'b1', lessonId: 'les_1', leaf: LEAF, compatibility: 'automatic', zip: `storyline/C1/${LEAF}.zip` }],
      uploads: { [LEAF]: { reviewPrefix: 'review/items/OLD' }, OTHER: { reviewPrefix: 'review/items/OTHER' } },
    }));
    const { onEvent } = sink();
    const exportOne = vi.fn(async () => ({ ok: true as const, location: 'https://cdn/x.zip', jobId: '10' }));
    const summary = await exportStorylinePackages(store, onEvent, {
      exportOne, fetchZip: vi.fn(async () => webExportZip()), refresh: vi.fn(), pinTab, pacing: { baseMs: 0, jitterMs: 0 }, force: true,
    });
    expect(summary).toMatchObject({ packaged: 1 });
    const m = JSON.parse(manifests.get('C1')!);
    // the rebuilt zip must be re-uploaded (Stage C resumes on reviewPrefix)
    expect(m.uploads[LEAF]).toBeUndefined();
    expect(m.uploads.OTHER.reviewPrefix).toBe('review/items/OTHER');
  });

  it('stack: rebuilds only the language whose zip is missing', async () => {
    const doc = {
      course: { id: 'C1', title: 'Stack' },
      lessons: [{
        id: 'les_1',
        items: [{
          id: 'sl', family: '360', variant: 'storyline',
          items: [{ id: 'it', media: { l10nId: 'cell-sl' } }],
        }],
      }],
      l10n: {
        translations: {
          en: { 'cell-sl': { storyline: { contentPrefix: 'rise/courses/C1/EN', meta: { version: '3.90.32893.0' } } } },
          de: { 'cell-sl': { storyline: { contentPrefix: 'rise/courses/C1/DE', meta: { version: '3.90.32893.0' } } } },
        },
      },
    };
    const { store, zips, manifests } = makeStorage();
    store.readCourse = async () => JSON.stringify({ payload: doc });
    zips.set('C1/EN', new Uint8Array([1]));
    manifests.set('C1', JSON.stringify({
      courseId: 'C1',
      blocks: [
        { blockId: 'sl', lessonId: 'les_1', leaf: 'EN', locale: 'en', l10nId: 'cell-sl', compatibility: 'automatic', zip: 'storyline/C1/EN.zip' },
        { blockId: 'sl', lessonId: 'les_1', leaf: 'DE', locale: 'de', l10nId: 'cell-sl', compatibility: 'source-placeholder' },
      ],
    }));
    const { onEvent } = sink();
    const exportOne = vi.fn(async () => ({ ok: true as const, location: 'https://cdn/x.zip', jobId: '11' }));
    const both = zipSync({
      'content/runtime-data.js': enc('__jsonp("runtime-data.js","")'),
      'content/assets/EN/story.html': enc(MODERN_STORY_HTML),
      'content/assets/DE/story.html': enc(MODERN_STORY_HTML),
    });
    const summary = await exportStorylinePackages(store, onEvent, {
      exportOne, fetchZip: vi.fn(async () => both), refresh: vi.fn(), pinTab, pacing: { baseMs: 0, jitterMs: 0 },
    });
    expect(summary).toMatchObject({ packaged: 1 });
    expect(exportOne).toHaveBeenCalledTimes(1);
    expect(zips.has('C1/DE')).toBe(true);
    const m = JSON.parse(manifests.get('C1')!);
    expect(m.blocks.map((b: { locale: string; compatibility: string }) => [b.locale, b.compatibility])).toEqual([
      ['en', 'automatic'],
      ['de', 'automatic'],
    ]);
    // a second plain run is a genuine resume skip
    const again = await exportStorylinePackages(store, onEvent, { exportOne, fetchZip: vi.fn(), refresh: vi.fn(), pinTab, pacing: { baseMs: 0, jitterMs: 0 } });
    expect(again).toMatchObject({ skipped: 1, packaged: 0 });
  });

  it('keeps packages staged by an earlier export when the course is blocked now', async () => {
    const doc = {
      ...courseWithVersions([
        { blockId: 'old', leaf: 'OLD', version: '3.48.24159.0' },
        { blockId: 'new', leaf: 'NEW', version: '3.49.24347.0' },
      ]),
      authorPermissions: ['view', 'edit'],
    };
    const lessonId = doc.lessons[0]!.id;
    const prior = {
      courseId: 'C1',
      blocks: [
        { blockId: 'new', lessonId, leaf: 'NEW', compatibility: 'automatic', zip: 'storyline/C1/NEW.zip' },
        { blockId: 'old', lessonId, leaf: 'OLD', compatibility: 'legacy-unsupported' },
      ],
      uploads: { NEW: { reviewPrefix: 'review/items/NEW' } },
    };
    const manifests = new Map<string, string>([['C1', JSON.stringify(prior)]]);
    const store = {
      listSaved: async () => ['C1'],
      readCourse: async () => JSON.stringify({ payload: doc }),
      readStorylineManifest: async (id: string) => manifests.get(id) ?? null,
      writeStorylineManifest: async (id: string, json: string) => void manifests.set(id, json),
      hasLegacyStorylineZip: async () => false,
    } as any;
    const { onEvent, logs } = sink();
    const exportOne = vi.fn();
    const summary = await exportStorylinePackages(store, onEvent, {
      exportOne, fetchZip: vi.fn(), refresh: vi.fn(), pinTab, pacing: { baseMs: 0, jitterMs: 0 }, force: true,
    });
    expect(summary).toMatchObject({ notExportable: 1 });
    expect(exportOne).not.toHaveBeenCalled();
    const manifest = JSON.parse(manifests.get('C1')!);
    const byId = Object.fromEntries(manifest.blocks.map((b: { blockId: string }) => [b.blockId, b]));
    // the staged modern package survives with its zip (+ the upload record)
    expect(byId.new).toMatchObject({ compatibility: 'automatic', zip: 'storyline/C1/NEW.zip' });
    expect(manifest.uploads.NEW.reviewPrefix).toBe('review/items/NEW');
    // the never-preserved legacy package is the plain no-zip entry
    expect(byId.old).toMatchObject({ compatibility: 'legacy-unsupported' });
    expect(byId.old.archiveZip).toBeUndefined();
    expect(logs.some((l) => l.includes('1 Storyline package(s) need manual review (1 kept from an earlier export)'))).toBe(true);
  });

  it('still builds a course whose saved permissions include export', async () => {
    const { store } = makeStorage();
    store.readCourse = async () =>
      JSON.stringify({ payload: { ...COURSE_DOC, authorPermissions: ['view', 'edit', 'export'] } });
    const { onEvent } = sink();
    const exportOne = vi.fn(async () => ({ ok: true as const, location: 'https://cdn/x.zip', jobId: '1' }));
    const summary = await exportStorylinePackages(store, onEvent, {
      exportOne,
      fetchZip: vi.fn(async () => webExportZip()),
      refresh: vi.fn(),
      pinTab,
      pacing: { baseMs: 0, jitterMs: 0 },
    });
    expect(summary).toMatchObject({ packaged: 1, notExportable: 0 });
    expect(exportOne).toHaveBeenCalledTimes(1);
  });

  it('preserves a legacy package unchanged in the quarantined store', async () => {
    const doc = courseWithVersions([
      { blockId: 'old', leaf: 'OLD', version: '3.48.24159.0' },
    ]);
    const manifests = new Map<string, string>();
    const legacyZips = new Map<string, Uint8Array>();
    const store = {
      listSaved: async () => ['C1'],
      readCourse: async () => JSON.stringify({ payload: doc }),
      readStorylineManifest: async (id: string) => manifests.get(id) ?? null,
      writeStorylineManifest: async (id: string, json: string) => void manifests.set(id, json),
      hasLegacyStorylineZip: async (id: string, leaf: string) =>
        legacyZips.has(`${id}/${leaf}`),
      writeLegacyStorylineZip: async (id: string, leaf: string, bytes: Uint8Array) =>
        void legacyZips.set(`${id}/${leaf}`, bytes),
    } as any;
    const { onEvent } = sink();
    const exportOne = vi.fn(async () => ({
      ok: true as const,
      location: 'https://cdn/legacy.zip',
      jobId: 'legacy-job',
    }));
    const legacyHtml = '<html><!-- version: 3.48.24159.0 --><body>legacy</body></html>';
    const summary = await exportStorylinePackages(store, onEvent, {
      exportOne,
      fetchZip: vi.fn(async () => webExportZip('OLD', legacyHtml)),
      refresh: vi.fn(async () => ({ advanced: true, valid: true })),
      pinTab,
      pacing: { baseMs: 0, jitterMs: 0 },
    });
    expect(summary).toMatchObject({
      courses: 1,
      packaged: 1,
      skipped: 0,
      failed: 0,
      legacySkipped: 1,
      legacySaved: 1,
    });
    expect(exportOne).toHaveBeenCalledTimes(1);
    const preserved = unzipSync(legacyZips.get('C1/OLD')!);
    expect(new TextDecoder().decode(preserved['story.html']!)).toBe(legacyHtml);
    expect(JSON.parse(manifests.get('C1')!).blocks[0]).toMatchObject({
      leaf: 'OLD',
      compatibility: 'legacy-unsupported',
      archiveZip: 'storyline-legacy/C1/OLD.zip',
    });
  });

  it('backfills a missing legacy ZIP despite a pre-policy manifest and preserves uploads', async () => {
    const doc = courseWithVersions([
      { blockId: 'old', leaf: 'OLD', version: '3.48.24159.0' },
      { blockId: 'new', leaf: 'NEW', version: '3.49.24347.0' },
    ]);
    let manifest = JSON.stringify({
      courseId: 'C1',
      blocks: [{ blockId: 'new', lessonId: 'les_1', leaf: 'NEW' }],
      uploads: { NEW: { itemId: 'review-new', reviewPrefix: 'review/items/NEW' } },
    });
    const legacyZips = new Map<string, Uint8Array>();
    const store = {
      listSaved: async () => ['C1'],
      readCourse: async () => JSON.stringify({ payload: doc }),
      readStorylineManifest: async () => manifest,
      writeStorylineManifest: async (_id: string, json: string) => void (manifest = json),
      hasLegacyStorylineZip: async () => false,
      hasStorylineZip: async () => true, // pre-policy manifest, zip on disk → staged
      writeLegacyStorylineZip: async (id: string, leaf: string, bytes: Uint8Array) =>
        void legacyZips.set(`${id}/${leaf}`, bytes),
      writeStorylineZip: vi.fn(),
    } as any;
    const exportOne = vi.fn(async () => ({
      ok: true as const,
      location: 'https://cdn/mixed.zip',
      jobId: 'backfill-job',
    }));
    const mixedZip = zipSync({
      'content/runtime-data.js': enc('__jsonp("runtime-data.js","")'),
      'content/assets/OLD/story.html': enc('<html>old</html>'),
      'content/assets/OLD/threeSixty.json': enc('{"version":"3.48.24159.0"}'),
      'content/assets/NEW/story.html': enc('<html>new</html>'),
    });
    const { onEvent } = sink();
    const summary = await exportStorylinePackages(store, onEvent, {
      exportOne,
      fetchZip: vi.fn(async () => mixedZip),
      refresh: vi.fn(async () => ({ advanced: true, valid: true })),
      pinTab,
      pacing: { baseMs: 0, jitterMs: 0 },
    });
    expect(summary).toMatchObject({ packaged: 1, legacySaved: 1, failed: 0 });
    expect(store.writeStorylineZip).not.toHaveBeenCalled();
    expect(legacyZips.has('C1/OLD')).toBe(true);
    expect(JSON.parse(manifest).uploads.NEW.reviewPrefix).toBe('review/items/NEW');
  });

  it('aborts up-front (attempts nothing) when the token cannot be refreshed', async () => {
    const { store } = makeStorage();
    const { onEvent, logs } = sink();
    const exportOne = vi.fn();
    const summary = await exportStorylinePackages(store, onEvent, {
      exportOne,
      fetchZip: vi.fn(),
      refresh: vi.fn(async () => ({ advanced: false, valid: false })),
    });
    expect(exportOne).not.toHaveBeenCalled();
    expect(summary.aborted).toMatch(/stale/);
    expect(logs.some((l) => /COURSE EDITOR/.test(l))).toBe(true);
  });

  it('records a per-course (non-auth) failure without throwing', async () => {
    const { store } = makeStorage();
    const { onEvent } = sink();
    const exportOne = vi.fn(async () => ({ ok: false as const, error: 'zip download HTTP 500' }));
    const summary = await exportStorylinePackages(store, onEvent, {
      exportOne,
      fetchZip: vi.fn(),
      refresh: vi.fn(),
    });
    expect(summary).toMatchObject({ packaged: 0, failed: 1, notAttempted: 0 });
    expect(summary.aborted).toBeUndefined();
    expect(summary.errors[0]).toMatchObject({ courseId: 'C1', error: 'zip download HTTP 500' });
  });

  it('aborts the whole run on an auth (403) failure', async () => {
    // two storyline courses; first 403s → abort, second not attempted
    const courses = new Map<string, string>([
      ['C1', JSON.stringify({ payload: COURSE_DOC })],
      ['C2', JSON.stringify({ payload: { ...COURSE_DOC, course: { id: 'C2', title: 'Other' } } })],
    ]);
    const store = {
      listSaved: async () => [...courses.keys()],
      readCourse: async (id: string) => courses.get(id) ?? null,
      readStorylineManifest: async () => null,
      writeStorylineManifest: async () => {},
      writeStorylineZip: async () => {},
    } as any;
    const { onEvent } = sink();
    const exportOne = vi.fn(async () => ({ ok: false as const, error: 'build/raw HTTP 403: Forbidden' }));
    const summary = await exportStorylinePackages(store, onEvent, {
      exportOne,
      fetchZip: vi.fn(),
      refresh: vi.fn(),
      pacing: { baseMs: 0, jitterMs: 0 },
    });
    expect(summary).toMatchObject({ failed: 1, notAttempted: 1 });
    expect(summary.aborted).toMatch(/403/);
    expect(exportOne).toHaveBeenCalledTimes(1); // stopped after the first
  });

  // 5d — the runtime-data cross-check: a saved block whose leaf is absent from
  // the export names the mismatch instead of the opaque "no story.html".
  it('fails a course with a specific contentPrefix-mismatch error when its leaf is absent', async () => {
    const { store } = makeStorage();
    const { onEvent } = sink();
    // an export carrying a DIFFERENT leaf than the saved block's contentPrefix
    const otherLeaf = zipSync(
      {
        'content/runtime-data.js': enc('__jsonp("runtime-data.js","")'),
        'content/assets/OTHERLEAF/story.html': enc('<!-- 360 -->'),
      },
      { mtime: Date.UTC(1980, 0, 1) },
    );
    const summary = await exportStorylinePackages(store, onEvent, {
      exportOne: vi.fn(async () => ({ ok: true as const, location: 'https://cdn/x.zip', jobId: '1' })),
      fetchZip: vi.fn(async () => otherLeaf),
      refresh: vi.fn(),
      pacing: { baseMs: 0, jitterMs: 0 },
    });
    expect(summary).toMatchObject({ packaged: 0, failed: 1 });
    expect(summary.errors[0]!.error).toMatch(/contentPrefix mismatch/);
    expect(summary.errors[0]!.error).toContain(LEAF); // the leaf we expected
    expect(summary.errors[0]!.error).toContain('OTHERLEAF'); // what the export had
    expect(summary.errors[0]!.error).not.toMatch(/no story\.html/);
  });
});

// --- M17: isAuthError precision ------------------------------------------------

describe('isAuthError', () => {
  it('matches real auth/session signals (both passes)', () => {
    for (const msg of [
      'build/raw HTTP 403: Forbidden',
      'HTTP 401 from Rise',
      'Unauthorized (401) from Rise',
      'Rise export socket: identify not received within 30000ms (token likely stale)',
      'Rise export socket: server error -32000: invalid token (identify refused — token likely stale)',
      'stale session token',
      'No Rise token captured yet.',
      'No target account user id (open a logged-in Rise/360 tab).',
      // upload-pass symptoms of a stale bearer (previously unmatched → 30s grind)
      'Review-360 socket connect_error: websocket error',
      'Review-360 items:create ack timed out after 30000ms',
      'Review-360 items:update failed: unauthorized',
    ]) {
      expect(isAuthError(msg), msg).toBe(true);
    }
  });

  it('does NOT match incidental one-course failures (no whole-run abort)', () => {
    for (const msg of [
      'zip download HTTP 500',
      'package too large for the current upload path (61.0 MB > 48 MB base64-message cap)',
      'contentPrefix mismatch: block blk_1 expects package leaf "abc"',
      'Rise export format changed — the story.html repackage transform no longer matches',
      // bare "token"/"session" substrings used to abort the whole run
      'build/raw HTTP 500: websocketSessionId rejected',
      'block uses an unknown design token',
      'items:create ack had no item id: {"session":"x"}',
      'package error (package:error): build cancelled',
    ]) {
      expect(isAuthError(msg), msg).toBe(false);
    }
  });
});

// --- Stage C upload pass: scoping (M16) + size guard (H5c) ---------------------

/** Storage stub with staged manifests + zips for the upload pass. */
function makeUploadStorage(
  courses: Array<{ id: string; leaf: string; zipBytes?: Uint8Array }>,
) {
  const manifests = new Map<string, string>();
  const zips = new Map<string, Uint8Array>();
  for (const c of courses) {
    manifests.set(
      c.id,
      JSON.stringify({ courseId: c.id, title: c.id, blocks: [{ blockId: `blk_${c.id}`, leaf: c.leaf }] }),
    );
    zips.set(`${c.id}/${c.leaf}`, c.zipBytes ?? new Uint8Array([1, 2, 3]));
  }
  return {
    store: {
      listSaved: async () => courses.map((c) => c.id),
      readStorylineManifest: async (id: string) => manifests.get(id) ?? null,
      writeStorylineManifest: async (id: string, json: string) => void manifests.set(id, json),
      readStorylineZip: async (id: string, leaf: string) => zips.get(`${id}/${leaf}`) ?? null,
    } as any,
    manifests,
  };
}

describe('uploadStorylineToReview360 — scoped to selection (M16)', () => {
  const ok = (n: string) => ({ ok: true as const, itemId: `it_${n}`, contentPrefix: `review/items/${n}` });

  it('uploads only the selected courses when onlyCourseIds is given', async () => {
    const { store, manifests } = makeUploadStorage([
      { id: 'C1', leaf: 'L1' },
      { id: 'C2', leaf: 'L2' },
      { id: 'C3', leaf: 'L3' },
    ]);
    const { onEvent, logs } = sink();
    const uploadOne = vi.fn(async (a: { fileName: string }) => ok(a.fileName.replace('.zip', '')));

    const summary = await uploadStorylineToReview360(store, onEvent, {
      uploadOne,
      refresh: vi.fn(),
      pinTab,
      pacing: { baseMs: 0, jitterMs: 0 },
      onlyCourseIds: new Set(['C2']),
    });

    expect(summary).toMatchObject({ courses: 1, uploaded: 1, failed: 0 });
    expect(uploadOne).toHaveBeenCalledTimes(1);
    expect(uploadOne.mock.calls[0]![0].fileName).toBe('L2.zip');
    expect(logs.some((l) => /1 selected course manifest/.test(l))).toBe(true);
    // only C2's manifest gained an uploads record
    expect(JSON.parse(manifests.get('C2')!).uploads.L2.reviewPrefix).toBe('review/items/L2');
    expect(JSON.parse(manifests.get('C1')!).uploads).toBeUndefined();
  });

  it('defaults to every staged manifest when no selection is passed (unchanged behavior)', async () => {
    const { store } = makeUploadStorage([
      { id: 'C1', leaf: 'L1' },
      { id: 'C2', leaf: 'L2' },
    ]);
    const { onEvent } = sink();
    const uploadOne = vi.fn(async (a: { fileName: string }) => ok(a.fileName.replace('.zip', '')));
    const summary = await uploadStorylineToReview360(store, onEvent, {
      uploadOne,
      refresh: vi.fn(),
      pinTab,
      pacing: { baseMs: 0, jitterMs: 0 },
    });
    expect(summary).toMatchObject({ courses: 2, uploaded: 2 });
    expect(uploadOne).toHaveBeenCalledTimes(2);
  });
});

describe('uploadStorylineToReview360 — Review item title', () => {
  const ok = (n: string) => ({ ok: true as const, itemId: `it_${n}`, contentPrefix: `review/items/${n}` });

  it('names the item after the manifest block title, else the course doc, else meta.title', async () => {
    // Live DFO 2026-10-20: 13 items landed as "Untitled1" (the package's
    // internal project title) because the upload sent only the zip file name.
    const manifests = new Map<string, string>([
      ['C1', JSON.stringify({ courseId: 'C1', title: 'C1', blocks: [{ blockId: 'b1', leaf: 'L1', title: 'From manifest' }] })],
      ['C2', JSON.stringify({ courseId: 'C2', title: 'C2', blocks: [{ blockId: 'b2', leaf: 'L2', meta: { title: 'Untitled1' } }] })],
      ['C3', JSON.stringify({ courseId: 'C3', title: 'C3', blocks: [{ blockId: 'b3', leaf: 'L3', meta: { title: 'Untitled1' } }] })],
    ]);
    const courseDoc = (leaf: string, title: string) =>
      JSON.stringify({
        course: { id: 'x' },
        lessons: [{ id: 'les', items: [{ id: 'blk', family: '360', variant: 'storyline', items: [{ id: 'i', media: { storyline: { contentPrefix: `rise/courses/x/${leaf}`, title, meta: { title: 'Untitled1' } } } }] }] }],
      });
    const store = {
      listSaved: async () => ['C1', 'C2', 'C3'],
      readStorylineManifest: async (id: string) => manifests.get(id) ?? null,
      writeStorylineManifest: async (id: string, json: string) => void manifests.set(id, json),
      readStorylineZip: async () => new Uint8Array([1, 2, 3]),
      // C2's older manifest lacks the title → the live course doc supplies it;
      // C3 has neither → the package's meta.title is the last resort.
      readCourse: async (id: string) => (id === 'C2' ? courseDoc('L2', 'From course doc') : null),
    } as any;
    const { onEvent } = sink();
    const uploadOne = vi.fn(async (a: { fileName: string; title?: string }) => ok(a.fileName.replace('.zip', '')));
    await uploadStorylineToReview360(store, onEvent, { uploadOne, refresh: vi.fn(), pinTab, pacing: { baseMs: 0, jitterMs: 0 } });
    const titles = Object.fromEntries(uploadOne.mock.calls.map((c) => [c[0].fileName, c[0].title]));
    expect(titles).toEqual({ 'L1.zip': 'From manifest', 'L2.zip': 'From course doc', 'L3.zip': 'Untitled1' });
  });

  it('records the post-publish renamed title in the upload record', async () => {
    const manifests = new Map<string, string>([
      ['C1', JSON.stringify({ courseId: 'C1', title: 'C1', blocks: [{ blockId: 'b1', leaf: 'L1', title: 'Named' }] })],
    ]);
    const store = {
      listSaved: async () => ['C1'],
      readStorylineManifest: async (id: string) => manifests.get(id) ?? null,
      writeStorylineManifest: async (id: string, json: string) => void manifests.set(id, json),
      readStorylineZip: async () => new Uint8Array([1]),
    } as any;
    const { onEvent } = sink();
    const uploadOne = vi.fn(async (a: { title?: string }) => ({ ok: true as const, itemId: 'it1', contentPrefix: 'review/items/L1', title: a.title }));
    await uploadStorylineToReview360(store, onEvent, { uploadOne, refresh: vi.fn(), pinTab, pacing: { baseMs: 0, jitterMs: 0 } });
    expect(JSON.parse(manifests.get('C1')!).uploads.L1).toEqual({ itemId: 'it1', reviewPrefix: 'review/items/L1', title: 'Named' });
  });
});

describe('renameReviewItemsToBlockTitles — repair pass', () => {
  it('renames uploaded items to their block titles, skips already-named ones, records the title', async () => {
    const manifests = new Map<string, string>([
      ['C1', JSON.stringify({
        courseId: 'C1', title: 'C1',
        blocks: [
          { blockId: 'b1', leaf: 'L1', title: 'Kurs for attestanter', meta: { title: 'Untitled1' } },
          { blockId: 'b2', leaf: 'L2', title: 'Already done', meta: { title: 'Untitled1' } },
          { blockId: 'b3', leaf: 'L3', meta: { title: 'Untitled1' } }, // no block title → skipped (meta.title is what the server already set)
          { blockId: 'b4', leaf: 'L4', title: 'Four', meta: { title: 'Untitled1' } },
        ],
        uploads: {
          L1: { itemId: 'it1', reviewPrefix: 'review/items/L1' },
          L2: { itemId: 'it2', reviewPrefix: 'review/items/L2', title: 'Already done' },
          L3: { itemId: 'it3', reviewPrefix: 'review/items/L3' },
          L4: { itemId: 'it4', reviewPrefix: 'review/items/L4' },
        },
      })],
      ['C2', JSON.stringify({ courseId: 'C2', title: 'C2', blocks: [{ blockId: 'b9', leaf: 'L9' }] })], // never uploaded
    ]);
    const store = {
      listSaved: async () => ['C1', 'C2'],
      readStorylineManifest: async (id: string) => manifests.get(id) ?? null,
      writeStorylineManifest: async (id: string, json: string) => void manifests.set(id, json),
    } as any;
    const { onEvent } = sink();
    const renameOne = vi.fn(async (a: { itemId: string; title: string }) =>
      a.itemId === 'it4' ? { ok: false as const, error: 'boom' } : { ok: true as const },
    );
    const summary = await renameReviewItemsToBlockTitles(store, onEvent, {
      renameOne,
      pinTab,
      pacing: { baseMs: 0, jitterMs: 0 },
    });
    expect(summary).toMatchObject({ courses: 1, renamed: 1, skipped: 2, failed: 1 });
    expect(renameOne.mock.calls.map((c) => [c[0].itemId, c[0].title])).toEqual([
      ['it1', 'Kurs for attestanter'],
      ['it4', 'Four'],
    ]);
    const m = JSON.parse(manifests.get('C1')!);
    expect(m.uploads.L1.title).toBe('Kurs for attestanter');
    expect(m.uploads.L3.title).toBeUndefined();
    expect(m.uploads.L4.title).toBeUndefined();
  });
});

describe('uploadStorylineToReview360 — legacy exclusion', () => {
  it('does not retrigger an old 3.48 manifest but still uploads a 3.49 package', async () => {
    const doc = courseWithVersions([
      { blockId: 'old', leaf: 'OLD', version: '3.48.24159.0' },
      { blockId: 'new', leaf: 'NEW', version: '3.49.24347.0' },
    ]);
    let manifest = JSON.stringify({
      courseId: 'C1',
      title: 'Versioned',
      blocks: [
        { blockId: 'old', leaf: 'OLD', meta: { version: '3.48.24159.0' } },
        { blockId: 'new', leaf: 'NEW', meta: { version: '3.49.24347.0' } },
      ],
    });
    const store = {
      listSaved: async () => ['C1'],
      readCourse: async () => JSON.stringify({ payload: doc }),
      readStorylineManifest: async () => manifest,
      writeStorylineManifest: async (_id: string, json: string) => void (manifest = json),
      readStorylineZip: async (_id: string, leaf: string) =>
        leaf === 'NEW' ? new Uint8Array([1, 2, 3]) : null,
    } as any;
    const { onEvent } = sink();
    const uploadOne = vi.fn(async (_args: { fileName: string }) => ({
      ok: true as const,
      itemId: 'new-item',
      contentPrefix: 'review/items/NEW',
    }));
    const summary = await uploadStorylineToReview360(store, onEvent, {
      uploadOne,
      refresh: vi.fn(),
      pinTab,
      pacing: { baseMs: 0, jitterMs: 0 },
    });
    expect(summary).toMatchObject({ uploaded: 1, failed: 0, legacySkipped: 1 });
    expect(uploadOne).toHaveBeenCalledTimes(1);
    expect(uploadOne.mock.calls[0]![0].fileName).toBe('NEW.zip');
    expect(JSON.parse(manifest).uploads.OLD).toBeUndefined();
  });
});

describe('uploadStorylineToReview360 — unstaged placeholders', () => {
  it('skips source-placeholder entries (never staged, e.g. not exportable)', async () => {
    const doc = courseWithVersions([{ blockId: 'new', leaf: 'NEW', version: '3.49.24347.0' }]);
    const manifest = JSON.stringify({
      courseId: 'C1',
      exportBlocked: 'no export permission',
      blocks: [{ blockId: 'new', leaf: 'NEW', compatibility: 'source-placeholder' }],
    });
    const store = {
      listSaved: async () => ['C1'],
      readCourse: async () => JSON.stringify({ payload: doc }),
      readStorylineManifest: async () => manifest,
      writeStorylineManifest: vi.fn(),
      readStorylineZip: vi.fn(async () => null),
    } as any;
    const { onEvent } = sink();
    const uploadOne = vi.fn();
    const summary = await uploadStorylineToReview360(store, onEvent, {
      uploadOne,
      refresh: vi.fn(),
      pinTab,
      pacing: { baseMs: 0, jitterMs: 0 },
    });
    expect(summary).toMatchObject({ uploaded: 0, failed: 0 });
    expect(uploadOne).not.toHaveBeenCalled();
  });
});

describe('uploadStorylineToReview360 — pre-flight size guard (H5c)', () => {
  it('fails an oversize package with an explicit MB error instead of a messaging failure', async () => {
    const { store } = makeUploadStorage([
      { id: 'C1', leaf: 'BIG', zipBytes: new Uint8Array(MAX_UPLOAD_ZIP_BYTES + 1) },
      { id: 'C2', leaf: 'OK' },
    ]);
    const { onEvent, logs } = sink();
    const uploadOne = vi.fn(async () => ({
      ok: true as const,
      itemId: 'it',
      contentPrefix: 'review/items/OK',
    }));

    const summary = await uploadStorylineToReview360(store, onEvent, {
      uploadOne,
      refresh: vi.fn(),
      pinTab,
      pacing: { baseMs: 0, jitterMs: 0 },
    });

    // the oversize one never reaches the SW; the next course still runs
    expect(uploadOne).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ uploaded: 1, failed: 1 });
    expect(summary.errors[0]).toMatchObject({ courseId: 'C1', leaf: 'BIG' });
    expect(summary.errors[0]!.error).toMatch(/package too large for the current upload path \(48\.0 MB > 48 MB/);
    expect(logs.some((l) => /BIG: FAILED — package too large/.test(l))).toBe(true);
    // an oversize package is NOT an auth failure — the run must not abort
    expect(summary.aborted).toBeUndefined();
  });

  // (A byte-exactly-at-the-cap case is deliberately not tested: base64-encoding
  // a 48MB buffer costs ~1.3s, and the `>` boundary is pinned above.)
  it('leaves a normal-sized package untouched by the guard', async () => {
    const { store } = makeUploadStorage([{ id: 'C1', leaf: 'SMALL' }]);
    const { onEvent } = sink();
    const summary = await uploadStorylineToReview360(store, onEvent, {
      uploadOne: vi.fn(async () => ({ ok: true as const, itemId: 'it', contentPrefix: 'review/items/SMALL' })),
      refresh: vi.fn(),
      pinTab,
      pacing: { baseMs: 0, jitterMs: 0 },
    });
    expect(summary).toMatchObject({ uploaded: 1, failed: 0 });
  });
});

// --- C4: the run's tab pin reaches every write of step D ----------------------

describe('uploadStorylineToReview360 — tab pin (C4)', () => {
  it('carries the run pin on every upload (the writes cannot follow window focus)', async () => {
    const { store } = makeUploadStorage([
      { id: 'C1', leaf: 'L1' },
      { id: 'C2', leaf: 'L2' },
    ]);
    const { onEvent } = sink();
    const uploadOne = vi.fn(async (a: { fileName: string }) => ({
      ok: true as const,
      itemId: 'it',
      contentPrefix: `review/items/${a.fileName}`,
    }));
    const refresh = vi.fn();

    await uploadStorylineToReview360(store, onEvent, {
      uploadOne,
      refresh,
      pinTab,
      pacing: { baseMs: 0, jitterMs: 0 },
    });

    expect(uploadOne).toHaveBeenCalledTimes(2);
    for (const call of uploadOne.mock.calls) {
      expect((call[0] as { pin?: unknown }).pin).toEqual(PIN);
    }
    // the reauth must happen on the pinned plane too, not the focused tab's
    expect(refresh).toHaveBeenCalledWith(PIN);
  });

  it('uploads NOTHING when the tab cannot be pinned (loud, not a silent unpinned run)', async () => {
    const { store, manifests } = makeUploadStorage([{ id: 'C1', leaf: 'L1' }]);
    const { onEvent, logs } = sink();
    const uploadOne = vi.fn();
    const refresh = vi.fn();

    const summary = await uploadStorylineToReview360(store, onEvent, {
      uploadOne,
      refresh,
      pinTab: noPin,
      pacing: { baseMs: 0, jitterMs: 0 },
    });

    expect(uploadOne).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ uploaded: 0, failed: 0, notAttempted: 1 });
    expect(summary.aborted).toMatch(/Could not pin/);
    expect(logs.some((l) => /TARGET account's Review 360/.test(l))).toBe(true);
    // nothing was recorded back into the manifest
    expect(JSON.parse(manifests.get('C1')!).uploads).toBeUndefined();
  });
});

describe('exportStorylinePackages — tab pin (C4)', () => {
  it('warns and still runs unpinned when the tab cannot be pinned (source-side build)', async () => {
    const { store } = makeStorage();
    const { onEvent, logs } = sink();
    const exportOne = vi.fn(async () => ({ ok: true as const, location: 'https://cdn/x.zip', jobId: '1' }));

    const summary = await exportStorylinePackages(store, onEvent, {
      exportOne,
      fetchZip: vi.fn(async () => webExportZip()),
      refresh: vi.fn(),
      pinTab: noPin,
      pacing: { baseMs: 0, jitterMs: 0 },
    });

    expect(summary).toMatchObject({ packaged: 1, failed: 0 });
    expect(exportOne).toHaveBeenCalledWith('C1', 'Geo 101', undefined);
    expect(logs.some((l) => /continuing UNPINNED/.test(l))).toBe(true);
  });
});
