import { describe, expect, it } from 'vitest';
import {
  isKnownLegacyStorylineMeta,
  legacyStorylinePlaceholderBlock,
  parseStorylineVersion,
  LEGACY_STORYLINE_PLACEHOLDER,
} from './compatibility';

describe('Storyline compatibility policy', () => {
  it('classifies only the evidenced legacy 3.x update range', () => {
    expect(isKnownLegacyStorylineMeta({ version: '3.9.13510.0' })).toBe(true);
    expect(isKnownLegacyStorylineMeta({ version: '3.42.22792.0' })).toBe(true);
    expect(isKnownLegacyStorylineMeta({ version: '3.48.24159.0' })).toBe(true);
    expect(isKnownLegacyStorylineMeta({ version: '3.49.24347.0' })).toBe(false);
    expect(isKnownLegacyStorylineMeta({ version: '3.117.35650.0' })).toBe(false);
    expect(isKnownLegacyStorylineMeta({ version: 'unexpected' })).toBe(false);
    expect(isKnownLegacyStorylineMeta({})).toBe(false);
  });

  it('parses the major/update pair without inventing missing metadata', () => {
    expect(parseStorylineVersion('3.48.24159.0')).toEqual({ major: 3, update: 48 });
    expect(parseStorylineVersion('7')).toBeNull();
    expect(parseStorylineVersion(null)).toBeNull();
  });

  it('builds the capture-backed visible text placeholder with remapped ids', () => {
    const placeholder = legacyStorylinePlaceholderBlock(
      { id: 'new-block', items: [{ id: 'new-item' }] },
      () => 'minted',
    );
    expect(placeholder).toMatchObject({
      id: 'new-block',
      type: 'text',
      family: 'text',
      variant: 'paragraph',
      items: [{ id: 'new-item', paragraph: expect.stringContaining(LEGACY_STORYLINE_PLACEHOLDER) }],
      settings: {},
    });
  });
});
