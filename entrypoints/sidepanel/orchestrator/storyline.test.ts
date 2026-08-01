import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { isReview360StoryHtml } from '@/core/storyline/repackage';
import {
  exportStorylinePackages,
  isAuthError,
  MAX_UPLOAD_ZIP_BYTES,
  scanSavedCoursesForStoryline,
  uploadStorylineToReview360,
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
    expect(refresh).toHaveBeenCalledWith(PIN);

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
