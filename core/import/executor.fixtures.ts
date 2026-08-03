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

/** Scripted happy-path handlers for a full stack import. GET_COURSE is stateful:
 *  the 1st call is the post-create handshake (plain shell), later calls return
 *  the CONVERTED target (l10n-ified refs + a junk placeholder cell). */
export function l10nHandlers(): Record<string, (body: unknown) => unknown> {
  let getCourseCalls = 0;
  let lessonN = 0;
  const targetDoc = {
    course: {
      id: 'NEWCOURSE',
      title: { l10nId: 'tgt-title' },
      description: { l10nId: 'tgt-desc' },
      media: { l10nId: 'tgt-logo' },
      coverImage: { media: { l10nId: 'tgt-cover' } },
      defaultLocaleId: 'tgt-row-en',
      localizationMetadata: { isLocalized: true, localizedAt: 't' },
      lessons: ['NEWLESSON1'],
    },
    lessons: [{ id: 'NEWLESSON1', title: { l10nId: 'tgt-l1title' }, items: [] }],
    l10n: {
      defaultLocale: 'en-us',
      showLocaleSelector: false,
      locales: [
        { id: 'tgt-row-en', locale: 'en-us' },
        { id: 'tgt-row-ru', locale: 'ru' },
        { id: 'tgt-row-ar', locale: 'ar' },
      ],
      translations: {
        'en-us': {
          'tgt-title': '!importing: Fixture Stack Course',
          'tgt-desc': '.',
          'tgt-l1title': 'Lesson One',
          'junk-1': 'AI leftover',
        },
        ru: { 'tgt-title': 'AI перевод', 'tgt-desc': '.', 'tgt-l1title': 'AI урок' },
        ar: { 'tgt-title': 'AI عنوان', 'tgt-desc': '.', 'tgt-l1title': 'AI درس' },
      },
    },
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
        : { payload: targetDoc };
    },
    CREATE_LESSON: () => ({ payload: { lesson: { id: `NEWLESSON${++lessonN}` } } }),
    CREATE_BLOCKS: (body: unknown) => {
      const blocks = (body as { payload: { blocks: { id: string }[] } }).payload.blocks;
      return {
        payload: {
          success: true,
          blockMetadata: blocks.map((b, i) => ({ id: b.id, globalBlockId: `g${i}` })),
        },
      };
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
