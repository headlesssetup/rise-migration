// Publish/export settings migration (handover 2026-08-31, blocker 3) —
// plan + executor + parity facet.
import { describe, it, expect } from 'vitest';
import { buildPlan, type PlanInput } from './plan';
import { executePlan } from './executor';
import { IdMap } from './ids';
import { verifyParity } from './verify';
import { counterMint, mockRelay, happyHandlers } from './executor.fixtures';
import type { GetCourseDocument } from '@/shared/types/rise';

const SRC_EXPORT_SETTINGS = {
  title: 'Quiz course',
  format: 'zip',
  quizId: 'QUIZLESSON',
  target: 'scorm12',
  targetName: 'SCORM 1.2',
  shareId: 'SRCSHARE',
  activeLMS: 0,
  hideLmsUi: false,
  reporting: 'passed-incomplete',
  exportType: 'lms',
  identifier: 'SRC_rise',
  completeWith: 'quiz',
  completionPercentage: '80',
  quizComplete: true,
  activeEdition: 3,
  loadOnlyInLMS: true,
  isRemotePackage: false,
  disableCoverPage: false,
  enableExitCourse: false,
  resetLearnerData: false,
};

function quizCourse(exportSettings: Record<string, unknown> | undefined): PlanInput {
  return {
    author: 'auth0|t',
    targetFolderId: 'all',
    assets: [],
    banksById: new Map(),
    course: {
      course: { id: 'SRC', title: 'Quiz course', ...(exportSettings ? { exportSettings } : {}) },
      lessons: [
        {
          id: 'QUIZLESSON',
          position: 0,
          type: 'quiz',
          title: 'Final quiz',
          icon: 'Quiz',
          items: [],
        },
      ],
    },
  };
}

const handlers = {
  ...happyHandlers,
  // handshake returns the TARGET's own shareId
  GET_COURSE: () => ({
    payload: { course: { id: 'NEWCOURSE', lessons: [], shareId: 'TGTSHARE' } },
  }),
};

describe('plan — set-export-settings', () => {
  it('emits the step LAST when the source carries exportSettings', () => {
    const steps = buildPlan(quizCourse(SRC_EXPORT_SETTINGS));
    const kinds = steps.map((s) => s.kind);
    expect(kinds[kinds.length - 1]).toBe('set-export-settings');
    expect(kinds.indexOf('set-export-settings')).toBeGreaterThan(kinds.indexOf('create-lesson'));
  });

  it('skips the step for an empty/absent exportSettings', () => {
    expect(buildPlan(quizCourse({})).some((s) => s.kind === 'set-export-settings')).toBe(false);
    expect(buildPlan(quizCourse(undefined)).some((s) => s.kind === 'set-export-settings')).toBe(false);
  });
});

