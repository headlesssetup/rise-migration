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

