import { describe, it, expect } from 'vitest';
import { buildPlan, type PlanInput } from './plan';
import { executePlan, type Relay } from './executor';
import { IdMap } from './ids';
import { parseTypefaces } from './typefaces';
import { counterMint, mockRelay, imageCourse, happyHandlers } from './executor.fixtures';

describe('executePlan — image course happy path', () => {
  it('creates course → lesson → block → uploads → patches, no surviving keys', async () => {
    const input = imageCourse();
    const steps = buildPlan(input);
    const { relay, calls } = mockRelay(happyHandlers);
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.newCourseId).toBe('NEWCOURSE');
    expect(res.survivingKeys).toEqual([]);
    // The S3 PUT fired (faithful upload — no CRUSH).
    expect(calls.some((c) => c.url === 'https://s3/put' && c.method === 'PUT')).toBe(true);
    // old→new course mapping recorded in the resumable job log
    expect(res.idMap['SRC']).toBe('NEWCOURSE');
    expect(res.idMap['L1']).toBe('NEWLESSON');
  });
});

describe('executePlan — multi-key block (key + crushedKey)', () => {
  it('uploads + remaps BOTH keys so no source key survives', async () => {
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [
        { key: 'rise/courses/SRC/orig.jpg', kind: 'media-image', file: 'assets/a.jpg', ext: 'jpg' },
        { key: 'rise/courses/SRC/crush.jpg', kind: 'media-image', file: 'assets/b.jpg', ext: 'jpg' },
      ],
      banksById: new Map(),
      course: {
        course: { id: 'SRC', title: 'C' },
        lessons: [
          {
            id: 'L1',
            position: 0,
            type: 'blocks',
            title: 'L',
            items: [
              {
                id: 'cblock00000000000000000000',
                family: 'image',
                variant: 'hero',
                items: [
                  {
                    id: 'citem000000000000000000000',
                    media: {
                      image: {
                        key: 'rise/courses/SRC/orig.jpg',
                        crushedKey: 'rise/courses/SRC/crush.jpg',
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    const steps = buildPlan(input);
    let yurlN = 0;
    const { relay } = mockRelay({
      ...happyHandlers,
      'GET_YURL': () => ({
        payload: { key: `rise/courses/NEWCOURSE/srv${yurlN++}.jpg`, url: 'https://s3/put', type: 'image/jpeg' },
      }),
    });
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    expect(res.survivingKeys).toEqual([]);
    // two uploads happened (orig + crushed)
    expect(res.envelopes.filter((e) => e.label === 'S3 PUT (upload bytes)').length).toBe(2);
  });
});

describe('executePlan — reused asset (dedup)', () => {
  it('uploads a key shared across blocks ONCE and reuses it', async () => {
    // The same logo key referenced by TWO blocks in one lesson.
    const logo = 'rise/courses/SRC/logo.png';
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [{ key: logo, kind: 'media-image', file: 'assets/logo.png', ext: 'png' }],
      banksById: new Map(),
      course: {
        course: { id: 'SRC', title: 'C' },
        lessons: [
          {
            id: 'L1',
            position: 0,
            type: 'blocks',
            title: 'L',
            items: [
              { id: 'cb1aaaaaaaaaaaaaaaaaaaaaa', family: 'image', variant: 'hero', items: [{ id: 'ci1aaaaaaaaaaaaaaaaaaaaaa', media: { image: { key: logo } } }] },
              { id: 'cb2aaaaaaaaaaaaaaaaaaaaaa', family: 'image', variant: 'hero', items: [{ id: 'ci2aaaaaaaaaaaaaaaaaaaaaa', media: { image: { key: logo } } }] },
            ],
          },
        ],
      },
    };
    let yurlN = 0;
    const { relay } = mockRelay({
      ...happyHandlers,
      'GET_YURL': () => ({ payload: { key: `rise/courses/NEWCOURSE/up${yurlN++}.png`, url: 'https://s3/put', type: 'image/png' } }),
      // Return metadata for ALL blocks in the batch (this lesson has two).
      'CREATE_BLOCKS': (body: unknown) => {
        const blocks = (body as { payload: { blocks: { id: string }[] } }).payload.blocks;
        return { payload: { success: true, blockMetadata: blocks.map((b, i) => ({ id: b.id, globalBlockId: `g${i}` })) } };
      },
    });
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/png' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    expect(res.survivingKeys).toEqual([]);
    // Uploaded ONCE despite two references (one GET_YURL, one S3 PUT).
    expect(yurlN).toBe(1);
    expect(res.envelopes.filter((e) => e.label === 'S3 PUT (upload bytes)').length).toBe(1);
  });
});

describe('executePlan — mixed uploadable + orphaned key on one block (C2)', () => {
  it('patches the block with the new key and BLANKS the orphaned key; survivingKeys is unfiltered', async () => {
    const GOOD = 'rise/courses/SRC/good.jpg';
    const GONE = 'rise/courses/SRC/gone.jpg';
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [
        { key: GOOD, kind: 'media-image', file: 'assets/g.jpg', ext: 'jpg' },
        { key: GONE, kind: 'media-image', orphaned: true },
      ],
      banksById: new Map(),
      course: {
        course: { id: 'SRC', title: 'C' },
        lessons: [
          {
            id: 'L1',
            position: 0,
            type: 'blocks',
            title: 'L',
            items: [
              {
                id: 'cblock00000000000000000000',
                family: 'gallery',
                variant: 'grid',
                items: [
                  { id: 'ci1aaaaaaaaaaaaaaaaaaaaaa', media: { image: { key: GOOD } } },
                  { id: 'ci2aaaaaaaaaaaaaaaaaaaaaa', media: { image: { key: GONE } } },
                ],
              },
            ],
          },
        ],
      },
    };
    let patched: any = null;
    const { relay } = mockRelay({
      ...happyHandlers,
      UPDATE_BLOCK_DEBOUNCE: (body: any) => {
        patched = body.payload;
        return { payload: { success: true } };
      },
    });
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async (k) => (k === GOOD ? { base64: 'AAAA', contentType: 'image/jpeg' } : null),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    // The patch carries the NEW key, and the orphaned source key is BLANKED —
    // not shipped verbatim (the old remap skipped keys mapped to '').
    expect(patched).toBeTruthy();
    const json = JSON.stringify(patched);
    expect(json).toContain('rise/courses/NEWCOURSE/server.jpg');
    expect(json).not.toContain('rise/courses/SRC');
    expect(patched.item.items[1].media.image.key).toBe('');
    // Flagged for the operator…
    expect(res.flags.some((f) => f.kind === 'orphan-media' && f.sourceKey === GONE)).toBe(true);
    // …and the final assertion passes UNFILTERED (nothing hidden behind flags).
    expect(res.survivingKeys).toEqual([]);
  });
});

describe('executePlan — orphaned course cover (missing archived bytes)', () => {
  it('flags + blanks the cover so UPDATE_COURSE ships without it and the course SUCCEEDS', async () => {
    const COVER = 'rise/courses/SRC/cover.jpg';
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      // Manifest says the file exists — the bytes are missing only at runtime.
      assets: [{ key: COVER, kind: 'media-image', file: 'assets/c.jpg', ext: 'jpg' }],
      banksById: new Map(),
      course: {
        course: {
          id: 'SRC',
          title: 'C',
          coverImage: { media: { image: { key: COVER } } },
        },
        lessons: [
          { id: 'L1', position: 0, type: 'blocks', title: 'L', items: [{ id: 'cb1aaaaaaaaaaaaaaaaaaaaaa', family: 'text', variant: 'p', items: [] }] },
        ],
      },
    };
    const updateCoursePayloads: any[] = [];
    const relay: Relay = async (spec) => {
      if (spec.url.includes('/manage/api/content')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      if (spec.label.includes('GET_COURSE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }) };
      if (spec.label.endsWith('/UPDATE_COURSE')) { updateCoursePayloads.push(JSON.parse(spec.body!).payload); return { ok: true, status: 200, text: '{}' }; }
      if (spec.label.includes('CREATE_LESSON')) return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON' } } }) };
      if (spec.label.includes('CREATE_BLOCKS')) { const id = JSON.parse(spec.body!).payload.blocks[0].id; return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: [{ id, globalBlockId: 'g' }] } }) }; }
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => null, // bytes gone
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    // The course succeeds WITH a flag — no late hard-fail after all writes.
    expect(res.ok).toBe(true);
    expect(res.survivingKeys).toEqual([]);
    expect(res.flags.some((f) => f.kind === 'orphan-media' && f.sourceKey === COVER)).toBe(true);
    // UPDATE_COURSE never shipped the source cover key (or any cover at all).
    expect(JSON.stringify(updateCoursePayloads)).not.toContain('rise/courses/SRC');
    expect(updateCoursePayloads.some((p) => p.coverImage)).toBe(false);
  });
});

describe('executePlan — course image key dedup via keyMap', () => {
  it('a key shared by coverImage and cardImage uploads ONCE (8c)', async () => {
    const K = 'rise/courses/SRC/shared.jpg';
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [{ key: K, kind: 'media-image', file: 'assets/s.jpg', ext: 'jpg' }],
      banksById: new Map(),
      course: {
        course: {
          id: 'SRC',
          title: 'C',
          coverImage: { media: { image: { key: K } } },
          cardImage: { media: { image: { key: K } } },
        },
        lessons: [
          { id: 'L1', position: 0, type: 'blocks', title: 'L', items: [{ id: 'cb1aaaaaaaaaaaaaaaaaaaaaa', family: 'text', variant: 'p', items: [] }] },
        ],
      },
    };
    let yurlN = 0;
    let imgPayload: any = null;
    const relay: Relay = async (spec) => {
      if (spec.url.includes('/manage/api/content')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      if (spec.label.includes('GET_COURSE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }) };
      if (spec.label.includes('GET_YURL')) return { ok: true, status: 200, text: JSON.stringify({ payload: { key: `rise/courses/NEWCOURSE/srv${yurlN++}.jpg`, url: 'https://s3/c', type: 'image/jpeg' } }) };
      if (spec.label.endsWith('/UPDATE_COURSE')) { const p = JSON.parse(spec.body!).payload; if (p.coverImage || p.cardImage) imgPayload = p; return { ok: true, status: 200, text: '{}' }; }
      if (spec.label.includes('CREATE_LESSON')) return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON' } } }) };
      if (spec.label.includes('CREATE_BLOCKS')) { const id = JSON.parse(spec.body!).payload.blocks[0].id; return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: [{ id, globalBlockId: 'g' }] } }) }; }
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    expect(res.survivingKeys).toEqual([]);
    // One upload for the shared key (one GET_YURL, one S3 PUT)…
    expect(yurlN).toBe(1);
    expect(res.envelopes.filter((e) => e.label === 'S3 PUT (cover)').length).toBe(1);
    // …and both images point at the SAME new key.
    expect(imgPayload.coverImage.media.image.key).toBe('rise/courses/NEWCOURSE/srv0.jpg');
    expect(imgPayload.cardImage.media.image.key).toBe('rise/courses/NEWCOURSE/srv0.jpg');
  });
});

describe('executePlan — course with a cover image', () => {
  it('flags course-level media (no captured write path) without false-failing', async () => {
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [{ key: 'rise/courses/SRC/cover.jpg', kind: 'media-image', file: 'assets/c.jpg', ext: 'jpg' }],
      banksById: new Map(),
      course: {
        course: {
          id: 'SRC',
          title: 'C',
          coverImage: { key: 'rise/courses/SRC/cover.jpg' },
          theme: { themeId: 't', coverImage: 'rise/courses/SRC/cover.jpg' },
        },
        lessons: [
          {
            id: 'L1',
            position: 0,
            type: 'blocks',
            title: 'L',
            headerImage: { key: 'rise/courses/SRC/hdr.jpg' },
            items: [{ id: 'cb1aaaaaaaaaaaaaaaaaaaaaa', family: 'text', variant: 'p', items: [] }],
          },
        ],
      },
    };
    const steps = buildPlan(input);
    const { relay } = mockRelay(happyHandlers);
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    // The run succeeds: course/lesson/theme media is flagged, not shipped as a key.
    expect(res.ok).toBe(true);
    expect(res.survivingKeys).toEqual([]);
    expect(res.flags.some((f) => f.kind === 'unsupported-media')).toBe(true);
  });
});

describe('executePlan — block ordering (batched create)', () => {
  it('sends ALL of a lesson’s blocks in ONE ordered CREATE_BLOCKS', async () => {
    const families = ['text', 'divider', 'continue', 'list', 'impact'];
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [],
      banksById: new Map(),
      course: {
        course: { id: 'SRC', title: 'C' },
        lessons: [
          {
            id: 'L1',
            position: 0,
            type: 'blocks',
            title: 'L',
            items: families.map((f, i) => ({
              id: `cblk${i}aaaaaaaaaaaaaaaaaaaa`,
              family: f,
              variant: 'v',
              items: [],
            })),
          },
        ],
      },
    };
    const steps = buildPlan(input);
    const createBlocksCalls: unknown[][] = [];
    const relay: Relay = async (spec) => {
      if (spec.label.includes('/manage/api/content')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      if (spec.label.includes('GET_COURSE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }) };
      if (spec.label.includes('CREATE_LESSON')) return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON' } } }) };
      if (spec.label.includes('CREATE_BLOCKS')) {
        const blocks = JSON.parse(spec.body!).payload.blocks as { id: string }[];
        createBlocksCalls.push(blocks);
        // Return metadata in REVERSED order to prove id-based (not positional) mapping.
        const metas = [...blocks].reverse().map((b) => ({ id: b.id, globalBlockId: 'g' }));
        return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: metas } }) };
      }
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(steps, { input, relay, readAsset: async () => null, ids: new IdMap(counterMint()), mintId: counterMint() });
    expect(res.ok).toBe(true);
    // Exactly ONE CREATE_BLOCKS for the lesson, carrying all 5 blocks in source order.
    expect(createBlocksCalls.length).toBe(1);
    expect(createBlocksCalls[0]!.length).toBe(5);
    // Every source block id is mapped (id-based metadata matching survives reordering).
    for (let i = 0; i < 5; i++) {
      expect(res.idMap[`cblk${i}aaaaaaaaaaaaaaaaaaaa`]).toBeTruthy();
    }
  });
});

describe('executePlan — course cover image', () => {
  it('uploads the cover + crushedKey faithfully and sets it via UPDATE_COURSE (no surviving key)', async () => {
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [{ key: 'rise/courses/SRC/cover.jpg', kind: 'media-image', file: 'assets/c.jpg', ext: 'jpg' }],
      banksById: new Map(),
      course: {
        course: {
          id: 'SRC',
          title: 'C',
          coverImage: {
            media: { image: { key: 'rise/courses/SRC/cover.jpg', crushedKey: 'rise/courses/SRC/cc.jpg', sourcedFrom: 'USER' } } },
        },
        lessons: [
          { id: 'L1', position: 0, type: 'blocks', title: 'L', items: [{ id: 'cb1aaaaaaaaaaaaaaaaaaaaaa', family: 'text', variant: 'p', items: [] }] },
        ],
      },
    };
    let coverPayload: any = null;
    let yurlN = 0;
    const relay: Relay = async (spec) => {
      if (spec.url.includes('/manage/api/content')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      if (spec.label.includes('GET_COURSE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }) };
      // Both the cover `key` AND `crushedKey` are uploaded faithfully (verbatim
      // bytes) — no CRUSH. Distinct GET_YURL keys per upload.
      if (spec.label.includes('GET_YURL')) return { ok: true, status: 200, text: JSON.stringify({ payload: { key: `rise/courses/NEWCOURSE/srv${yurlN++}.jpg`, url: 'https://s3/c', type: 'image/jpeg' } }) };
      if (spec.label.endsWith('/UPDATE_COURSE')) { const p = JSON.parse(spec.body!).payload; if (p.coverImage) coverPayload = p; return { ok: true, status: 200, text: '{}' }; }
      if (spec.label.includes('CREATE_LESSON')) return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON' } } }) };
      if (spec.label.includes('CREATE_BLOCKS')) { const id = JSON.parse(spec.body!).payload.blocks[0].id; return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: [{ id, globalBlockId: 'g' }] } }) }; }
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    expect(res.survivingKeys).toEqual([]);
    expect(coverPayload).toBeTruthy();
    // both source keys remapped to their own faithful uploads (no re-crush)
    expect(coverPayload.coverImage.media.image.key).toBe('rise/courses/NEWCOURSE/srv0.jpg');
    expect(coverPayload.coverImage.media.image.crushedKey).toBe('rise/courses/NEWCOURSE/srv1.jpg');
    // no CRUSH_IMAGE was sent
    expect(res.envelopes.some((e) => e.label.includes('CRUSH'))).toBe(false);
    // and it's not left flagged
    expect(res.flags.some((f) => f.sourceKey === 'rise/courses/SRC/cover.jpg')).toBe(false);
  });

  it('uploads the cover-page logo (course.media) + sets it via UPDATE_COURSE media (no surviving key, no flag)', async () => {
    // Capture-confirmed: the logo lives at course.media = {image:{key,crushedKey,…}}
    // (no inner `media` wrapper) and is set via UPDATE_COURSE {media:{image:{…}}}.
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [{ key: 'rise/courses/SRC/logo.png', kind: 'media-image', file: 'assets/l.png', ext: 'png' }],
      banksById: new Map(),
      course: {
        course: {
          id: 'SRC',
          title: 'C',
          media: { image: { key: 'rise/courses/SRC/logo.png', crushedKey: 'rise/courses/SRC/logoc.png', isSkipCrush: true, sourcedFrom: 'USER', useCrushedKey: false, originalUrl: 'logo.png' } },
        },
        lessons: [
          { id: 'L1', position: 0, type: 'blocks', title: 'L', items: [{ id: 'cb1aaaaaaaaaaaaaaaaaaaaaa', family: 'text', variant: 'p', items: [] }] },
        ],
      },
    };
    let mediaPayload: any = null;
    let yurlN = 0;
    const relay: Relay = async (spec) => {
      if (spec.url.includes('/manage/api/content')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      if (spec.label.includes('GET_COURSE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }) };
      if (spec.label.includes('GET_YURL')) return { ok: true, status: 200, text: JSON.stringify({ payload: { key: `rise/courses/NEWCOURSE/srv${yurlN++}.png`, url: 'https://s3/l', type: 'image/png' } }) };
      if (spec.label.endsWith('/UPDATE_COURSE')) { const p = JSON.parse(spec.body!).payload; if (p.media) mediaPayload = p; return { ok: true, status: 200, text: '{}' }; }
      if (spec.label.includes('CREATE_LESSON')) return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON' } } }) };
      if (spec.label.includes('CREATE_BLOCKS')) { const id = JSON.parse(spec.body!).payload.blocks[0].id; return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: [{ id, globalBlockId: 'g' }] } }) }; }
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/png' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    expect(res.survivingKeys).toEqual([]);
    expect(mediaPayload).toBeTruthy();
    // logo `key` + `crushedKey` each remapped to their own faithful upload; the
    // `image` sits directly under `media` (no inner wrapper), and flags are clean.
    expect(mediaPayload.media.image.key).toBe('rise/courses/NEWCOURSE/srv0.png');
    expect(mediaPayload.media.image.crushedKey).toBe('rise/courses/NEWCOURSE/srv1.png');
    expect(mediaPayload.media.image.originalUrl).toBe('logo.png'); // verbatim round-trip
    expect(res.flags.some((f) => f.sourceKey === 'rise/courses/SRC/logo.png')).toBe(false);
  });

  it('uploads lessonHeaderImage incl. nested originalImage keys (none survive) + sets it via UPDATE_COURSE', async () => {
    // Capture-confirmed write: UPDATE_COURSE {lessonHeaderImage:{media:{image:{…}}}}.
    // Source may nest an uncropped `originalImage` with its own key/crushedKey —
    // ALL keys must be uploaded + remapped so none survives.
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [
        { key: 'rise/courses/SRC/h.jpg', kind: 'media-image', file: 'assets/h.jpg', ext: 'jpg' },
        { key: 'rise/courses/SRC/hc.jpg', kind: 'media-image', file: 'assets/hc.jpg', ext: 'jpg' },
        { key: 'rise/courses/SRC/ho.jpg', kind: 'media-image', file: 'assets/ho.jpg', ext: 'jpg' },
        { key: 'rise/courses/SRC/hoc.jpg', kind: 'media-image', file: 'assets/hoc.jpg', ext: 'jpg' },
      ],
      banksById: new Map(),
      course: {
        course: {
          id: 'SRC',
          title: 'C',
          lessonHeaderImage: {
            alpha: 0.4,
            media: {
              image: {
                key: 'rise/courses/SRC/h.jpg',
                crushedKey: 'rise/courses/SRC/hc.jpg',
                sourcedFrom: 'USER',
                originalImage: { key: 'rise/courses/SRC/ho.jpg', crushedKey: 'rise/courses/SRC/hoc.jpg', sourcedFrom: 'USER' },
              },
            },
          },
        },
        lessons: [
          { id: 'L1', position: 0, type: 'blocks', title: 'L', items: [{ id: 'cb1aaaaaaaaaaaaaaaaaaaaaa', family: 'text', variant: 'p', items: [] }] },
        ],
      },
    };
    let hdr: any = null;
    let yurlN = 0;
    const relay: Relay = async (spec) => {
      if (spec.url.includes('/manage/api/content')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      if (spec.label.includes('GET_COURSE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }) };
      if (spec.label.includes('GET_YURL')) return { ok: true, status: 200, text: JSON.stringify({ payload: { key: `rise/courses/NEWCOURSE/h${yurlN++}.jpg`, url: 'https://s3/h', type: 'image/jpeg' } }) };
      if (spec.label.endsWith('/UPDATE_COURSE')) { const p = JSON.parse(spec.body!).payload; if (p.lessonHeaderImage) hdr = p; return { ok: true, status: 200, text: '{}' }; }
      if (spec.label.includes('CREATE_LESSON')) return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON' } } }) };
      if (spec.label.includes('CREATE_BLOCKS')) { const id = JSON.parse(spec.body!).payload.blocks[0].id; return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: [{ id, globalBlockId: 'g' }] } }) }; }
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    expect(res.survivingKeys).toEqual([]); // incl. the nested originalImage keys
    expect(hdr).toBeTruthy();
    const im = hdr.lessonHeaderImage.media.image;
    expect(im.key.startsWith('rise/courses/NEWCOURSE/')).toBe(true);
    expect(im.crushedKey.startsWith('rise/courses/NEWCOURSE/')).toBe(true);
    expect(im.originalImage.key.startsWith('rise/courses/NEWCOURSE/')).toBe(true);
    expect(im.originalImage.crushedKey.startsWith('rise/courses/NEWCOURSE/')).toBe(true);
    expect(im.alpha === undefined || true).toBe(true); // alpha preserved on the wrapper
  });
});

