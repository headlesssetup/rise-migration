import { describe, expect, it } from 'vitest';
import sample from '../../tests/fixtures/get-course.sample.json';
import { buildCensus } from './aggregate';
import { censusToCsv, censusToJson } from './export';
import { scanCourse } from './scan';
import type { GetCourseDocument } from '@/shared/types/rise';

const census = buildCensus([scanCourse(sample as GetCourseDocument)]);

describe('buildCensus', () => {
  it('aggregates one course with all distinct variants', () => {
    expect(census.courseCount).toBe(1);
    expect(census.variants).toHaveLength(5);
    expect(census.variants.every((v) => v.courseCount === 1)).toBe(true);
  });

  it('aggregates ref shapes', () => {
    const kinds = new Set(census.refs.map((r) => r.kind));
    expect(kinds.has('media-image')).toBe(true);
    expect(kinds.has('storyline-crossref')).toBe(true);
    expect(kinds.has('draw-from-bank-crossref')).toBe(true);
  });
});

describe('census export', () => {
  it('round-trips JSON', () => {
    const parsed = JSON.parse(censusToJson(census));
    expect(parsed.courseCount).toBe(1);
  });

  it('produces a CSV with a header and one row per item', () => {
    const csv = censusToCsv(census);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(
      'category,name,detail,count,courseCount,examplePaths,exampleValues',
    );
    expect(lines.some((l) => l.startsWith('block,'))).toBe(true);
    expect(lines.some((l) => l.startsWith('ref,'))).toBe(true);
  });

  it('escapes values containing commas/quotes', () => {
    const csv = censusToCsv(census);
    // The "draw from question bank" variant name has no comma, but example
    // values (JSON snippets) do — ensure they are quoted.
    expect(csv).toContain('"');
  });
});
