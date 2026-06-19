// Serialize a census to the two deliverable formats: JSON (full) and CSV (flat).

import { toCsv } from '@/core/util/csv';
import type { Census } from './aggregate';

export function censusToJson(c: Census): string {
  return JSON.stringify(c, null, 2);
}

/**
 * Flat CSV across all census categories. One table, a `category` column
 * discriminates block / ref / lessonType / questionType / version rows.
 */
export function censusToCsv(c: Census): string {
  const headers = [
    'category',
    'name',
    'detail',
    'count',
    'courseCount',
    'examplePaths',
    'exampleValues',
  ];
  const rows: (string | number)[][] = [];

  for (const v of c.variants) {
    rows.push(['block', v.key, '', v.count, v.courseCount, v.examplePaths.join(' | '), '']);
  }
  for (const r of c.refs) {
    rows.push([
      'ref',
      r.kind,
      '',
      r.count,
      r.courseCount,
      r.examplePaths.join(' | '),
      r.exampleValues.join(' | '),
    ]);
  }
  for (const t of c.lessonTypes) {
    rows.push(['lessonType', t.name, '', t.count, t.count, '', '']);
  }
  for (const t of c.questionTypes) {
    rows.push(['questionType', t.name, '', t.count, t.count, '', '']);
  }
  for (const v of c.versions) {
    rows.push([
      'version',
      v.signal,
      '',
      v.courseIds.length,
      v.courseIds.length,
      '',
      v.courseIds.join(' | '),
    ]);
  }

  return toCsv(headers, rows);
}
