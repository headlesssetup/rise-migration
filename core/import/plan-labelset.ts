// Monolingual course label-set planning (mig30oct 2026-10-30). Split from
// plan.ts (size cap); buildPlan calls planCourseLabelSet once, after the theme.
//
// GET_COURSE carries the viewer's `labelSets` (built-ins: `defaultSet: true`,
// one per language, + any custom sets) and Rise's `defaultLabelSets` (labels
// only). `course.labelSetId` names the course's set; "" means "no explicit
// set" and resolves to an account default the export cannot see.

import type { GetCourseDocument } from '@/shared/types/rise';
import type { PlanStep } from './plan-types';

type LabelStep = Extract<PlanStep, { kind: 'set-course-labelset' }>;

function sets(doc: GetCourseDocument, key: 'labelSets' | 'defaultLabelSets'): Record<string, unknown>[] {
  const v = (doc as Record<string, unknown>)[key];
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
}

/** The label-set step for a monolingual course, or null when nothing should be
 *  bound (the source names no set and the operator chose no language, or the
 *  named set is not in the archive — the read-back does not compare label sets,
 *  so that case is left to the operator exactly as before). */
export function planCourseLabelSet(
  doc: GetCourseDocument,
  defaultLabelLanguage?: string,
): LabelStep | null {
  const course = (doc.course ?? {}) as Record<string, unknown>;
  const setId = typeof course.labelSetId === 'string' ? course.labelSetId : '';
  const defaults = sets(doc, 'defaultLabelSets');

  if (setId) {
    const set = sets(doc, 'labelSets').find((s) => s.id === setId);
    if (!set) return null;
    const iso = typeof set.iso639Code === 'string' ? set.iso639Code : '';
    const name = typeof set.name === 'string' ? set.name : iso || 'Imported labels';
    if (set.defaultSet === true && iso) {
      return {
        kind: 'set-course-labelset',
        sourceLabelSetId: setId,
        iso639Code: iso,
        name,
        builtin: true,
        labels: {},
        summary: `Bind built-in label set "${name}" (${iso})`,
      };
    }
    const labels = (set.labels ?? {}) as Record<string, unknown>;
    const def = defaults.find((s) => s.iso639Code === iso && s.defaultSet === true);
    const defLabels = (def?.labels ?? {}) as Record<string, unknown>;
    const overrides: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(labels)) if (defLabels[k] !== v) overrides[k] = v;
    return {
      kind: 'set-course-labelset',
      sourceLabelSetId: setId,
      iso639Code: iso || 'en',
      name,
      builtin: false,
      labels: overrides,
      summary: `Recreate label set "${name}" (${Object.keys(overrides).length} custom label(s)) and bind it`,
    };
  }

  const lang = (defaultLabelLanguage ?? '').trim().toLowerCase();
  if (!lang) return null;
  const known = [...sets(doc, 'labelSets'), ...defaults].find(
    (s) => s.defaultSet === true && s.iso639Code === lang,
  );
  const name = typeof known?.name === 'string' ? known.name : lang;
  return {
    kind: 'set-course-labelset',
    sourceLabelSetId: null,
    iso639Code: lang,
    name,
    builtin: true,
    labels: {},
    summary: `Bind built-in label set "${name}" (operator default for courses without one)`,
  };
}
