// Multi-language stack import, IDEA-2 shape (docs/rise-multilang.md §6,
// v0.6.7): the full course is built in the DEFAULT language from the
// materialized doc, converted ONCE, then every TARGET-locale row is
// overwritten from the archive through the structural pairing map. Uses the
// fixture stack: 3 locales (en-us default, ru with a custom label set + media
// override, ar), 2 lessons, media in the translation tables + a
// block-embedded attachment.
import { describe, it, expect } from 'vitest';
import { buildPlan, type PlanStep } from './plan';
import { executePlan, blockKey } from './executor';
import {
  counterMint,
  mockRelay,
  l10nCourse,
  l10nHandlers,
  l10nStorylineAttach,
  tgtRef,
} from './executor.fixtures';

const readAsset = async () => ({ base64: 'Zm9v', contentType: 'application/octet-stream' });

function kinds(steps: PlanStep[]): string[] {
  return steps.map((s) => s.kind);
}

const TITLE_REF = 'aaaa1111-0000-4000-8000-000000000001';
const DESC_REF = 'aaaa1111-0000-4000-8000-000000000002';

type CellChange = {
  action?: string;
  l10nId?: string;
  locale?: string;
  lessonId?: string;
  valueType?: string;
  value?: unknown;
};

/** Every UPDATE_L10N_BATCH change across the recorded bodies. */
function cellChanges(bodies: { url: string; payload: Record<string, unknown> }[]): CellChange[] {
  return bodies
    .filter((b) => b.url.endsWith('/l10n/UPDATE_L10N_BATCH'))
    .flatMap((b) => (b.payload.payload as { changes: CellChange[] }).changes);
}

