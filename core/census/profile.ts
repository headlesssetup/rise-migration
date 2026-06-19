// Per-variant field profiles — the scalable knowledge base. For each
// family/variant, aggregate every occurrence's field-paths into one row marking
// each field core (present in every instance) vs optional (sometimes), with
// counts. This collapses the combinatorial explosion of optional-field shapes
// into a stable per-variant view, and is what seeds docs/rise-block-catalog.md.

import { toCsv } from '@/core/util/csv';
import type { CourseScan } from './scan';

export interface FieldStat {
  path: string;
  /** Block instances (library-wide) containing this field-path. */
  count: number;
  courseCount: number;
  /** count / variant.instances (0..1). */
  presence: number;
  /** Present in every instance of the variant. */
  core: boolean;
}

export interface VariantProfile {
  key: string; // family/variant
  family: string;
  variant: string;
  instances: number;
  courseCount: number;
  courseIds: string[];
  /** Distinct structural signatures (how much the shape varies) — a metric. */
  distinctShapes: number;
  examplePath: string;
  fields: FieldStat[];
}

interface Acc {
  key: string;
  instances: number;
  courseIds: Set<string>;
  signatures: Set<string>;
  examplePath: string;
  fields: Map<string, { count: number; courses: Set<string> }>;
}

export function buildProfiles(scans: CourseScan[]): VariantProfile[] {
  const map = new Map<string, Acc>();

  for (const scan of scans) {
    const cid = scan.courseId ?? '(unknown)';
    for (const vf of scan.variantFields) {
      let a = map.get(vf.key);
      if (!a) {
        a = {
          key: vf.key,
          instances: 0,
          courseIds: new Set(),
          signatures: new Set(),
          examplePath: vf.examplePath,
          fields: new Map(),
        };
        map.set(vf.key, a);
      }
      a.instances += vf.instances;
      a.courseIds.add(cid);
      for (const s of vf.signatures) a.signatures.add(s);
      for (const [path, count] of Object.entries(vf.fieldCounts)) {
        let f = a.fields.get(path);
        if (!f) {
          f = { count: 0, courses: new Set() };
          a.fields.set(path, f);
        }
        f.count += count;
        f.courses.add(cid);
      }
    }
  }

  const profiles: VariantProfile[] = [];
  for (const a of map.values()) {
    const slash = a.key.indexOf('/');
    const fields: FieldStat[] = [...a.fields.entries()]
      .map(([path, f]) => ({
        path,
        count: f.count,
        courseCount: f.courses.size,
        presence: a.instances ? Math.round((f.count / a.instances) * 100) / 100 : 0,
        core: f.count === a.instances,
      }))
      .sort(
        (x, y) =>
          Number(y.core) - Number(x.core) ||
          y.count - x.count ||
          x.path.localeCompare(y.path),
      );

    profiles.push({
      key: a.key,
      family: slash >= 0 ? a.key.slice(0, slash) : a.key,
      variant: slash >= 0 ? a.key.slice(slash + 1) : '',
      instances: a.instances,
      courseCount: a.courseIds.size,
      courseIds: [...a.courseIds],
      distinctShapes: a.signatures.size,
      examplePath: a.examplePath,
      fields,
    });
  }

  return profiles.sort(
    (x, y) => y.instances - x.instances || x.key.localeCompare(y.key),
  );
}

export function profileToJson(profiles: VariantProfile[]): string {
  return JSON.stringify(profiles, null, 2);
}

/** Flat CSV: one row per (variant, field). */
export function profileToCsv(profiles: VariantProfile[]): string {
  const headers = [
    'key',
    'instances',
    'courseCount',
    'distinctShapes',
    'field',
    'core',
    'presencePct',
    'fieldCourseCount',
  ];
  const rows: (string | number)[][] = [];
  for (const p of profiles) {
    for (const f of p.fields) {
      rows.push([
        p.key,
        p.instances,
        p.courseCount,
        p.distinctShapes,
        f.path,
        f.core ? 'core' : 'optional',
        Math.round(f.presence * 100),
        f.courseCount,
      ]);
    }
  }
  return toCsv(headers, rows);
}
