// Merge per-course scans into a deduplicated census across the library.

import type { CourseScan, RefKind } from './scan';

const MAX_EXAMPLES = 3;

export interface VariantEntry {
  key: string; // family/variant
  family: string;
  variant: string;
  count: number; // total occurrences across all courses
  courseCount: number; // distinct courses it appears in
  courseIds: string[];
  examplePaths: string[];
}

export interface RefShapeEntry {
  kind: RefKind;
  count: number;
  courseCount: number;
  courseIds: string[];
  examplePaths: string[];
  exampleValues: string[];
}

export interface CountEntry {
  name: string;
  count: number;
}

export interface VersionEntry {
  signal: string;
  courseIds: string[];
}

export interface Census {
  courseCount: number;
  courseIds: string[];
  variants: VariantEntry[];
  refs: RefShapeEntry[];
  lessonTypes: CountEntry[];
  questionTypes: CountEntry[];
  versions: VersionEntry[];
}

function pushCapped(arr: string[], value: string, cap = MAX_EXAMPLES): void {
  if (arr.length < cap && !arr.includes(value)) arr.push(value);
}

export function buildCensus(scans: CourseScan[]): Census {
  const courseIds = new Set<string>();
  const variants = new Map<string, VariantEntry>();
  const refs = new Map<RefKind, RefShapeEntry>();
  const lessonTypes = new Map<string, Set<string>>();
  const questionTypes = new Map<string, Set<string>>();
  const versions = new Map<string, Set<string>>();

  for (const scan of scans) {
    const cid = scan.courseId ?? '(unknown)';
    courseIds.add(cid);

    for (const b of scan.blocks) {
      let entry = variants.get(b.key);
      if (!entry) {
        entry = {
          key: b.key,
          family: b.family,
          variant: b.variant,
          count: 0,
          courseCount: 0,
          courseIds: [],
          examplePaths: [],
        };
        variants.set(b.key, entry);
      }
      entry.count += 1;
      if (!entry.courseIds.includes(cid)) {
        entry.courseIds.push(cid);
        entry.courseCount += 1;
      }
      pushCapped(entry.examplePaths, b.path);
    }

    for (const r of scan.refs) {
      let entry = refs.get(r.kind);
      if (!entry) {
        entry = {
          kind: r.kind,
          count: 0,
          courseCount: 0,
          courseIds: [],
          examplePaths: [],
          exampleValues: [],
        };
        refs.set(r.kind, entry);
      }
      entry.count += 1;
      if (!entry.courseIds.includes(cid)) {
        entry.courseIds.push(cid);
        entry.courseCount += 1;
      }
      pushCapped(entry.examplePaths, r.path);
      pushCapped(entry.exampleValues, r.value);
    }

    for (const t of scan.lessonTypes) {
      (lessonTypes.get(t) ?? lessonTypes.set(t, new Set()).get(t)!).add(cid);
    }
    for (const t of scan.questionTypes) {
      (questionTypes.get(t) ?? questionTypes.set(t, new Set()).get(t)!).add(cid);
    }
    if (scan.versionSignal !== undefined) {
      const sig = String(scan.versionSignal);
      (versions.get(sig) ?? versions.set(sig, new Set()).get(sig)!).add(cid);
    }
  }

  const toCounts = (m: Map<string, Set<string>>): CountEntry[] =>
    [...m.entries()]
      .map(([name, ids]) => ({ name, count: ids.size }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    courseCount: courseIds.size,
    courseIds: [...courseIds],
    variants: [...variants.values()].sort(
      (a, b) => b.count - a.count || a.key.localeCompare(b.key),
    ),
    refs: [...refs.values()].sort((a, b) => b.count - a.count),
    lessonTypes: toCounts(lessonTypes),
    questionTypes: toCounts(questionTypes),
    versions: [...versions.entries()]
      .map(([signal, ids]) => ({ signal, courseIds: [...ids] }))
      .sort((a, b) => a.signal.localeCompare(b.signal)),
  };
}
