// Monolingual course label set (mig30oct 2026-10-30): the US source courses
// named no label set (`labelSetId: ""`) yet showed German UI strings; the EU
// copies showed English. plan-labelset + the set-course-labelset handler.
import { describe, it, expect } from 'vitest';
import { buildPlan, type PlanInput } from './plan';
import { executePlan } from './executor';
import { IdMap } from './ids';
import { counterMint, mockRelay, happyHandlers } from './executor.fixtures';

const SRC_SETS = [
  { id: 'SRC-EN', name: 'English', iso639Code: 'en', defaultSet: true, labels: { quizTakeAgain: 'TAKE AGAIN' } },
  { id: 'SRC-DE', name: 'German', iso639Code: 'de', defaultSet: true, labels: { quizTakeAgain: 'ERNEUT VERSUCHEN' } },
  {
    id: 'SRC-CUSTOM',
    name: 'DB Deutsch',
    iso639Code: 'de',
    defaultSet: false,
    labels: { quizTakeAgain: 'NOCHMAL', quizIncorrect: 'Falsch' },
  },
];
const DEFAULTS = [
  { name: 'German', iso639Code: 'de', defaultSet: true, labels: { quizTakeAgain: 'ERNEUT VERSUCHEN', quizIncorrect: 'Falsch' } },
];
const TARGET_SETS = [
  { id: 'TGT-EN', name: 'English', iso639Code: 'en', defaultSet: true },
  { id: 'TGT-DE', name: 'German', iso639Code: 'de', defaultSet: true },
];

function course(labelSetId: string, defaultLabelLanguage?: string): PlanInput {
  return {
    author: 'auth0|t',
    targetFolderId: 'all',
    assets: [],
    banksById: new Map(),
    defaultLabelLanguage,
    course: {
      course: { id: 'SRC', title: 'C', labelSetId, theme: { themeId: 'classic' } },
      lessons: [{ id: 'L1', position: 0, type: 'blocks', title: 'L', icon: 'Article', items: [] }],
      labelSets: SRC_SETS,
      defaultLabelSets: DEFAULTS,
    } as unknown as PlanInput['course'],
  };
}

async function run(input: PlanInput, targetSets: unknown[] = TARGET_SETS, dryRun = false) {
  const sent: { url: string; payload: Record<string, unknown> }[] = [];
  const { relay } = mockRelay({
    ...happyHandlers,
    CREATE_LABEL_SET: () => ({ payload: { id: 'NEWLABELSET1' } }),
    UPDATE_LABELS: () => ({ payload: { id: 'NEWLABELSET1' } }),
    GET_COURSE: () => ({ payload: { course: { id: 'NEWCOURSE', lessons: [] }, labelSets: targetSets } }),
  });
  const res = await executePlan(buildPlan(input), {
    input,
    relay: async (spec) => {
      if (spec.body) sent.push({ url: spec.url, payload: JSON.parse(spec.body).payload });
      return relay(spec);
    },
    readAsset: async () => null,
    ids: new IdMap(counterMint()),
    mintId: counterMint(),
    labelSetCache: new Map(),
    dryRun,
    // A dry run has no handshake: the orchestrator pre-reads the target sets.
    targetLabelSets: dryRun ? (targetSets as Record<string, unknown>[]) : undefined,
  });
  const bind = sent.find((s) => s.url.endsWith('/UPDATE_COURSE') && 'labelSetId' in s.payload);
  return { res, sent, bind: bind?.payload };
}

describe('plan — set-course-labelset', () => {
  it('plans nothing for an unnamed set without an operator language', () => {
    expect(buildPlan(course('')).some((s) => s.kind === 'set-course-labelset')).toBe(false);
  });
  it('plans the operator language for an unnamed set', () => {
    const step = buildPlan(course('', 'de')).find((s) => s.kind === 'set-course-labelset');
    expect(step).toMatchObject({ builtin: true, iso639Code: 'de', name: 'German', sourceLabelSetId: null });
  });
  it('plans a named custom set with only its overrides', () => {
    const step = buildPlan(course('SRC-CUSTOM', 'en')).find((s) => s.kind === 'set-course-labelset');
    expect(step).toMatchObject({ builtin: false, name: 'DB Deutsch', labels: { quizTakeAgain: 'NOCHMAL' } });
  });
});

describe('executePlan — set-course-labelset', () => {
  it('binds the TARGET built-in of the operator language', async () => {
    const { res, bind } = await run(course('', 'de'));
    expect(res.ok).toBe(true);
    expect(bind).toEqual({ id: 'NEWCOURSE', labelSetId: 'TGT-DE' });
    expect(res.decisions).toEqual([
      expect.objectContaining({ area: 'Interface language', detail: expect.stringContaining('names no label set') }),
    ]);
  });

  it('dry run predicts a missing target language from the pre-read sets', async () => {
    const { res } = await run(course('', 'de'), [{ id: 'TGT-EN', iso639Code: 'en', defaultSet: true }], true);
    expect(res.flags.some((f) => f.kind === 'label-set')).toBe(true);
  });

  it('binds the target built-in matching a named built-in source set', async () => {
    const { bind } = await run(course('SRC-DE'));
    expect(bind).toEqual({ id: 'NEWCOURSE', labelSetId: 'TGT-DE' });
  });

  it('recreates a custom set once, then binds it', async () => {
    const { res, sent, bind } = await run(course('SRC-CUSTOM'));
    expect(res.ok).toBe(true);
    expect(sent.some((s) => s.url.endsWith('/CREATE_LABEL_SET'))).toBe(true);
    expect(bind).toEqual({ id: 'NEWCOURSE', labelSetId: 'NEWLABELSET1' });
  });

  it('flags (never aborts) when the target lacks the language', async () => {
    const { res, bind } = await run(course('', 'de'), [{ id: 'TGT-EN', iso639Code: 'en', defaultSet: true }]);
    expect(res.ok).toBe(true);
    expect(bind).toBeUndefined();
    expect(res.flags.some((f) => f.kind === 'label-set')).toBe(true);
  });
});