describe('buildPlan — stack sequence (idea 2)', () => {
  const input = l10nCourse();
  const steps = buildPlan(input);
  const ks = kinds(steps);

  it('orders: shell → FULL default-language build (lessons/blocks/title/description/images/theme) → convert → await → uploads → target cells → label sets → titles', () => {
    const idx = (k: string): number => ks.indexOf(k);
    const lastIdx = (k: string): number => ks.lastIndexOf(k);
    expect(idx('create-course')).toBeGreaterThanOrEqual(0);
    expect(idx('create-lesson')).toBeGreaterThan(idx('create-course'));
    // The CLEAN title lands right after the first lesson (no markers).
    expect(idx('set-title')).toBe(idx('create-lesson') + 1);
    // The WHOLE build precedes the conversion: content, description, images, theme.
    expect(lastIdx('create-blocks')).toBeLessThan(idx('convert-stack'));
    expect(lastIdx('update-lesson')).toBeLessThan(idx('convert-stack'));
    expect(idx('set-course-description')).toBeLessThan(idx('convert-stack'));
    expect(idx('set-course-images')).toBeLessThan(idx('convert-stack'));
    expect(idx('set-theme')).toBeLessThan(idx('convert-stack'));
    expect(idx('convert-stack')).toBeLessThan(idx('await-stack'));
    // Post-conversion: per-locale table media, target cells, label sets, titles.
    expect(idx('await-stack')).toBeLessThan(idx('upload-l10n-asset'));
    expect(idx('await-stack')).toBeLessThan(idx('write-l10n'));
    expect(idx('set-locale-labelset')).toBeGreaterThan(lastIdx('write-l10n'));
    expect(ks[ks.length - 1]).toBe('set-stack-titles');
    // No placeholder machinery survives.
    expect(ks).not.toContain('cleanup-l10n');
    expect(steps.some((s) => s.summary.includes('placeholder'))).toBe(false);
    expect(steps.some((s) => s.summary.includes('!importing'))).toBe(false);
    // Exactly one plain title write.
    expect(steps.filter((s) => s.kind === 'set-title')).toHaveLength(1);
  });

  it('converts per formality group with the source default language', () => {
    const converts = steps.filter((s) => s.kind === 'convert-stack');
    expect(converts).toEqual([
      expect.objectContaining({ sourceLanguage: 'en-us', targetLanguages: ['ar'], formality: 'more' }),
      expect.objectContaining({ sourceLanguage: 'en-us', targetLanguages: ['ru'], formality: 'less' }),
    ]);
    const await1 = steps.find((s) => s.kind === 'await-stack');
    expect(await1).toMatchObject({ expectedLocales: ['en-us', 'ar', 'ru'] });
  });

  it('creates EVERY lesson up front with its plain materialized title (no refs, no placeholder)', () => {
    const creates = steps.filter(
      (s): s is Extract<PlanStep, { kind: 'create-lesson' }> => s.kind === 'create-lesson',
    );
    expect(creates).toHaveLength(2);
    expect(creates[0]).toMatchObject({
      sourceLessonId: 'lessonA-0000000000000000000000',
      title: 'Lesson One',
      position: 0,
    });
    expect(creates[1]).toMatchObject({
      sourceLessonId: 'lessonB-0000000000000000000000',
      title: 'Lesson Two',
      position: 1,
    });
    // The description is the real materialized value, pre-conversion.
    const desc = steps.find(
      (s): s is Extract<PlanStep, { kind: 'set-course-description' }> =>
        s.kind === 'set-course-description',
    );
    expect(desc!.value).toContain('Course description EN');
  });

  it('default-locale media rides the BUILD; only per-locale overrides ride upload-l10n-asset', () => {
    const l10nUploads = steps.filter(
      (s): s is Extract<PlanStep, { kind: 'upload-l10n-asset' }> => s.kind === 'upload-l10n-asset',
    );
    const keys = l10nUploads.map((s) => s.sourceKey);
    // The ru per-locale hero override is table-only → upload-l10n-asset.
    expect(keys).toContain('rise/courses/stackCourse000000000000000000000/heroRU0000000000.jpg');
    // The DEFAULT hero rides the materialized block build (upload-asset)…
    expect(keys).not.toContain('rise/courses/stackCourse000000000000000000000/heroEN0000000000.jpg');
    const blockUploads = steps
      .filter((s): s is Extract<PlanStep, { kind: 'upload-asset' }> => s.kind === 'upload-asset')
      .map((s) => s.sourceKey);
    expect(blockUploads).toContain(
      'rise/courses/stackCourse000000000000000000000/heroEN0000000000.jpg',
    );
    // …the attachment too, and logo/cover ride set-course-images (handled).
    expect(blockUploads).toContain(
      'rise/courses/stackCourse000000000000000000000/attach0000000000.pdf',
    );
    expect(keys.some((k) => k.includes('logoEN'))).toBe(false);
  });

  it('plans TARGET-locale cells only — the default locale is never written post-conversion', () => {
    const writes = steps.filter(
      (s): s is Extract<PlanStep, { kind: 'write-l10n' }> => s.kind === 'write-l10n',
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w) => w.locale !== 'en-us')).toBe(true);
    const allIds = writes.flatMap((w) => w.l10nIds.map((id) => `${w.locale}:${id}`));
    // title/description reserved for set-stack-titles
    expect(allIds.some((x) => x.endsWith(TITLE_REF))).toBe(false);
    expect(allIds.some((x) => x.endsWith(DESC_REF))).toBe(false);
    // the ru-only cell and the ru rows of default cells ride the batches
    expect(allIds).toContain('ru:cccc3333-0000-4000-8000-000000000005');
    expect(allIds).toContain('ru:cccc3333-0000-4000-8000-000000000001');
  });

  it('recreates only the CUSTOM non-default label set (diff vs the language default)', () => {
    const sets = steps.filter(
      (s): s is Extract<PlanStep, { kind: 'set-locale-labelset' }> =>
        s.kind === 'set-locale-labelset',
    );
    expect(sets).toHaveLength(1); // ru custom; ar has none; en-us (default locale) is out of scope
    expect(sets[0]).toMatchObject({
      locale: 'ru',
      iso639Code: 'ru',
      name: 'Russian custom',
      sourceLabelSetId: 'customSetRu00000000000mm',
      labels: { courseStart: 'ПОЕХАЛИ' }, // lessonQuiz matches the default → not an override
    });
  });

  it('flags the learner language selector (source shows it; toggle not capture-proven)', () => {
    expect(ks).toContain('flag-locale-selector');
  });

  it('never copies a storyline cell verbatim — flags it per language when nothing is staged', () => {
    const flags = steps.filter(
      (s): s is Extract<PlanStep, { kind: 'flag-l10n-storyline' }> =>
        s.kind === 'flag-l10n-storyline',
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      l10nId: 'cccc3333-0000-4000-8000-000000000009',
      locales: ['en-us', 'ru'],
      title: 'Onboarding EN',
    });
    // the cell appears in NO write-l10n batch (source contentPrefix must not ship)
    const written = steps
      .filter((s): s is Extract<PlanStep, { kind: 'write-l10n' }> => s.kind === 'write-l10n')
      .flatMap((w) => w.l10nIds);
    expect(written).not.toContain('cccc3333-0000-4000-8000-000000000009');
  });
});

