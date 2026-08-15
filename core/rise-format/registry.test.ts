import { describe, expect, it } from 'vitest';
import type { BlockIntentKind } from '@/core/creator/blueprint';
import {
  RISE_TEMPLATE_REGISTRY,
  RISE_TEMPLATE_REGISTRY_REVISION,
  registryWarnings,
} from './registry';

const KINDS: BlockIntentKind[] = [
  'text',
  'list',
  'accordion',
  'tabs',
  'flashcards',
  'process',
  'timeline',
  'sorting',
  'knowledge-check',
  'note',
  'links',
  'video-placeholder',
  'storyline-placeholder',
  'continue',
  'attachment-placeholder',
];

describe('Rise template registry', () => {
  it('covers every compiler intent with a donor and a shippable verification state', () => {
    expect(RISE_TEMPLATE_REGISTRY_REVISION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(Object.keys(RISE_TEMPLATE_REGISTRY).sort()).toEqual([...KINDS].sort());
    for (const kind of KINDS) {
      const row = RISE_TEMPLATE_REGISTRY[kind];
      expect(row.intent).toBe(kind);
      expect(row.donor.length).toBeGreaterThan(10);
      expect(row.outputs.length).toBeGreaterThan(0);
      expect(row.verification).not.toBe('disabled');
    }
  });

  it('keeps non-live templates visible as preview warnings', () => {
    expect(registryWarnings(['text', 'video-placeholder'])).toEqual(
      expect.arrayContaining([
        expect.stringContaining('text: compiler-tested'),
        expect.stringContaining('video-placeholder: compiler-tested, derived donor'),
      ]),
    );
  });
});
