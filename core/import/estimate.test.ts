import { describe, it, expect } from 'vitest';
import { buildPlan } from './plan';
import { estimateImportSeconds, sumEstimates, formatEstimate } from './estimate';
import { imageCourse, l10nCourse } from './executor.fixtures';

describe('estimateImportSeconds', () => {
  it('counts paced envelopes + upload bytes for a monolingual course', () => {
    const input = imageCourse();
    input.assets = input.assets.map((a) => ({ ...a, size: 3 * 1024 * 1024 }));
    const e = estimateImportSeconds(buildPlan(input), input.assets);
    expect(e.envelopes).toBeGreaterThan(4); // shell+handshake, lesson, blocks, upload, title…
    expect(e.uploadBytes).toBe(3 * 1024 * 1024);
    expect(e.stacks).toBe(0);
    expect(e.seconds).toBeGreaterThan(10);
  });

  it('adds the stack conversion allowance and scales with cells', () => {
    const input = l10nCourse();
    const e = estimateImportSeconds(buildPlan(input), input.assets);
    expect(e.stacks).toBe(1);
    const plain = estimateImportSeconds(buildPlan(imageCourse()), []);
    expect(e.seconds).toBeGreaterThan(plain.seconds + 60); // ≥ the await allowance
  });

  it('is monotonic in blocks', () => {
    const small = imageCourse();
    const big = imageCourse();
    const lesson = big.course.lessons![0]!;
    lesson.items = [...lesson.items!, ...JSON.parse(JSON.stringify(lesson.items))].map(
      (b: Record<string, unknown>, i: number) => ({ ...b, id: `cblock${String(i).padStart(19, '0')}` }),
    );
    // more blocks → ≥ envelopes (same lesson still one CREATE_BLOCKS, but uploads dup)
    expect(estimateImportSeconds(buildPlan(big), big.assets).seconds).toBeGreaterThanOrEqual(
      estimateImportSeconds(buildPlan(small), small.assets).seconds,
    );
  });

  it('sums across courses', () => {
    const a = { seconds: 10, envelopes: 5, uploadBytes: 100, stacks: 0 };
    const b = { seconds: 20, envelopes: 7, uploadBytes: 50, stacks: 1 };
    expect(sumEstimates([a, b])).toEqual({ seconds: 30, envelopes: 12, uploadBytes: 150, stacks: 1 });
  });
});

describe('formatEstimate', () => {
  it('formats deliberately rough buckets', () => {
    expect(formatEstimate(42)).toBe('~40 s');
    expect(formatEstimate(600)).toBe('~10 min');
    expect(formatEstimate(2 * 3600 + 16 * 60)).toBe('~2 h 15 m');
    expect(formatEstimate(3 * 3600)).toBe('~3 h');
  });
});
