import { describe, expect, it } from 'vitest';
import { buildNovelty, type NoveltyCatalog } from './novelty';
import type { FieldStat, VariantProfile } from './profile';

function profile(
  key: string,
  fields: [path: string, core: boolean][],
  instances = 2,
): VariantProfile {
  const slash = key.indexOf('/');
  const f: FieldStat[] = fields.map(([path, core]) => ({
    path,
    count: core ? instances : 1,
    courseCount: 1,
    presence: core ? 1 : 0.5,
    core,
  }));
  return {
    key,
    family: slash >= 0 ? key.slice(0, slash) : key,
    variant: slash >= 0 ? key.slice(slash + 1) : '',
    instances,
    courseCount: 1,
    courseIds: ['c1'],
    distinctShapes: 1,
    examplePath: '$.lessons[0].items[0]',
    fields: f,
  };
}

// image/hero is "known" with a field baseline; everything else is unknown.
const catalog: NoveltyCatalog = {
  isKnownVariant: (k) => k === 'image/hero',
  knownFieldsFor: (k) =>
    k === 'image/hero' ? new Set(['family', 'variant', 'media.image.key']) : null,
};

describe('buildNovelty', () => {
  it('flags variants absent from the catalog', () => {
    const r = buildNovelty([profile('buttons/button', [['family', true]])], catalog);
    expect(r.newVariants.map((v) => v.key)).toContain('buttons/button');
    expect(r.newFields).toHaveLength(0);
  });

  it('flags new fields on a known variant that has a baseline', () => {
    const r = buildNovelty(
      [
        profile('image/hero', [
          ['family', true],
          ['variant', true],
          ['media.image.key', true],
          ['settings.imageSize', false],
        ]),
      ],
      catalog,
    );
    expect(r.newVariants).toHaveLength(0);
    expect(r.newFields.map((f) => f.path)).toEqual(['settings.imageSize']);
  });

  it('does not flag fields for a known variant without a baseline', () => {
    const cat: NoveltyCatalog = {
      isKnownVariant: () => true,
      knownFieldsFor: () => null,
    };
    const r = buildNovelty(
      [profile('text/paragraph', [['family', true], ['settings.x', false]])],
      cat,
    );
    expect(r.newFields).toHaveLength(0);
    expect(r.knownWithoutFieldCatalog).toContain('text/paragraph');
    expect(r.variantCount).toBe(1);
  });
});