describe('executePlan — stack live run (idea 2, scripted relay)', () => {
  it('builds the full course, converts once, then overwrites TARGET rows through the pairing map', async () => {
    const input = l10nCourse();
    const steps = buildPlan(input);
    const { relay, calls } = mockRelay(l10nHandlers());
    const bodies: { url: string; payload: Record<string, unknown> }[] = [];
    const spyRelay: typeof relay = async (spec) => {
      if (spec.body) bodies.push({ url: spec.url, payload: JSON.parse(spec.body) as Record<string, unknown> });
      return relay(spec);
    };
    const labelSetCache = new Map<string, string>();
    const res = await executePlan(steps, {
      input,
      relay: spyRelay,
      readAsset,
      mintId: counterMint(),
      labelSetCache,
    });

    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.newCourseId).toBe('NEWCOURSE');
    expect(res.survivingKeys).toEqual([]);

    // The conversion fires only AFTER the whole default-language build.
    const urls = calls.map((c) => `${c.method} ${c.url}`);
    const firstConvert = urls.findIndex((u) =>
      u.startsWith('POST https://') ? false : u.includes('/translations') && u.startsWith('POST'),
    );
    const lastCreateBlocks = urls.map((u) => u.includes('CREATE_BLOCKS')).lastIndexOf(true);
    expect(firstConvert).toBeGreaterThan(lastCreateBlocks);

    // Blocks shipped MATERIALIZED: default-language values, no l10n refs, no
    // inline translationChanges.
    const createBlocks = bodies.filter((b) => b.url.endsWith('/lessons/CREATE_BLOCKS'));
    expect(createBlocks.length).toBe(2);
    for (const cb of createBlocks) {
      const p = cb.payload.payload as Record<string, unknown>;
      expect(p.translationChanges).toBeUndefined();
      expect(JSON.stringify(p.blocks)).not.toContain('l10nId');
    }
    expect(JSON.stringify(createBlocks[0]!.payload)).toContain('Heading EN');

    // The clean title was written ONCE, pre-conversion, with the description.
    const titleWrites = bodies
      .filter((b) => b.url.endsWith('/courses/UPDATE_COURSE_FIELD_THROTTLE'))
      .map((b) => (b.payload.payload as { course: Record<string, unknown> }).course);
    expect(titleWrites.filter((c) => typeof c.title === 'string').map((c) => c.title)).toEqual([
      'Fixture Stack Course',
    ]);
    expect(
      titleWrites.find((c) => typeof c.description === 'string')?.description,
    ).toContain('Course description EN');

    // Every post-conversion cell write is a bare `update` on a PAIRED target
    // ref, for a NON-default locale only.
    const changes = cellChanges(bodies);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.action === 'update')).toBe(true);
    expect(changes.every((c) => c.locale !== 'en-us')).toBe(true);
    expect(changes.every((c) => c.lessonId === undefined && c.valueType === undefined)).toBe(true);
    expect(changes.every((c) => c.l10nId!.startsWith('tgt-'))).toBe(true);

    // The ru per-locale hero override landed on the paired ref, key remapped.
    const ruOverride = changes.find(
      (c) => c.l10nId === tgtRef('cccc3333-0000-4000-8000-000000000004') && c.locale === 'ru',
    );
    expect(JSON.stringify(ruOverride?.value)).toContain('rise/courses/NEWCOURSE/');
    expect(JSON.stringify(ruOverride?.value)).not.toContain('stackCourse000000000000000000000');

    // Titles: ru gets its proofread row; ar (no source description row) gets
    // the DEFAULT value — fallback-resolved (D2), so the target displays what
    // the source displays.
    const titleCells = changes.filter((c) => c.l10nId === tgtRef(TITLE_REF));
    expect(titleCells.map((c) => c.locale).sort()).toEqual(['ar', 'ru']);
    expect(titleCells.find((c) => c.locale === 'ru')?.value).toBe('Курс-стек (фикстура)');
    const descCells = changes.filter((c) => c.l10nId === tgtRef(DESC_REF));
    expect(descCells.map((c) => c.locale).sort()).toEqual(['ar', 'ru']);
    expect(descCells.find((c) => c.locale === 'ar')?.value).toContain('Course description EN');
    expect(descCells.find((c) => c.locale === 'ru')?.value).toContain('Описание курса RU');

    // The pairing map is exported for the read-back.
    expect(res.l10nRefMap?.['cccc3333-0000-4000-8000-000000000005']).toBe(
      tgtRef('cccc3333-0000-4000-8000-000000000005'),
    );

    // Label set recreated once + bound to ru, cached for the run.
    const labelCalls = urls.filter((u) => u.includes('CREATE_LABEL_SET'));
    expect(labelCalls).toHaveLength(1);
    expect(labelSetCache.get('customSetRu00000000000mm')).toBe('NEWLABELSET1');
    const bind = bodies.find((b) => b.url.endsWith('/l10n/UPDATE_LOCALE'));
    expect((bind?.payload.payload as Record<string, unknown>).labelSetId).toBe('NEWLABELSET1');

    // Flags: language selector + the un-staged storyline cell (per language).
    expect(res.flags.some((f) => f.kind === 'locale-selector')).toBe(true);
    const slFlag = res.flags.find((f) => f.kind === 'l10n-storyline');
    expect(slFlag?.detail).toMatch(/en-us, ru/);
    // No source storyline contentPrefix ever rode a CELL write.
    expect(JSON.stringify(changes)).not.toContain('slEN000000000000');
    expect(JSON.stringify(changes)).not.toContain('slRU000000000000');
  });

  it('regression (F1 class): an INVERTED lessons[] array cannot cross lesson titles (pairing is id-mapped)', async () => {
    const input = l10nCourse();
    input.course.lessons = [...(input.course.lessons ?? [])].reverse();
    expect((input.course.lessons![0] as { id?: string }).id).toBe(
      'lessonB-0000000000000000000000',
    ); // raw order starts with lesson B — the old trap
    const bodies: { url: string; payload: Record<string, unknown> }[] = [];
    const { relay } = mockRelay(l10nHandlers());
    const spyRelay: typeof relay = async (spec) => {
      if (spec.body) bodies.push({ url: spec.url, payload: JSON.parse(spec.body) as Record<string, unknown> });
      return relay(spec);
    };
    const res = await executePlan(buildPlan(input), {
      input,
      relay: spyRelay,
      readAsset,
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    // Lessons were CREATED in authoritative order (A first) with their own titles…
    const created = bodies
      .filter((b) => b.url.endsWith('/lessons/CREATE_LESSON'))
      .map((b) => (b.payload.payload as { title: string }).title);
    expect(created).toEqual(['Lesson One', 'Lesson Two']);
    // …and the ru title cells landed on the RIGHT paired refs (no crossing).
    const changes = cellChanges(bodies);
    expect(
      changes.find(
        (c) => c.l10nId === tgtRef('bbbb2222-0000-4000-8000-000000000001') && c.locale === 'ru',
      )?.value,
    ).toBe('Урок один');
    expect(
      changes.find(
        (c) => c.l10nId === tgtRef('bbbb2222-0000-4000-8000-000000000002') && c.locale === 'ru',
      )?.value,
    ).toBe('Урок два');
  });

  it('blanks an orphaned TABLE-media key inside the cell value (flagged, no survivor)', async () => {
    const input = l10nCourse();
    // The ru per-locale hero override: 403/deleted at source → no bytes.
    const orphanKey = 'rise/courses/stackCourse000000000000000000000/heroRU0000000000.jpg';
    input.assets = input.assets.map((a) =>
      a.key === orphanKey ? { key: a.key, kind: a.kind, orphaned: true } : a,
    );
    const bodies: { url: string; payload: Record<string, unknown> }[] = [];
    const { relay } = mockRelay(l10nHandlers());
    const spyRelay: typeof relay = async (spec) => {
      if (spec.body) bodies.push({ url: spec.url, payload: JSON.parse(spec.body) as Record<string, unknown> });
      return relay(spec);
    };
    const res = await executePlan(buildPlan(input), {
      input,
      relay: spyRelay,
      readAsset,
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    expect(res.survivingKeys).toEqual([]); // the unfiltered final scan stays clean
    expect(res.flags.some((f) => f.kind === 'orphan-media' && f.sourceKey === orphanKey)).toBe(
      true,
    );
    // The ru cell was still written — with the dead key BLANKED inside the value.
    const cellValues = cellChanges(bodies).map((c) => JSON.stringify(c.value ?? ''));
    expect(cellValues.some((v) => v.includes(orphanKey))).toBe(false);
  });

  it('aborts loudly when the post-conversion GET_COURSE is not l10n-ified', async () => {
    const input = l10nCourse();
    const handlers = l10nHandlers();
    // Every GET_COURSE returns a PLAIN shell — the conversion "completed" per
    // the poll, but the course never actually l10n-ified.
    handlers['GET_COURSE'] = () => ({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } });
    const { relay } = mockRelay(handlers);
    const res = await executePlan(buildPlan(input), {
      input,
      relay,
      readAsset,
      mintId: counterMint(),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not l10n-ified/);
  });

  it('flags an unmatched ref (l10n-ref) and ships no orphan cells for it', async () => {
    const input = l10nCourse();
    const handlers = l10nHandlers();
    // Converted target WITHOUT a description ref: the target's Rise did not
    // localize that field — flagged, and its cells never written (a source id
    // must never ship, and there is no target ref to address).
    const inner = handlers['GET_COURSE']!;
    handlers['GET_COURSE'] = (body) => {
      const out = inner(body) as { payload: Record<string, unknown> };
      const course = out.payload.course as Record<string, unknown> | undefined;
      if (course && 'description' in course) course.description = '';
      return out;
    };
    const bodies: { url: string; payload: Record<string, unknown> }[] = [];
    const { relay } = mockRelay(handlers);
    const spyRelay: typeof relay = async (spec) => {
      if (spec.body) bodies.push({ url: spec.url, payload: JSON.parse(spec.body) as Record<string, unknown> });
      return relay(spec);
    };
    const res = await executePlan(buildPlan(input), {
      input,
      relay: spyRelay,
      readAsset,
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    const flag = res.flags.find((f) => f.kind === 'l10n-ref');
    expect(flag?.detail).toContain('course.description');
    // No cell write carries the source id OR any unmapped description cell.
    const changes = cellChanges(bodies);
    expect(changes.some((c) => c.l10nId === DESC_REF)).toBe(false);
    expect(changes.some((c) => c.l10nId === tgtRef(DESC_REF))).toBe(false);
  });

  it('fails loudly when the conversion never completes (poll timeout)', async () => {
    const input = l10nCourse();
    const steps = buildPlan(input);
    const handlers = l10nHandlers();
    handlers['GET /manage/api/content/NEWCOURSE/translations'] = () => ({
      stackItems: [
        { id: 'tgt-row-en', locale: 'en-us', status: 'complete', deletedAt: null },
        { id: 'tgt-row-ru', locale: 'ru', status: 'translating', deletedAt: null },
        { id: 'tgt-row-ar', locale: 'ar', status: 'queued', deletedAt: null },
      ],
    });
    const { relay } = mockRelay(handlers);
    const res = await executePlan(steps, {
      input,
      relay,
      readAsset,
      mintId: counterMint(),
      stackAwaitTries: 3,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/did not complete within 3 polls/);
    // the course exists + is confirmed → kept (resumable-from-scratch policy)
    expect(res.newCourseId).toBe('NEWCOURSE');
    expect(res.orphanedCourseId).toBeUndefined();
  });

  it('dry-run walks the whole stack plan without any relay traffic', async () => {
    const input = l10nCourse();
    const steps = buildPlan(input);
    let called = 0;
    const res = await executePlan(steps, {
      input,
      relay: async () => {
        called++;
        return { ok: true, status: 200, text: '{}' };
      },
      readAsset,
      mintId: counterMint(),
      dryRun: true,
    });
    expect(called).toBe(0);
    expect(res.ok).toBe(true);
    expect(res.envelopes.some((e) => e.step === 'convert-stack')).toBe(true);
    expect(res.envelopes.some((e) => e.step === 'await-stack')).toBe(true);
    expect(res.envelopes.some((e) => e.step === 'write-l10n')).toBe(true);
    expect(res.envelopes.some((e) => e.step === 'set-stack-titles')).toBe(true);
  });
});

describe('per-language Storyline attach (idea 2, docs/rise-multilang.md §4.3b)', () => {
  function stackWithPackages() {
    const input = l10nCourse();
    input.storylineAttachL10n = l10nStorylineAttach();
    return input;
  }

  it('plans the DEFAULT package as a pre-conversion block attach and the others as post-await cell attaches', () => {
    const steps = buildPlan(stackWithPackages());
    const ks = kinds(steps);
    // en-us (default) → mono-style attach-storyline DURING the build.
    const monoAttach = steps.filter((s) => s.kind === 'attach-storyline');
    expect(monoAttach).toHaveLength(1);
    expect(ks.indexOf('attach-storyline')).toBeLessThan(ks.indexOf('convert-stack'));
    // ru → attach-storyline-l10n AFTER await-stack.
    const attaches = steps.filter(
      (s): s is Extract<PlanStep, { kind: 'attach-storyline-l10n' }> =>
        s.kind === 'attach-storyline-l10n',
    );
    expect(attaches.map((a) => a.locale)).toEqual(['ru']);
    expect(ks.indexOf('attach-storyline-l10n')).toBeGreaterThan(ks.indexOf('await-stack'));
    expect(attaches[0]).toMatchObject({
      sourceBlockId: 'cblockSL00000000000000000',
      l10nId: 'cccc3333-0000-4000-8000-000000000009',
      reviewPrefix: 'review/items/slRU000000000000',
      title: 'Onboarding RU',
    });
    // nothing left to flag: every language has a staged package
    expect(ks).not.toContain('flag-l10n-storyline');
    expect(ks).not.toContain('flag-storyline');
  });

  it('flags only the languages with no staged package', () => {
    const input = stackWithPackages();
    input.storylineAttachL10n!.delete(
      `${blockKey('lessonB-0000000000000000000000', 'cblockSL00000000000000000')}|ru`,
    );
    const steps = buildPlan(input);
    expect(steps.filter((s) => s.kind === 'attach-storyline')).toHaveLength(1); // en-us
    expect(steps.filter((s) => s.kind === 'attach-storyline-l10n')).toHaveLength(0);
    const flags = steps.filter(
      (s): s is Extract<PlanStep, { kind: 'flag-l10n-storyline' }> =>
        s.kind === 'flag-l10n-storyline',
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.locales).toEqual(['ru']); // en-us was attached → not flagged
  });

  it('executes: default patched onto the block pre-conversion; ru = copy + bare cell UPDATE on the paired ref', async () => {
    const input = stackWithPackages();
    const steps = buildPlan(input);
    const { relay } = mockRelay(l10nHandlers());
    const bodies: { url: string; payload: Record<string, unknown> }[] = [];
    const spy: typeof relay = async (spec) => {
      if (spec.body) bodies.push({ url: spec.url, payload: JSON.parse(spec.body) as Record<string, unknown> });
      return relay(spec);
    };
    const res = await executePlan(steps, {
      input,
      relay: spy,
      readAsset,
      mintId: counterMint(),
    });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.storylineAttached).toBe(2);

    // one copy_review_item per language, each with the TARGET block id
    const copies = bodies.filter((b) => b.url.includes('copy_review_item'));
    expect(copies).toHaveLength(2);
    expect(copies.map((c) => c.payload.reviewPrefix)).toEqual([
      'review/items/slEN000000000000',
      'review/items/slRU000000000000',
    ]);
    expect(copies[0]!.payload.id).toBe('NEWCOURSE');
    expect(typeof copies[0]!.payload.jobId).toBe('string');

    // The DEFAULT language attached via a BLOCK PATCH (pre-conversion) with the
    // TARGET prefix — never a cell write for the default locale.
    const patches = bodies
      .filter((b) => b.url.endsWith('/lessons/UPDATE_BLOCK_DEBOUNCE'))
      .map((b) => JSON.stringify(b.payload));
    expect(patches.some((p) => p.includes('rise/courses/NEWCOURSE/slEN000000000000'))).toBe(true);

    // ru attached via the CELL: a bare `update` on the PAIRED target ref (the
    // cell exists post-conversion — the capture-proven 2nd-language shape).
    const slCells = cellChanges(bodies).filter(
      (c) => !!(c.value as { storyline?: unknown } | undefined)?.storyline,
    );
    expect(slCells).toHaveLength(1);
    expect(slCells[0]).toMatchObject({
      action: 'update',
      locale: 'ru',
      l10nId: tgtRef('cccc3333-0000-4000-8000-000000000009'),
    });
    expect(slCells[0]!.lessonId).toBeUndefined();
    expect(slCells[0]!.valueType).toBeUndefined();
    const sl = (slCells[0]!.value as { storyline: { contentPrefix: string; src: string } })
      .storyline;
    expect(sl.contentPrefix).toBe('rise/courses/NEWCOURSE/slRU000000000000');
    expect(sl.src).toBe(`${sl.contentPrefix}/story.html`);

    // No SOURCE contentPrefix survives in any FINAL payload the target keeps:
    // the block was patched to the target prefix and the ru cell is target-
    // prefixed. (The initial copy-faithful CREATE ships the materialized source
    // object transiently — same as the monolingual placeholder policy — so the
    // assertion checks patches + cells, the state that persists.)
    expect(patches.join(' ')).not.toContain('stackCourse000000000000000000000/slEN');
    expect(JSON.stringify(cellChanges(bodies))).not.toContain('stackCourse000000000000000000000');
  });

  it('flags (never writes) a per-language attach when the conversion did not l10n-ify the storyline slot (R3)', async () => {
    const input = stackWithPackages();
    const steps = buildPlan(input);
    const handlers = l10nHandlers();
    // Simulate R3: the converted doc keeps the storyline block's media as a
    // PLAIN object (no ref minted for it).
    const inner = handlers['GET_COURSE']!;
    handlers['GET_COURSE'] = (body) => {
      const out = inner(body) as { payload: { lessons?: { items?: Record<string, unknown>[] }[] } };
      for (const l of out.payload.lessons ?? []) {
        for (const b of l.items ?? []) {
          if ((b as { variant?: string }).variant === 'storyline') {
            const items = (b as { items?: { media?: unknown }[] }).items ?? [];
            if (items[0]) items[0].media = { storyline: { contentPrefix: 'x', type: 'storyline' } };
          }
        }
      }
      return out;
    };
    const { relay } = mockRelay(handlers);
    const bodies: { url: string; payload: Record<string, unknown> }[] = [];
    const spy: typeof relay = async (spec) => {
      if (spec.body) bodies.push({ url: spec.url, payload: JSON.parse(spec.body) as Record<string, unknown> });
      return relay(spec);
    };
    const res = await executePlan(steps, {
      input,
      relay: spy,
      readAsset,
      mintId: counterMint(),
    });
    expect(res.ok).toBe(true);
    // Default attach still happened (block patch), ru did NOT (flagged).
    expect(res.storylineAttached).toBe(1);
    const flag = res.flags.find(
      (f) => f.kind === 'l10n-storyline' && f.detail.includes('per-language'),
    );
    expect(flag).toBeTruthy();
    expect(flag!.detail).toContain('ru');
    // No storyline cell write fired.
    const slCells = cellChanges(bodies).filter(
      (c) => !!(c.value as { storyline?: unknown } | undefined)?.storyline,
    );
    expect(slCells).toHaveLength(0);
  });
});
