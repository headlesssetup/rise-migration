import { describe, expect, it } from 'vitest';
import sample from '../../tests/fixtures/get-course.sample.json';
import { buildProfiles } from './profile';
import { scanCourse } from './scan';
import type { GetCourseDocument } from '@/shared/types/rise';

const profiles = buildProfiles([scanCourse(sample as GetCourseDocument)]);

describe('buildProfiles', () => {
  it('produces one profile per family/variant in the fixture', () => {
    const keys = new Set(profiles.map((p) => p.key));
    expect(keys).toEqual(
      new Set([
        'text/paragraph',
        'image/hero',
        'multimedia/embed',
        '360/storyline',
        'knowledgeCheck/draw from question bank',
      ]),
    );
  });

  it('marks always-present fields as core', () => {
    const hero = profiles.find((p) => p.key === 'image/hero');
    expect(hero?.instances).toBe(1);
    expect(hero?.family).toBe('image');
    expect(hero?.variant).toBe('hero');
    const core = hero?.fields.filter((f) => f.core).map((f) => f.path) ?? [];
    expect(core).toContain('family');
    expect(core).toContain('variant');
  });

  it('aggregates instances and courses across a second course', () => {
    const twice = buildProfiles([
      scanCourse(sample as GetCourseDocument),
      scanCourse(sample as GetCourseDocument),
    ]);
    const hero = twice.find((p) => p.key === 'image/hero');
    // Same fixture courseId twice → 1 distinct course, 2 instances.
    expect(hero?.instances).toBe(2);
    expect(hero?.courseCount).toBe(1);
  });
});
