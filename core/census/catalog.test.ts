import { describe, expect, it } from 'vitest';
import { isKnownVariant, knownFieldsFor } from './catalog';

describe('catalog', () => {
  it('treats seed, field-baseline, and wildcard variants as known', () => {
    expect(isKnownVariant('image/hero')).toBe(true); // seed list
    expect(isKnownVariant('quote/carousel')).toBe(true); // field baseline
    expect(isKnownVariant('text/whatever')).toBe(true); // text/* wildcard
    expect(isKnownVariant('totally/unknown')).toBe(false);
  });

  it('returns a field baseline for catalogued variants', () => {
    const f = knownFieldsFor('multimedia/audio');
    expect(f).not.toBeNull();
    expect(f?.has('items[].media.audio.key')).toBe(true);
  });

  it('has no field baseline for variants not yet field-catalogued', () => {
    // Known by name but no recorded fields yet → not field-diffed.
    expect(knownFieldsFor('image/hero')).toBeNull();
  });
});