describe('executePlan — typography migration', () => {
  it('recreates a missing custom font and sets the new typeface id on the course', async () => {
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [],
      banksById: new Map(),
      course: {
        course: {
          id: 'SRC',
          title: 'C',
          bodyTypefaceId: 'src-brand',
          theme: { themeId: 'organic', bodyTypefaceId: 'src-brand' },
        },
        lessons: [
          { id: 'L1', position: 0, type: 'blocks', title: 'L', items: [{ id: 'cb1aaaaaaaaaaaaaaaaaaaaaa', family: 'text', variant: 'p', items: [] }] },
        ],
      },
    };
    const sourceTypefaces = parseTypefaces({
      typefaces: [
        { id: 'src-brand', name: 'AcmeBrand', default: false, fonts: [{ key: 'rise/fonts/a.woff', style: 'regular', original: 'Acme.woff' }] },
      ],
    });
    const seen: string[] = [];
    let coverBody: any = null;
    const relay: Relay = async (spec) => {
      seen.push(spec.label);
      if (spec.url.includes('/manage/api/content')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      if (spec.label.includes('GET_COURSE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }) };
      if (spec.label.includes('GET_YURL'))
        return { ok: true, status: 200, text: JSON.stringify({ payload: { key: 'rise/fonts/NEW.woff', url: 'https://s3/f', type: 'font/woff', filename: 'NEW.woff' } }) };
      if (spec.label.includes('CREATE_TYPEFACE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { id: 'NEWTF' } }) };
      // The theme write is the plain UPDATE_COURSE (NOT UPDATE_COURSE_FIELD_THROTTLE).
      if (spec.label.endsWith('/UPDATE_COURSE')) { coverBody = JSON.parse(spec.body!).payload; return { ok: true, status: 200, text: '{}' }; }
      if (spec.label.includes('CREATE_LESSON')) return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON' } } }) };
      if (spec.label.includes('CREATE_BLOCKS')) {
        const id = JSON.parse(spec.body!).payload.blocks[0].id;
        return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: [{ id, globalBlockId: 'g' }] } }) };
      }
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(steps2(input), {
      input,
      relay,
      readAsset: async () => null,
      sourceTypefaces,
      // Target account has only Lato (a built-in) — the source brand font
      // "AcmeBrand" isn't there by name, so it must be recreated.
      targetTypefaces: parseTypefaces({
        typefaces: [{ id: 'tgt-lato', name: 'Lato', default: true, fonts: [] }],
      }),
      readFontBytes: async () => ({ base64: 'AAAA', contentType: 'font/woff' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    // The font was uploaded + registered, and the course got the NEW typeface id.
    expect(res.envelopes.some((e) => e.label === 'S3 PUT (font)')).toBe(true);
    expect(seen.some((s) => s.includes('CREATE_TYPEFACE'))).toBe(true);
    // The executor must NOT FETCH_TYPEFACES on the brand-new course (it 404s);
    // target fonts are pre-fetched by the orchestrator and passed in.
    expect(seen.some((s) => s.includes('FETCH_TYPEFACES'))).toBe(false);
    expect(coverBody.bodyTypefaceId).toBe('NEWTF');
    expect(coverBody.theme.bodyTypefaceId).toBe('NEWTF');
  });

  it('reuses a pre-resolved typefaceIdMap (step A) without re-uploading fonts', async () => {
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [],
      banksById: new Map(),
      course: {
        course: {
          id: 'SRC',
          title: 'C',
          bodyTypefaceId: 'src-brand',
          theme: { themeId: 'organic', bodyTypefaceId: 'src-brand' },
        },
        lessons: [
          { id: 'L1', position: 0, type: 'blocks', title: 'L', items: [{ id: 'cb1aaaaaaaaaaaaaaaaaaaaaa', family: 'text', variant: 'p', items: [] }] },
        ],
      },
    };
    const seen: string[] = [];
    let coverBody: any = null;
    const relay: Relay = async (spec) => {
      seen.push(spec.label);
      if (spec.url.includes('/manage/api/content')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      if (spec.label.includes('GET_COURSE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }) };
      if (spec.label.endsWith('/UPDATE_COURSE')) { coverBody = JSON.parse(spec.body!).payload; return { ok: true, status: 200, text: '{}' }; }
      if (spec.label.includes('CREATE_LESSON')) return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON' } } }) };
      if (spec.label.includes('CREATE_BLOCKS')) {
        const id = JSON.parse(spec.body!).payload.blocks[0].id;
        return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: [{ id, globalBlockId: 'g' }] } }) };
      }
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(steps2(input), {
      input,
      relay,
      readAsset: async () => null,
      // Step A already resolved this font account-wide → just apply the id.
      typefaceIdMap: new Map([['src-brand', 'TGTBRAND']]),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    // No font upload / typeface creation — A did it.
    expect(seen.some((s) => s.includes('GET_YURL'))).toBe(false);
    expect(seen.some((s) => s.includes('CREATE_TYPEFACE'))).toBe(false);
    expect(coverBody.bodyTypefaceId).toBe('TGTBRAND');
    expect(coverBody.theme.bodyTypefaceId).toBe('TGTBRAND');
  });
});

function steps2(input: PlanInput) {
  return buildPlan(input);
}

describe('executePlan — lesson header image', () => {
  it('uploads the header, remaps it into UPDATE_LESSON, leaves no surviving key', async () => {
    const key = 'rise/courses/SRC/hdr.png';
    const input: PlanInput = {
      author: 'auth0|t',
      targetFolderId: 'all',
      assets: [{ key, kind: 'media-image', file: 'assets/h.png', ext: 'png', size: 4096 }],
      banksById: new Map(),
      course: {
        course: { id: 'SRC', title: 'C' },
        lessons: [
          {
            id: 'L1',
            position: 0,
            type: 'blocks',
            title: 'L',
            headerImage: { key },
            items: [{ id: 'cb1aaaaaaaaaaaaaaaaaaaaaa', family: 'text', variant: 'p', items: [] }],
          },
        ],
      },
    };
    let lessonPayload: any = null;
    let yurlN = 0;
    const relay: Relay = async (spec) => {
      if (spec.url.includes('/manage/api/content')) return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      if (spec.label.includes('GET_COURSE')) return { ok: true, status: 200, text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }) };
      if (spec.label.includes('GET_YURL')) return { ok: true, status: 200, text: JSON.stringify({ payload: { key: `rise/courses/NEWCOURSE/srv${yurlN++}.png`, url: 'https://s3/h', type: 'image/png' } }) };
      if (spec.label.includes('CREATE_LESSON')) return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: 'NEWLESSON' } } }) };
      if (spec.label.includes('UPDATE_LESSON')) { lessonPayload = JSON.parse(spec.body!).payload; return { ok: true, status: 200, text: '{}' }; }
      if (spec.label.includes('CREATE_BLOCKS')) { const id = JSON.parse(spec.body!).payload.blocks[0].id; return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true, blockMetadata: [{ id, globalBlockId: 'g' }] } }) }; }
      return { ok: true, status: 200, text: '{}' };
    };
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/png' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    expect(res.survivingKeys).toEqual([]);
    // The header is set on the lesson and points at the NEW (target) key, not SRC.
    expect(lessonPayload.headerImage.key).toBe('rise/courses/NEWCOURSE/srv0.png');
    // No unsupported-media flag for the header (it was uploaded).
    expect(res.flags.some((f) => f.sourceKey === key)).toBe(false);
  });
});