describe('executePlan — set-export-settings', () => {
  async function run(exportSettings: Record<string, unknown>) {
    const input = quizCourse(exportSettings);
    const steps = buildPlan(input);
    const sent: { url: string; body: unknown }[] = [];
    const { relay } = mockRelay(handlers);
    const res = await executePlan(steps, {
      input,
      relay: async (spec) => {
        sent.push({ url: spec.url, body: spec.body ? JSON.parse(spec.body) : undefined });
        return relay(spec);
      },
      readAsset: async () => null,
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    const write = sent.find(
      (s) => s.url.includes('UPDATE_COURSE_DEBOUNCE') && !!s.body &&
        'exportSettings' in ((s.body as { payload: Record<string, unknown> }).payload ?? {}),
    );
    const payload = write
      ? (write.body as { payload: { id: string; exportSettings: Record<string, unknown> } }).payload
      : undefined;
    return { res, payload };
  }

  it('writes the full object with remapped quizId/identifier and the TARGET shareId', async () => {
    const { res, payload } = await run(SRC_EXPORT_SETTINGS);
    expect(res.ok).toBe(true);
    expect(payload).toBeDefined();
    expect(payload!.id).toBe('NEWCOURSE');
    const es = payload!.exportSettings;
    expect(es.quizId).toBe(res.idMap['QUIZLESSON']); // remapped to the new lesson id
    expect(es.identifier).toBe('NEWCOURSE_rise');
    expect(es.shareId).toBe('TGTSHARE'); // the target's own, never the source's
    expect(es.activeEdition).toBeNull(); // target publish lifecycle
    // meaningful fields verbatim
    expect(es.completeWith).toBe('quiz');
    expect(es.completionPercentage).toBe('80');
    expect(es.reporting).toBe('passed-incomplete');
    expect(res.flags.filter((f) => f.kind === 'export-settings')).toHaveLength(0);
  });

  it('drops + flags a stale quizId that maps to nothing', async () => {
    const { res, payload } = await run({ ...SRC_EXPORT_SETTINGS, quizId: 'STALE_DUPLICATED_FROM' });
    expect(res.ok).toBe(true);
    expect(payload!.exportSettings.quizId).toBeNull();
    expect(res.flags.some((f) => f.kind === 'export-settings' && /quizId/.test(f.detail))).toBe(true);
  });
});

describe('executePlan — set-course-settings / set-ai-tutor-config', () => {
  async function runCourse(courseFields: Record<string, unknown>) {
    const input = quizCourse(undefined);
    Object.assign(input.course.course as Record<string, unknown>, courseFields);
    const steps = buildPlan(input);
    const sent: { url: string; body: unknown }[] = [];
    const { relay } = mockRelay(handlers);
    const res = await executePlan(steps, {
      input,
      relay: async (spec) => {
        sent.push({ url: spec.url, body: spec.body ? JSON.parse(spec.body) : undefined });
        return relay(spec);
      },
      readAsset: async () => ({ base64: 'AAAA', contentType: 'image/svg+xml' }),
      ids: new IdMap(counterMint()),
      mintId: counterMint(),
    });
    const debounces = sent
      .filter((s) => s.url.includes('UPDATE_COURSE_DEBOUNCE'))
      .map((s) => (s.body as { payload: Record<string, unknown> }).payload);
    return { res, sent, debounces };
  }

  it('writes the source settings object verbatim', async () => {
    const { res, debounces } = await runCourse({
      settings: { aiTutorEnabled: true, isAIConceptToCourse: true },
    });
    expect(res.ok).toBe(true);
    const w = debounces.find((p) => 'settings' in p)!;
    expect(w.settings).toEqual({ aiTutorEnabled: true, isAIConceptToCourse: true });
  });

  it('neutralizes the shell default when the source settings are empty', async () => {
    const { debounces } = await runCourse({ settings: {} });
    const w = debounces.find((p) => 'settings' in p)!;
    expect(w.settings).toEqual({ aiTutorEnabled: false });
  });

  it('uploads the AI-tutor avatar and writes the config with the remapped key', async () => {
    const { res, sent, debounces } = await runCourse({
      aiTutorConfig: {
        name: 'Ask me!',
        image: { media: { image: { key: 'rise/courses/SRC/avatar.svg' } } },
      },
    });
    expect(res.ok).toBe(true);
    // avatar rode the normal upload chain (GET_YURL + S3 PUT)
    expect(sent.some((s) => s.url.includes('GET_YURL'))).toBe(true);
    const w = debounces.find((p) => 'aiTutorConfig' in p)!;
    const blob = JSON.stringify(w.aiTutorConfig);
    expect(blob).toContain('Ask me!');
    expect(blob).not.toContain('rise/courses/SRC'); // source key remapped
    expect(res.survivingKeys).toEqual([]);
  });
});

describe('verifyParity — exportSettings', () => {
  const sourceDoc = (es: Record<string, unknown>): GetCourseDocument =>
    ({
      course: { id: 'SRC', title: 'C', exportSettings: es },
      lessons: [{ id: 'QUIZLESSON', type: 'quiz', title: 'Q', items: [] }],
    }) as unknown as GetCourseDocument;
  const targetDoc = (es: Record<string, unknown>): GetCourseDocument =>
    ({
      course: {
        id: 'NEW',
        title: 'C',
        lessons: ['NEWQUIZ'],
        exportSettings: es,
      },
      lessons: [{ id: 'NEWQUIZ', type: 'quiz', title: 'Q', items: [] }],
    }) as unknown as GetCourseDocument;

  it('passes when meaningful fields match and quizId names a real target lesson', () => {
    const p = verifyParity(
      sourceDoc({ completeWith: 'quiz', reporting: 'passed-incomplete', quizId: 'QUIZLESSON' }),
      targetDoc({ completeWith: 'quiz', reporting: 'passed-incomplete', quizId: 'NEWQUIZ' }),
    );
    expect(p.issues.filter((i) => i.path.startsWith('course.exportSettings'))).toEqual([]);
  });

  it('flags a changed completion mode and a dangling target quizId', () => {
    const p = verifyParity(
      sourceDoc({ completeWith: 'quiz', quizId: 'QUIZLESSON' }),
      targetDoc({ completeWith: 'reporting', quizId: 'GONE' }),
    );
    const paths = p.issues.map((i) => i.path);
    expect(paths).toContain('course.exportSettings.completeWith');
    expect(paths).toContain('course.exportSettings.quizId');
  });

  it('treats a FLAGGED dropped quiz binding as an expected divergence', () => {
    const p = verifyParity(
      sourceDoc({ completeWith: 'quiz', quizId: 'QUIZLESSON' }),
      targetDoc({ completeWith: 'quiz', quizId: null }),
      [{ kind: 'export-settings', detail: 'exportSettings.quizId STALE … manually' }],
    );
    expect(p.issues.some((i) => i.path === 'course.exportSettings.quizId')).toBe(false);
    expect(
      p.expectedDivergences.some((i) => i.path === 'course.exportSettings.quizId'),
    ).toBe(true);
  });

  it('normalizes number↔string completionPercentage', () => {
    const p = verifyParity(
      sourceDoc({ completionPercentage: '80' }),
      targetDoc({ completionPercentage: 80 }),
    );
    expect(p.issues.filter((i) => i.path.startsWith('course.exportSettings'))).toEqual([]);
  });
});
