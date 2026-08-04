// Shared fixtures for the executePlan test suites (split out of the old monolithic
// executor.test.ts). NOT a `.test.ts` file, so vitest does not collect it — it just
// supplies the deterministic id minter, the scripted relay, and a canonical
// image-course input + happy-path handler map used across the split test files.
import type { Relay, RelayResponse } from './executor';
import { blockKey } from './executor-types';
import type { PlanInput } from './plan';

// A deterministic id minter for stable assertions.
export function counterMint(): () => string {
  let n = 0;
  return () => `cnew${String(n++).padStart(20, '0')}`;
}

// A scripted relay: maps a ducks action / path to a canned JSON response.
export function mockRelay(handlers: Record<string, (body: unknown) => unknown>): {
  relay: Relay;
  calls: { url: string; method: string }[];
} {
  const calls: { url: string; method: string }[] = [];
  const relay: Relay = async (spec) => {
    calls.push({ url: spec.url, method: spec.method });
    // key by the ducks action suffix or the REST path
    const key = spec.label;
    const body = spec.body ? JSON.parse(spec.body) : undefined;
    for (const [match, fn] of Object.entries(handlers)) {
      if (key.includes(match) || spec.url.includes(match)) {
        const data = fn(body);
        return { ok: true, status: 200, text: JSON.stringify(data) } as RelayResponse;
      }
    }
    return { ok: true, status: 200, text: '{}' } as RelayResponse;
  };
  return { relay, calls };
}