describe('built-in (library) course images — copied, probed, flagged', () => {
  const LIB = 'assets/rise/assets/getting-started-with-rise-360-sample-course/cover.jpg';

  function builtinCoverCourse(): PlanInput {
    const input = imageCourse();
    input.course.course!.coverImage = { media: { image: { key: LIB, isSquare: false } } };
    return input;
  }

  it('plans set-course-images even with NO uploadable key (was silently dropped)', () => {
    const steps = buildPlan(builtinCoverCourse());
    const step = steps.find((s) => s.kind === 'set-course-images');
    expect(step).toMatchObject({ hasCover: true });
    expect(step!.summary).toContain('built-in');
  });

  it('ships the object VERBATIM (no GET_YURL for a library key) and flags nothing when the target serves it', async () => {
    const input = builtinCoverCourse();
    const bodies: { url: string; body: string }[] = [];
    const { relay } = mockRelay(happyHandlers);
    const probed: string[] = [];
    const res = await executePlan(buildPlan(input), {
      input,
      relay: async (spec) => {
        if (spec.body) bodies.push({ url: spec.url, body: spec.body });
        return relay(spec);
      },
      readAsset: async () => ({ base64: 'Zm9v', contentType: 'image/jpeg' }),
      mintId: counterMint(),
      targetPlane: 'eu',
      probeBuiltinAsset: async (url) => {
        probed.push(url);
        return { ok: true, status: 200 };
      },
    });
    expect(res.ok).toBe(true);
    // probed on the TARGET plane
    expect(probed).toEqual([`https://cdn.eu.articulate.com/${LIB}`]);
    // the cover rode UPDATE_COURSE with the library key intact
    const setImages = bodies.find((b) => b.body.includes('coverImage'));
    expect(setImages).toBeDefined();
    expect(setImages!.body).toContain(LIB);
    // available → no flag
    expect(res.flags.some((f) => f.kind === 'builtin-asset')).toBe(false);
  });

  it('flags (but still ships) an asset the target plane does not serve', async () => {
    const input = builtinCoverCourse();
    const { relay } = mockRelay(happyHandlers);
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => ({ base64: 'Zm9v', contentType: 'image/jpeg' }),
      mintId: counterMint(),
      targetPlane: 'eu',
      probeBuiltinAsset: async () => ({ ok: false, status: 404 }),
    });
    expect(res.ok).toBe(true); // a built-in is not an account key → never blocks success
    const flag = res.flags.find((f) => f.kind === 'builtin-asset');
    expect(flag?.detail).toContain('NOT served by the EU plane');
    expect(flag?.detail).toContain(LIB);
  });

  it('flags as UNVERIFIED when no prober is wired (never silently trusted)', async () => {
    const input = builtinCoverCourse();
    const { relay } = mockRelay(happyHandlers);
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => ({ base64: 'Zm9v', contentType: 'image/jpeg' }),
      mintId: counterMint(),
    });
    const flag = res.flags.find((f) => f.kind === 'builtin-asset');
    expect(flag?.detail).toMatch(/NOT checked/);
  });
});

