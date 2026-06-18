// Serialize a census to the two deliverable formats: JSON (full) and CSV (flat).

import type { Census } from './aggregate';

export function censusToJson(c: Census): string {
  return JSON.stringify(c, null, 2);
}

function csvEscape(value: string): string {
  // Quote if the value contains a comma, quote, or newline; double inner quotes.
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function row(cells: (string | number)[]): string {
  return cells.map((c) => csvEscape(String(c))).join(',');
}

/**
 * Flat CSV across all census categories. One table, a `category` column
 * discriminates block / ref / lessonType / questionType / version rows.
 */
export function censusToCsv(c: Census): string {
  const header = [
    'category',
    'name',
    'detail',
    'count',
    'courseCount',
    'examplePaths',
    'exampleValues',
  ];
  const lines: string[] = [row(header)];

  for (const v of c.variants) {
    lines.push(
      row([
        'block',
        v.key,
        '',
        v.count,
        v.courseCount,
        v.examplePaths.join(' | '),
        '',
      ]),
    );
  }
  for (const r of c.refs) {
    lines.push(
      row([
        'ref',
        r.kind,
        '',
        r.count,
        r.courseCount,
        r.examplePaths.join(' | '),
        r.exampleValues.join(' | '),
      ]),
    );
  }
  for (const t of c.lessonTypes) {
    lines.push(row(['lessonType', t.name, '', t.count, t.count, '', '']));
  }
  for (const t of c.questionTypes) {
    lines.push(row(['questionType', t.name, '', t.count, t.count, '', '']));
  }
  for (const v of c.versions) {
    lines.push(
      row([
        'version',
        v.signal,
        '',
        v.courseIds.length,
        v.courseIds.length,
        '',
        v.courseIds.join(' | '),
      ]),
    );
  }

  return lines.join('\n');
}
