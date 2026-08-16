import { describe, expect, it } from 'vitest';
import {
  COURSE_BLUEPRINT_FORMAT,
  COURSE_BLUEPRINT_VERSION,
  type BlockIntentKind,
} from './blueprint/types';
import { creatorPrompt } from './prompt';

// Keep in sync with BlockIntent in blueprint/types.ts — if a kind is added
// there, the prompt must document it (this list is checked exhaustively below).
const ALL_KINDS: BlockIntentKind[] = [
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

describe('creatorPrompt', () => {
  const prompt = creatorPrompt();

  it('documents every block intent kind', () => {
    for (const kind of ALL_KINDS) {
      expect(prompt, `kind "${kind}" missing from prompt`).toContain(`"${kind}"`);
    }
  });

  it('pins the exact format and version literals', () => {
    expect(prompt).toContain(`"${COURSE_BLUEPRINT_FORMAT}"`);
    expect(prompt).toContain(`"formatVersion": ${COURSE_BLUEPRINT_VERSION}`);
  });

  it('states the fidelity rule: no inventing/rephrasing unless marked suggested', () => {
    expect(prompt).toMatch(/Do not invent, embellish, or rephrase/);
    expect(prompt).toContain('"origin": "suggested"');
    expect(prompt).toMatch(/NEVER invent facts, quiz answers, dates/);
  });

  it('requires provenance, empty assets, and unresolved for unplaceable material', () => {
    expect(prompt).toContain('"sourceRef"');
    expect(prompt).toContain('"assets" must stay []');
    expect(prompt).toContain('"unresolved"');
    expect(prompt).toContain('"production"');
  });

  it('makes author block-choice comments binding', () => {
    expect(prompt).toMatch(/BINDING/);
  });

  it('appends operator per-deck instructions when given', () => {
    const withExtra = creatorPrompt('Slides 4-6 are decorative, skip them.');
    expect(withExtra).toContain('Operator instructions for this document');
    expect(withExtra).toContain('Slides 4-6 are decorative, skip them.');
    expect(creatorPrompt('   ')).not.toContain('Operator instructions');
  });
});