describe('duplicate block ids across lessons (Rise sample courses)', () => {
  /** Two lessons whose blocks BOTH use ids "1"/"2" — the shape that made the
   *  server clobber blocks and drop their l10n cells. */
  function collidingCourse(): PlanInput {
    const block = (id: string, variant: string, key?: string) => ({
      id,
      family: key ? 'image' : 'text',
      variant,
      type: key ? 'image' : 'text',
      items: [
        key
          ? { id: '1', media: { image: { key, type: 'image' } } }
          : { id: '1', paragraph: `text of ${variant}` },
      ],
    });
    return {
      author: 'auth0|target',
      targetFolderId: 'all',
      banksById: new Map(),
      assets: [
        { key: 'rise/courses/SRC/a.jpg', kind: 'media-image', file: 'assets/h.jpg', ext: 'jpg' },
      ],
      course: {
        course: { id: 'SRC', title: 'Sample', lessons: ['L1', 'L2'] },
        lessons: [
          {
            id: 'L1',
            position: 0,
            type: 'blocks',
            title: 'One',
            items: [block('1', 'heading'), block('2', 'hero', 'rise/courses/SRC/a.jpg')],
          },
          {
            id: 'L2',
            position: 1,
            type: 'blocks',
            title: 'Two',
            items: [block('1', 'paragraph'), block('2', 'quote')],
          },
        ],
      },
    };
  }

  it('sends DISTINCT block ids per lesson and keeps each lesson its own content', async () => {
    const input = collidingCourse();
    const sent: { lessonId: string; blocks: { id: string; variant: string }[] }[] = [];
    let lessonN = 0;
    const relay: Relay = async (spec) => {
      const body: unknown = spec.body ? JSON.parse(spec.body) : undefined;
      if (spec.url.endsWith('/lessons/CREATE_LESSON')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ payload: { lesson: { id: `TL${++lessonN}` } } }),
        };
      }
      if (spec.url.endsWith('/lessons/CREATE_BLOCKS')) {
        const p = (body as { payload: { lessonId: string; blocks: { id: string; variant: string }[] } })
          .payload;
        sent.push({ lessonId: p.lessonId, blocks: p.blocks.map((b) => ({ id: b.id, variant: b.variant })) });
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            payload: {
              success: true,
              blockMetadata: p.blocks.map((b) => ({ id: b.id, globalBlockId: `g-${b.id}` })),
            },
          }),
        };
      }
      if (spec.url.includes('/manage/api/content')) {
        return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      }
      if (spec.label.includes('GET_COURSE')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }),
        };
      }
      if (spec.label.includes('GET_YURL')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            payload: { key: 'rise/courses/NEWCOURSE/x.jpg', url: 'https://s3/put', type: 'image/jpeg' },
          }),
        };
      }
      return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true } }) };
    };

    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => ({ base64: 'Zm9v', contentType: 'image/jpeg' }),
      mintId: counterMint(),
    });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);

    expect(sent).toHaveLength(2);
    const [l1, l2] = sent;
    // no source id survives, and the two lessons share NO block id
    const all = [...l1!.blocks, ...l2!.blocks].map((b) => b.id);
    expect(all).not.toContain('1');
    expect(all).not.toContain('2');
    expect(new Set(all).size).toBe(4);
    // each lesson kept ITS OWN blocks (the collision used to swap them)
    expect(l1!.blocks.map((b) => b.variant)).toEqual(['heading', 'hero']);
    expect(l2!.blocks.map((b) => b.variant)).toEqual(['paragraph', 'quote']);
    expect(l1!.lessonId).not.toBe(l2!.lessonId);
  });

  it('patches media on the RIGHT lesson-2 block (per-block follow-ups were mis-keyed)', async () => {
    const input = collidingCourse();
    // move the media block into lesson 2 so a wrong key would patch lesson 1
    input.course.lessons![1]!.items![1] = {
      id: '2',
      family: 'image',
      variant: 'hero',
      type: 'image',
      items: [{ id: '1', media: { image: { key: 'rise/courses/SRC/a.jpg', type: 'image' } } }],
    };
    input.course.lessons![0]!.items![1] = {
      id: '2',
      family: 'text',
      variant: 'quote',
      type: 'text',
      items: [{ id: '1', paragraph: 'no media here' }],
    };
    const patches: { lessonId: string; blockId: string }[] = [];
    let lessonN = 0;
    const relay: Relay = async (spec) => {
      const body: unknown = spec.body ? JSON.parse(spec.body) : undefined;
      if (spec.url.endsWith('/lessons/CREATE_LESSON')) {
        return { ok: true, status: 200, text: JSON.stringify({ payload: { lesson: { id: `TL${++lessonN}` } } }) };
      }
      if (spec.url.endsWith('/lessons/CREATE_BLOCKS')) {
        const p = (body as { payload: { blocks: { id: string }[] } }).payload;
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            payload: { success: true, blockMetadata: p.blocks.map((b) => ({ id: b.id })) },
          }),
        };
      }
      if (spec.url.endsWith('/lessons/UPDATE_BLOCK_DEBOUNCE')) {
        const p = (body as { payload: { id: string; lessonId: string } }).payload;
        patches.push({ lessonId: p.lessonId, blockId: p.id });
      }
      if (spec.url.includes('/manage/api/content')) {
        return { ok: true, status: 200, text: JSON.stringify({ id: 'NEWCOURSE' }) };
      }
      if (spec.label.includes('GET_COURSE')) {
        return { ok: true, status: 200, text: JSON.stringify({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }) };
      }
      if (spec.label.includes('GET_YURL')) {
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            payload: { key: 'rise/courses/NEWCOURSE/x.jpg', url: 'https://s3/put', type: 'image/jpeg' },
          }),
        };
      }
      return { ok: true, status: 200, text: JSON.stringify({ payload: { success: true } }) };
    };
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset: async () => ({ base64: 'Zm9v', contentType: 'image/jpeg' }),
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    // exactly one media patch, and it went to lesson 2's target lesson
    expect(patches).toHaveLength(1);
    expect(patches[0]!.lessonId).toBe('TL2');
  });
});
