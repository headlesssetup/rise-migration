// Theme + typeface bindings (set-theme step) — regression for the VAS2.5 import
// of 2026-10-28: a course-only archive (no account/typefaces.json) used to get
// the theme-only UPDATE_COURSE, so Rise adopted the stale `theme.*TypefaceId`
// leftovers (Lato/Merriweather) over the course's authoritative top-level
// bindings (Source Sans Pro) — even within the SAME account.
import { describe, it, expect } from 'vitest';
import { buildPlan, type PlanInput } from './plan';
import { executePlan } from './executor';
import { IdMap } from './ids';
import { counterMint, mockRelay, happyHandlers } from './executor.fixtures';

const SSP = '1vPbwKGWlm3GrjQNzas7M9nK'; // "Source Sans Pro" (custom)
const LATO = '_vy9IVqRPwz6wQlKi0wsA9dsYpZ7gsQ3';
const MERRI = 'Wstu1lVkR_rUsAuU6x1N_UImwchzygj2';

function themedCourse(course: Record<string, unknown>): PlanInput {
  return {
    author: 'auth0|t',
    targetFolderId: 'all',
    assets: [],
    banksById: new Map(),
    course: {
      course: { id: 'SRC', title: 'Themed', ...course },
      lessons: [{ id: 'L1', position: 0, type: 'blocks', title: 'Lesson 1', icon: 'Article', items: [] }],
    },
  };
}

async function themeWrite(input: PlanInput) {
  const steps = buildPlan(input);
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const { relay } = mockRelay(happyHandlers);
  const res = await executePlan(steps, {
    input,
    relay: async (spec) => {
      if (spec.body) sent.push({ url: spec.url, body: JSON.parse(spec.body) as Record<string, unknown> });
      return relay(spec);
    },
    readAsset: async () => null,
    ids: new IdMap(counterMint()),
    mintId: counterMint(),
    // NO sourceTypefaces / typefaceIdMap — a course-only archive.
  });
  const write = sent.find(
    (s) => s.url.endsWith('/UPDATE_COURSE') && 'theme' in ((s.body.payload as Record<string, unknown>) ?? {}),
  );
  return { res, payload: write?.body.payload as Record<string, unknown> | undefined };
}

describe('executePlan — set-theme without an account typeface map', () => {
  it('sends the TOP-LEVEL heading/body/ui ids unchanged (theme leftovers do not win)', async () => {
    const { res, payload } = await themeWrite(
      themedCourse({
        headingTypefaceId: SSP,
        bodyTypefaceId: SSP,
        uiTypefaceId: LATO,
        // stale ids of the theme the course was duplicated from
        theme: { themeId: 'organic', headingTypefaceId: LATO, bodyTypefaceId: MERRI, uiTypefaceId: LATO },
        typefaces: { [SSP]: 'Source Sans Pro', [LATO]: 'Lato' },
      }),
    );
    expect(res.ok).toBe(true);
    expect(payload).toBeDefined();
    expect(payload!.id).toBe('NEWCOURSE');
    expect(payload!.headingTypefaceId).toBe(SSP);
    expect(payload!.bodyTypefaceId).toBe(SSP);
    expect(payload!.uiTypefaceId).toBe(LATO);
    // the theme itself still round-trips verbatim (stale ids included)
    const theme = payload!.theme as Record<string, unknown>;
    expect(theme.themeId).toBe('organic');
    expect(theme.headingTypefaceId).toBe(LATO);
    expect(theme.bodyTypefaceId).toBe(MERRI);
    expect(res.flags.filter((f) => f.kind === 'typeface')).toHaveLength(0);
  });

  it('keeps the theme-only envelope when the course carries no typeface slot at all', async () => {
    const { res, payload } = await themeWrite(themedCourse({ theme: { themeId: 'classic' } }));
    expect(res.ok).toBe(true);
    expect(payload).toEqual({ id: 'NEWCOURSE', theme: { themeId: 'classic' } });
  });
});

// mig30oct 2026-10-30: DB Head / DB Sans were shared into the source course but
// absent from the source account's own font list, and Führungssparring's theme
// carried two stale ids beside its authoritative top-level slots.
describe('executePlan — set-theme font matching by the course\'s own names', () => {
  const DBHEAD = 'G4P8w5vW5at04tJ9Wbuq6LES';
  const DBSANS = 'vNfDKDgxcTQprdc5xBMiXsNZ';
  const STALE = '0ds_0MwU_ZWwlmdmFMlx1YkP';
  const tf = (id: string, name: string, isDefault = false) => ({ id, name, isDefault, fonts: [] });

  async function run(target: ReturnType<typeof tf>[]) {
    const input = themedCourse({
      headingTypefaceId: DBHEAD,
      bodyTypefaceId: DBSANS,
      uiTypefaceId: LATO,
      theme: { themeId: 'classic', headingTypefaceId: STALE, bodyTypefaceId: DBSANS, uiTypefaceId: LATO },
      typefaces: { [DBHEAD]: 'DB Head', [DBSANS]: 'DB Sans', [LATO]: 'Lato' },
    });
    const sent: Record<string, unknown>[] = [];
    const { relay } = mockRelay(happyHandlers);
    const res = await executePlan(buildPlan(input), {
      input,
      relay: async (spec) => {
        if (spec.body && spec.url.endsWith('/UPDATE_COURSE')) sent.push(JSON.parse(spec.body).payload);
        return relay(spec);
      },
      readAsset: async () => null,
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
      sourceTypefaces: new Map([[LATO, tf(LATO, 'Lato', true)]]),
      targetTypefaces: new Map(target.map((t) => [t.id, t])),
    });
    return { res, payload: sent.find((p) => 'theme' in p) };
  }

  it('binds a font the target already has under the same name', async () => {
    const { res, payload } = await run([tf('T-LATO', 'Lato', true), tf('T-HEAD', 'DB Head'), tf('T-SANS', 'DB Sans')]);
    expect(payload!.headingTypefaceId).toBe('T-HEAD');
    expect(payload!.bodyTypefaceId).toBe('T-SANS');
    expect(res.flags.filter((f) => f.kind === 'typeface')).toHaveLength(0);
  });

  it('flags missing fonts BY NAME with similar target fonts, and never the stale theme id', async () => {
    const { res } = await run([
      tf('T-LATO', 'Lato', true),
      tf('T-NEOH', 'DB Neo Screen Head'),
      tf('T-NEO', 'DB Neo Screen'),
    ]);
    const details = res.flags.filter((f) => f.kind === 'typeface').map((f) => f.detail);
    expect(details).toHaveLength(2);
    expect(details[0]).toContain('"DB Head"');
    expect(details[0]).toContain('"DB Neo Screen Head"');
    expect(details.join(' ')).not.toContain(STALE);
  });

  it('replaces a stale theme id with the font the course displays in that slot, and reports it', async () => {
    const { res, payload } = await run([tf('T-LATO', 'Lato', true), tf('T-HEAD', 'DB Head'), tf('T-SANS', 'DB Sans')]);
    expect((payload!.theme as Record<string, unknown>).headingTypefaceId).toBe('T-HEAD');
    expect(JSON.stringify(payload)).not.toContain(STALE);
    expect(res.decisions?.some((d) => d.area === 'Fonts' && d.detail.includes(STALE))).toBe(true);
  });
});