export function imageCourse(): PlanInput {
  return {
    author: 'auth0|target',
    targetFolderId: 'all',
    assets: [
      { key: 'rise/courses/SRC/a.jpg', kind: 'media-image', file: 'assets/h.jpg', ext: 'jpg' },
    ],
    banksById: new Map(),
    course: {
      course: { id: 'SRC', title: 'My Course', theme: { themeId: 'classic' } },
      lessons: [
        {
          id: 'L1',
          position: 0,
          type: 'blocks',
          title: 'Lesson 1',
          icon: 'Article',
          items: [
            {
              id: 'cblock00000000000000000000',
              family: 'image',
              variant: 'hero',
              type: 'image',
              items: [
                {
                  id: 'citem000000000000000000000',
                  media: { image: { key: 'rise/courses/SRC/a.jpg', type: 'image' } },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

export const happyHandlers = {
  '/manage/api/content': () => ({ id: 'NEWCOURSE' }),
  // Post-create materialization handshake — return a real course.
  'GET_COURSE': () => ({ payload: { course: { id: 'NEWCOURSE', lessons: [] } } }),
  'CREATE_LESSON': () => ({ payload: { lesson: { id: 'NEWLESSON', createdAt: 't' } } }),
  'CREATE_BLOCKS': (body: unknown) => {
    const blocks = ((body as { payload: { blocks: { id: string }[] } }).payload).blocks;
    return { payload: { success: true, blockMetadata: [{ id: blocks[0]!.id, globalBlockId: 'g1' }] } };
  },
  'GET_YURL': () => ({
    payload: { key: 'rise/courses/NEWCOURSE/server.jpg', url: 'https://s3/put', type: 'image/jpeg' },
  }),
  'UPDATE_COURSE': () => ({ payload: {} }),
  'UPDATE_BLOCK_DEBOUNCE': () => ({ payload: { success: true } }),
};

// --- Multi-language stack fixture (docs/rise-multilang.md) -------------------

import l10nSample from '../../tests/fixtures/get-course.l10n.sample.json';
import type { GetCourseDocument } from '@/shared/types/rise';

const STACK_SRC = 'stackCourse000000000000000000000';

/** PlanInput for the fixture stack (3 locales, 2 lessons, media in tables +
 *  a block-embedded attachment + a per-locale media override). */
export function l10nCourse(): PlanInput {
  const course = JSON.parse(JSON.stringify(l10nSample)) as GetCourseDocument;
  const key = (leaf: string): string => `rise/courses/${STACK_SRC}/${leaf}`;
  return {
    author: 'auth0|target',
    targetFolderId: 'all',
    banksById: new Map(),
    course,
    assets: [
      { key: key('attach0000000000.pdf'), kind: 'media-other', file: 'assets/a.pdf', ext: 'pdf' },
      { key: key('heroEN0000000000.jpg'), kind: 'media-image', file: 'assets/b.jpg', ext: 'jpg' },
      { key: key('heroRU0000000000.jpg'), kind: 'media-image', file: 'assets/c.jpg', ext: 'jpg' },
      { key: key('logoEN0000000000.png'), kind: 'media-image', file: 'assets/d.png', ext: 'png' },
      { key: key('logoENcrush00000.png'), kind: 'media-image', file: 'assets/e.png', ext: 'png' },
      { key: key('coverEN000000000.jpg'), kind: 'media-image', file: 'assets/f.jpg', ext: 'jpg' },
    ],
  };
}

/** The per-language storyline packages a staged archive would provide for the
 *  fixture stack (docs/rise-multilang.md §4.3b): en-us + ru attached DIFFERENT
 *  bundles, so the plan emits one attach step per language. */
export function l10nStorylineAttach(): Map<
  string,
  { locale: string; l10nId?: string; reviewPrefix: string; meta?: unknown; title?: string }
> {
  const cell = 'cccc3333-0000-4000-8000-000000000009';
  // Keys are `${blockKey(lessonId, blockId)}|${locale}` — lesson-qualified,
  // because block ids repeat across lessons (v0.6.3 collision class).
  return new Map([
    [
      `${blockKey('lessonB-0000000000000000000000', 'cblockSL00000000000000000')}|en-us`,
      {
        locale: 'en-us',
        l10nId: cell,
        reviewPrefix: 'review/items/slEN000000000000',
        meta: { title: 'Onboarding EN' },
        title: 'Onboarding EN',
      },
    ],
    [
      `${blockKey('lessonB-0000000000000000000000', 'cblockSL00000000000000000')}|ru`,
      {
        locale: 'ru',
        l10nId: cell,
        reviewPrefix: 'review/items/slRU000000000000',
        meta: { title: 'Onboarding RU' },
        title: 'Onboarding RU',
      },
    ],
  ]);
}

/** The deterministic "conversion" the fixture applies: target ref id for a
 *  source l10nId. Tests assert against these. */
export function tgtRef(sourceL10nId: string): string {
  return `tgt-${sourceL10nId}`;
}

const isRefObj = (v: unknown): v is { l10nId: string } =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v as object).length === 1 &&
  typeof (v as { l10nId?: unknown }).l10nId === 'string';

/** Parallel walk: wherever the SOURCE holds an {l10nId} ref, the converted
 *  target holds {l10nId: tgt-<id>} at the same path; everywhere else it keeps
 *  the BUILT (materialized) value — exactly what Rise's conversion does to a
 *  full default-language course (idea 2). */
function refify(src: unknown, built: unknown): unknown {
  if (isRefObj(src)) return { l10nId: tgtRef(src.l10nId) };
  if (Array.isArray(src) && Array.isArray(built)) {
    return built.map((b, i) => refify(src[i], b));
  }
  if (
    src && built &&
    typeof src === 'object' && typeof built === 'object' &&
    !Array.isArray(src) && !Array.isArray(built)
  ) {
    const out: Record<string, unknown> = { ...(built as Record<string, unknown>) };
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if (k in (built as object)) out[k] = refify(v, (built as Record<string, unknown>)[k]);
    }
    return out;
  }
  return built;
}

/** Scripted happy-path handlers for a full IDEA-2 stack import. Stateful: it
 *  records the lessons/blocks the executor CREATES (and the block patches),
 *  and the post-conversion GET_COURSE returns the l10n-ified version of that
 *  build — refs minted per `tgtRef`, default-locale cells extracted from the
 *  built values, AI text rows for the other locales (media gets NO rows,
 *  matching the capture-proven conversion behavior). */
export function l10nHandlers(): Record<string, (body: unknown) => unknown> {
  const source = JSON.parse(JSON.stringify(l10nSample)) as GetCourseDocument;
  let getCourseCalls = 0;
  let lessonN = 0;
  const createdLessonIds: string[] = [];
  const builtBlocks = new Map<string, Record<string, unknown>[]>(); // new lesson id → blocks

  const convertedDoc = (): Record<string, unknown> => {
    const srcCourse = source.course as Record<string, unknown>;
    // Source lessons in AUTHORITATIVE order (the executor creates them in that
    // order, so created lesson N pairs with authoritative source lesson N).
    const srcOrdered = [...(source.lessons ?? [])].sort((a, b) => {
      const order = (srcCourse.lessons as string[]) ?? [];
      return order.indexOf(String(a.id)) - order.indexOf(String(b.id));
    });
    const lessons = createdLessonIds.map((newId, i) => {
      const src = srcOrdered[i] ?? {};
      const blocks = builtBlocks.get(newId) ?? [];
      const srcBlocks = (src.items ?? []) as Record<string, unknown>[];
      return {
        id: newId,
        title: isRefObj(src.title) ? { l10nId: tgtRef(src.title.l10nId) } : (src.title ?? ''),
        items: blocks.map((b, bi) => refify(srcBlocks[bi], b)),
      };
    });
    // Tables: default rows for every source default cell (extracted from the
    // build); AI TEXT rows for the other locales; NO media rows for them.
    const srcTables = source.l10n?.translations ?? {};
    const en: Record<string, unknown> = {};
    for (const [id, v] of Object.entries(srcTables['en-us'] ?? {})) en[tgtRef(id)] = v;
    const ai = (code: string): Record<string, unknown> => {
      const t: Record<string, unknown> = {};
      for (const [id, v] of Object.entries(srcTables['en-us'] ?? {})) {
        if (typeof v === 'string') t[tgtRef(id)] = `AI ${code} ${v.slice(0, 20)}`;
      }
      return t;
    };
    return {
      course: {
        id: 'NEWCOURSE',
        title: { l10nId: tgtRef('aaaa1111-0000-4000-8000-000000000001') },
        description: { l10nId: tgtRef('aaaa1111-0000-4000-8000-000000000002') },
        media: { l10nId: tgtRef('aaaa1111-0000-4000-8000-000000000003') },
        coverImage: { media: { l10nId: tgtRef('aaaa1111-0000-4000-8000-000000000004') } },
        defaultLocaleId: 'tgt-row-en',
        localizationMetadata: { isLocalized: true, localizedAt: 't' },
        lessons: createdLessonIds,
      },
      lessons,
      l10n: {
        defaultLocale: 'en-us',
        showLocaleSelector: false,
        locales: [
          { id: 'tgt-row-en', locale: 'en-us' },
          { id: 'tgt-row-ru', locale: 'ru' },
          { id: 'tgt-row-ar', locale: 'ar' },
        ],
        translations: { 'en-us': en, ru: ai('ru'), ar: ai('ar') },
      },
    };
  };

  return {
    'GET /manage/api/content/NEWCOURSE/translations': () => ({
      stackItems: [
        { id: 'tgt-row-en', locale: 'en-us', status: 'complete', deletedAt: null },
        { id: 'tgt-row-ru', locale: 'ru', status: 'complete', deletedAt: null },
        { id: 'tgt-row-ar', locale: 'ar', status: 'complete', deletedAt: null },
      ],
    }),
    'translations (': () => ({}), // POST …/translations (convert-stack)
    '/manage/api/content': () => ({ id: 'NEWCOURSE' }),
    GET_COURSE: () => {
      getCourseCalls += 1;
      return getCourseCalls === 1
        ? { payload: { course: { id: 'NEWCOURSE', lessons: [] } } }
        : { payload: convertedDoc() };
    },
    CREATE_LESSON: () => {
      const id = `NEWLESSON${++lessonN}`;
      createdLessonIds.push(id);
      return { payload: { lesson: { id } } };
    },
    CREATE_BLOCKS: (body: unknown) => {
      const p = (body as { payload: { lessonId: string; blocks: Record<string, unknown>[] } })
        .payload;
      builtBlocks.set(p.lessonId, [...(builtBlocks.get(p.lessonId) ?? []), ...p.blocks]);
      return {
        payload: {
          success: true,
          blockMetadata: p.blocks.map((b, i) => ({ id: b.id, globalBlockId: `g${i}` })),
        },
      };
    },
    UPDATE_BLOCK_DEBOUNCE: (body: unknown) => {
      // Record block patches (media remap / storyline attach) so the converted
      // doc reflects the FINAL pre-conversion state of each block.
      const p = (body as { payload: { lessonId: string; item: Record<string, unknown> } }).payload;
      const list = builtBlocks.get(p.lessonId);
      if (list && p.item && typeof p.item === 'object') {
        const i = list.findIndex((b) => b.id === p.item.id);
        if (i >= 0) list[i] = p.item;
      }
      return { payload: { success: true } };
    },
    GET_YURL: (body: unknown) => {
      const fn = (body as { payload: { filename: string } }).payload.filename;
      return {
        payload: {
          key: `rise/courses/NEWCOURSE/new-${fn}`,
          url: 'https://s3/put',
          type: 'application/octet-stream',
        },
      };
    },
    UPDATE_L10N_BATCH: (body: unknown) => ({
      payload: { changes: (body as { payload: { changes: unknown[] } }).payload.changes },
    }),
    CREATE_LABEL_SET: () => ({ payload: { id: 'NEWLABELSET1' } }),
    UPDATE_LABELS: () => ({ payload: { id: 'NEWLABELSET1' } }),
    UPDATE_LOCALE: () => ({ payload: { locale: 'ru', labelSetId: 'NEWLABELSET1' } }),
    UPDATE_COURSE: () => ({ payload: {} }),
    UPDATE_LESSON: () => ({ payload: {} }),
    copy_review_item: () => [{ CopyObjectResult: { ETag: '"x"' } }],
  };
}
