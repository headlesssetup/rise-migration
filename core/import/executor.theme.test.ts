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
