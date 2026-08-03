// Multi-language stack import — plan sequence + executor behavior against the
// scripted relay (docs/rise-multilang.md). Uses the fixture stack: 3 locales
// (en-us default, ru with a custom label set + media override, ar), 2 lessons,
// media in the translation tables + a block-embedded attachment.
import { describe, it, expect } from 'vitest';
import { buildPlan, type PlanStep } from './plan';
import { executePlan, blockKey } from './executor';
import {
  counterMint,
  mockRelay,
  l10nCourse,
  l10nHandlers,
  l10nStorylineAttach,
} from './executor.fixtures';

const readAsset = async () => ({ base64: 'Zm9v', contentType: 'application/octet-stream' });

function kinds(steps: PlanStep[]): string[] {
  return steps.map((s) => s.kind);
}

describe('buildPlan — stack sequence', () => {
  const input = l10nCourse();
  const steps = buildPlan(input);
  const ks = kinds(steps);

  it('orders: shell → placeholder lesson → provisional title/description/images → convert → await → uploads → content → cells → label sets → cleanup → titles', () => {
    const idx = (k: string): number => ks.indexOf(k);
    expect(idx('create-course')).toBeGreaterThanOrEqual(0);
    expect(idx('create-lesson')).toBeGreaterThan(idx('create-course'));
    expect(idx('set-title')).toBeGreaterThan(idx('create-lesson'));
    expect(idx('set-course-description')).toBeGreaterThan(idx('set-title'));
    expect(idx('set-course-images')).toBeLessThan(idx('convert-stack'));
    expect(idx('convert-stack')).toBeLessThan(idx('await-stack'));
    expect(idx('await-stack')).toBeLessThan(idx('upload-l10n-asset'));
    expect(idx('await-stack')).toBeLessThan(idx('update-lesson'));
    expect(idx('write-l10n')).toBeGreaterThan(ks.lastIndexOf('create-blocks'));
    expect(idx('set-locale-labelset')).toBeGreaterThan(ks.lastIndexOf('write-l10n'));
    expect(idx('cleanup-l10n')).toBeGreaterThan(idx('set-locale-labelset'));
    // set-stack-titles is the very LAST step (partial-title invariant).
    expect(ks[ks.length - 1]).toBe('set-stack-titles');
    // the monolingual final set-title never fires on a stack
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

  it('reuses the placeholder as lesson 1 (one create per OTHER lesson, with the source title ref)', () => {
    const creates = steps.filter((s) => s.kind === 'create-lesson');
    expect(creates).toHaveLength(2); // placeholder (lesson A) + lesson B
    expect(creates[0]).toMatchObject({
      sourceLessonId: 'lessonA-0000000000000000000000',
      title: 'Lesson One',
    });
    expect(creates[0]).not.toHaveProperty('l10nTitleRef');
    expect(creates[1]).toMatchObject({
      sourceLessonId: 'lessonB-0000000000000000000000',
      l10nTitleRef: 'bbbb2222-0000-4000-8000-000000000002',
    });
  });

  it('uploads table media (incl. the per-locale override) and keeps block media in the block loop', () => {
    const l10nUploads = steps.filter((s) => s.kind === 'upload-l10n-asset');
    const keys = l10nUploads.map((s) => (s as { sourceKey: string }).sourceKey);
    expect(keys).toContain('rise/courses/stackCourse000000000000000000000/heroEN0000000000.jpg');
    expect(keys).toContain('rise/courses/stackCourse000000000000000000000/heroRU0000000000.jpg');
    // logo/cover keys ride set-course-images (handled), not table uploads
    expect(keys.some((k) => k.includes('logoEN'))).toBe(false);
    // the attachment is block-embedded → normal upload-asset
    const blockUploads = steps.filter((s) => s.kind === 'upload-asset');
    expect(blockUploads.map((s) => (s as { sourceKey: string }).sourceKey)).toContain(
      'rise/courses/stackCourse000000000000000000000/attach0000000000.pdf',
    );
  });

  it('batches cells default-locale-first, one locale per batch, skipping inline + title/description cells', () => {
    const writes = steps.filter(
      (s): s is Extract<PlanStep, { kind: 'write-l10n' }> => s.kind === 'write-l10n',
    );
    expect(writes.length).toBeGreaterThan(0);
    const seq = writes.map((w) => w.locale);
    const firstNonDefault = seq.findIndex((l) => l !== 'en-us');
    expect(seq.slice(0, firstNonDefault).every((l) => l === 'en-us')).toBe(true);
    const allIds = writes.flatMap((w) => w.l10nIds.map((id) => `${w.locale}:${id}`));
    // title/description reserved for set-stack-titles
    expect(allIds.some((x) => x.endsWith('aaaa1111-0000-4000-8000-000000000001'))).toBe(false);
    expect(allIds.some((x) => x.endsWith('aaaa1111-0000-4000-8000-000000000002'))).toBe(false);
    // inline-shipped default cells (block heading EN) are skipped…
    expect(allIds).not.toContain('en-us:cccc3333-0000-4000-8000-000000000001');
    // …but their other-locale rows ride the batches
    expect(allIds).toContain('ru:cccc3333-0000-4000-8000-000000000001');
    // the ru-only cell is written for ru
    expect(allIds).toContain('ru:cccc3333-0000-4000-8000-000000000005');
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

  it('never copies a storyline cell verbatim — flags it per language instead', () => {
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
    // …and the block is never attached via UPDATE_BLOCK_DEBOUNCE (that would
    // clobber the {l10nId} ref and every other language's binding)
    expect(ks).not.toContain('attach-storyline');
    // the per-cell flag replaces the block-level one when the cell HAS packages
    expect(ks).not.toContain('flag-storyline');
  });
});

describe('executePlan — stack live run (scripted relay)', () => {
  it('runs the full sequence, keeps source l10nIds, remaps media in cells, cleans junk, titles last', async () => {
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

    // conversion happened before any content lesson beyond the placeholder
    const urls = calls.map((c) => `${c.method} ${c.url}`);
    const firstConvert = urls.findIndex((u) => u.startsWith('POST /manage/api/content/NEWCOURSE/translations'));
    expect(firstConvert).toBeGreaterThan(-1);

    // CREATE_BLOCKS carried inline default-locale translationChanges with the
    // TARGET lesson id + remapped media keys, refs kept verbatim
    const createBlocks = bodies.filter((b) => b.url.endsWith('/lessons/CREATE_BLOCKS'));
    expect(createBlocks.length).toBe(2);
    const cb1 = createBlocks[0]!.payload.payload as Record<string, unknown>;
    const changes1 = cb1.translationChanges as Record<string, unknown>[];
    expect(changes1.length).toBeGreaterThan(0);
    expect(changes1.every((c) => c.action === 'add' && c.locale === 'en-us')).toBe(true);
    expect(changes1.every((c) => c.lessonId === 'NEWLESSON1')).toBe(true);
    const mediaChange = changes1.find(
      (c) => c.l10nId === 'cccc3333-0000-4000-8000-000000000004',
    );
    expect(mediaChange?.valueType).toBe('mediaRecord');
    expect(JSON.stringify(mediaChange?.value)).toContain(
      'rise/courses/NEWCOURSE/new-heroEN0000000000.jpg',
    );
    expect(JSON.stringify(mediaChange?.value)).not.toContain('rise/courses/stackCourse');
    // blocks keep the SOURCE refs verbatim
    expect(JSON.stringify(cb1.blocks)).toContain('cccc3333-0000-4000-8000-000000000001');

    // CREATE_LESSON for lesson B carried the source title ref + inline change
    const createLessons = bodies.filter((b) => b.url.endsWith('/lessons/CREATE_LESSON'));
    expect(createLessons).toHaveLength(2);
    const l2 = createLessons[1]!.payload.payload as Record<string, unknown>;
    expect(l2.title).toEqual({ l10nId: 'bbbb2222-0000-4000-8000-000000000002' });
    expect((l2.translationChanges as unknown[]).length).toBe(1);

    // batch writes: single locale per envelope; ru override remapped; course
    // title cells NOT in the generic batches
    const batches = bodies
      .filter((b) => b.url.endsWith('/l10n/UPDATE_L10N_BATCH'))
      .map((b) => (b.payload.payload as { changes: Record<string, unknown>[] }).changes);
    for (const ch of batches) {
      const locales = new Set(ch.map((c) => c.locale).filter(Boolean));
      expect(locales.size).toBeLessThanOrEqual(1);
    }
    const flat = batches.flat();
    const ruOverride = flat.find(
      (c) => c.l10nId === 'cccc3333-0000-4000-8000-000000000004' && c.locale === 'ru',
    );
    expect(JSON.stringify(ruOverride?.value)).toContain('rise/courses/NEWCOURSE/');

    // cleanup deleted the junk placeholder cell (and ONLY it)
    const deletes = flat.filter((c) => c.action === 'delete');
    expect(deletes.map((c) => c.l10nId)).toEqual(['junk-1']);

    // final titles: mapped to the TARGET refs, default locale first, all locales
    const titleWrites = flat.filter((c) => c.l10nId === 'tgt-title');
    expect(titleWrites[0]!.locale).toBe('en-us'); // default FIRST (pending rule)
    expect(titleWrites.map((c) => c.locale).sort()).toEqual(['ar', 'en-us', 'ru']);
    expect(titleWrites[0]!.value).toBe('Fixture Stack Course');
    // ar has no source description cell (falls back) → only en-us + ru written
    const descWrites = flat.filter((c) => c.l10nId === 'tgt-desc');
    expect(descWrites.map((c) => c.locale).sort()).toEqual(['en-us', 'ru']);
    // lesson-1 title cells ride the batches via the placeholder's target ref
    const l1Title = flat.filter((c) => c.l10nId === 'tgt-l1title');
    expect(l1Title.length).toBeGreaterThanOrEqual(3);

    // label set recreated once + bound to ru, cached for the run
    const labelCalls = urls.filter((u) => u.includes('CREATE_LABEL_SET'));
    expect(labelCalls).toHaveLength(1);
    expect(labelSetCache.get('customSetRu00000000000mm')).toBe('NEWLABELSET1');
    const bind = bodies.find((b) => b.url.endsWith('/l10n/UPDATE_LOCALE'));
    expect((bind?.payload.payload as Record<string, unknown>).labelSetId).toBe('NEWLABELSET1');

    // the language-selector flag surfaced
    expect(res.flags.some((f) => f.kind === 'locale-selector')).toBe(true);
    // storyline in a stack: flagged, and its source contentPrefix never shipped
    const slFlag = res.flags.find((f) => f.kind === 'l10n-storyline');
    expect(slFlag?.detail).toMatch(/en-us, ru/);
    const allWritten = JSON.stringify(bodies);
    expect(allWritten).not.toContain('slEN000000000000');
    expect(allWritten).not.toContain('slRU000000000000');
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

describe('per-language Storyline attach (docs/rise-multilang.md §4.3b)', () => {
  function stackWithPackages() {
    const input = l10nCourse();
    input.storylineAttachL10n = l10nStorylineAttach();
    return input;
  }

  it('plans one attach per language and drops the manual flag', () => {
    const steps = buildPlan(stackWithPackages());
    const attaches = steps.filter(
      (s): s is Extract<PlanStep, { kind: 'attach-storyline-l10n' }> =>
        s.kind === 'attach-storyline-l10n',
    );
    expect(attaches.map((a) => a.locale)).toEqual(['en-us', 'ru']);
    expect(attaches[0]).toMatchObject({
      sourceBlockId: 'cblockSL00000000000000000',
      l10nId: 'cccc3333-0000-4000-8000-000000000009',
      reviewPrefix: 'review/items/slEN000000000000',
      title: 'Onboarding EN',
    });
    // nothing left to flag: every language has a staged package
    expect(kinds(steps)).not.toContain('flag-l10n-storyline');
    // and the block is still never patched
    expect(kinds(steps)).not.toContain('attach-storyline');
  });

  it('flags only the languages with no staged package', () => {
    const input = stackWithPackages();
    input.storylineAttachL10n!.delete(
      `${blockKey('lessonB-0000000000000000000000', 'cblockSL00000000000000000')}|ru`,
    );
    const steps = buildPlan(input);
    expect(
      steps.filter((s) => s.kind === 'attach-storyline-l10n').map((s) => (s as { locale: string }).locale),
    ).toEqual(['en-us']);
    const flags = steps.filter(
      (s): s is Extract<PlanStep, { kind: 'flag-l10n-storyline' }> =>
        s.kind === 'flag-l10n-storyline',
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.locales).toEqual(['ru']); // en-us was attached → not flagged
  });

  it('executes copy_review_item + a storyline CELL write per language (never a block patch)', async () => {
    const input = stackWithPackages();
    const steps = buildPlan(input);
    const { relay, calls } = mockRelay(l10nHandlers());
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

    // the storyline CELLS point at the TARGET course prefix, per language.
    // Captured two-language sequence (capture2aug, byte-verified): the FIRST
    // language is an `add` with lessonId + valueType:"storyline"; the second
    // is an `update` with ONLY {l10nId, locale, value}.
    const cellWrites = bodies
      .filter((b) => b.url.endsWith('/l10n/UPDATE_L10N_BATCH'))
      .flatMap((b) => (b.payload.payload as { changes: Record<string, unknown>[] }).changes)
      .filter((c) => !!(c.value as { storyline?: unknown } | undefined)?.storyline);
    expect(cellWrites).toHaveLength(2);
    expect(cellWrites.map((c) => c.locale)).toEqual(['en-us', 'ru']);
    const [first, second] = cellWrites as [Record<string, unknown>, Record<string, unknown>];
    expect(first.action).toBe('add');
    expect(first.valueType).toBe('storyline');
    expect(first.lessonId).toBeTruthy(); // lesson-scoped add
    expect(second.action).toBe('update');
    expect(second.valueType).toBeUndefined();
    expect(second.lessonId).toBeUndefined();
    for (const c of cellWrites) {
      expect(c.l10nId).toBe('cccc3333-0000-4000-8000-000000000009');
      const sl = (c.value as { storyline: { contentPrefix: string; src: string } }).storyline;
      expect(sl.contentPrefix).toMatch(/^rise\/courses\/NEWCOURSE\//);
      expect(sl.src).toBe(`${sl.contentPrefix}/story.html`);
    }
    // per-language prefixes stay distinct (EN ≠ RU bundle)
    const prefixes = cellWrites.map(
      (c) => (c.value as { storyline: { contentPrefix: string } }).storyline.contentPrefix,
    );
    expect(new Set(prefixes).size).toBe(2);

    // no block patch ever carries a storyline media object: the block keeps its
    // {l10nId} ref (patching it would clobber every language's binding)
    const blockPatches = bodies.filter((b) => b.url.endsWith('/lessons/UPDATE_BLOCK_DEBOUNCE'));
    for (const p of blockPatches) {
      expect(JSON.stringify(p.payload)).not.toContain('"storyline"');
    }
    // …and the created storyline block carried the ref verbatim
    const created = bodies
      .filter((b) => b.url.endsWith('/lessons/CREATE_BLOCKS'))
      .map((b) => JSON.stringify((b.payload.payload as { blocks: unknown }).blocks))
      .join(' ');
    expect(created).toContain('"media":{"l10nId":"cccc3333-0000-4000-8000-000000000009"}');
    // …and no source contentPrefix ever shipped
    const all = JSON.stringify(bodies);
    expect(all).not.toContain('rise/courses/stackCourse000000000000000000000/slEN');
    expect(all).not.toContain('rise/courses/stackCourse000000000000000000000/slRU');
  });
});
