import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { isReview360StoryHtml } from '@/core/storyline/repackage';
import { exportStorylinePackages, scanSavedCoursesForStoryline } from './storyline';
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

// A web-export zip carrying that leaf's package.
function webExportZip(): Uint8Array {
  return zipSync(
    {
      'content/runtime-data.js': enc('__jsonp("runtime-data.js","")'),
      [`content/assets/${LEAF}/story.html`]: enc('<head><meta name="robots" content="noindex, nofollow"></head><!-- 360 -->'),
      [`content/assets/${LEAF}/threeSixty.json`]: enc('{"title":"Geo 101"}'),
    },
    { mtime: Date.UTC(1980, 0, 1) },
  );
}

/** In-memory storage stub implementing only what the orchestrator touches. */
function makeStorage() {
  const courses = new Map<string, string>([['C1', JSON.stringify({ payload: COURSE_DOC })]]);
  const zips = new Map<string, Uint8Array>();
  const manifests = new Map<string, string>();
  return {
    store: {
      listSaved: async () => [...courses.keys()],
      readCourse: async (id: string) => courses.get(id) ?? null,
      readStorylineManifest: async (id: string) => manifests.get(id) ?? null,
      writeStorylineManifest: async (id: string, json: string) => void manifests.set(id, json),
      writeStorylineZip: async (id: string, leaf: string, bytes: Uint8Array) =>
        void zips.set(`${id}/${leaf}`, bytes),
    } as any,
    zips,
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

describe('exportStorylinePackages', () => {
  it('triggers export, downloads, repackages each leaf, writes a manifest', async () => {
    const { store, zips, manifests } = makeStorage();
    const { onEvent } = sink();
    const exportOne = vi.fn(async () => ({ ok: true as const, location: 'https://cdn/x.zip', jobId: '99' }));
    const fetchZip = vi.fn(async () => webExportZip());
    const refresh = vi.fn(async () => ({ advanced: true, valid: true }));

    const summary = await exportStorylinePackages(store, onEvent, { exportOne, fetchZip, refresh, pacing: { baseMs: 0, jitterMs: 0 } });

    expect(summary).toMatchObject({ courses: 1, packaged: 1, skipped: 0, failed: 0 });
    expect(exportOne).toHaveBeenCalledWith('C1', 'Geo 101');

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

  it('skips a course that already has a manifest (resume)', async () => {
    const { store, manifests } = makeStorage();
    manifests.set('C1', '{}');
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
    expect(summary.errors[0]).toEqual({ courseId: 'C1', error: 'zip download HTTP 500' });
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
});
