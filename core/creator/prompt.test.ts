import { describe, expect, it } from 'vitest';
import {
  COURSE_BLUEPRINT_FORMAT,
  COURSE_BLUEPRINT_VERSION,
  type BlockIntentKind,
} from './blueprint/types';
import { validateBlueprint } from './blueprint/validate';
import { creatorPrompt, PROMPT_EXAMPLE_BLUEPRINT } from './prompt';

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
  'fill-in-the-blank',
  'matching',
  'table',
  'labeled-graphic',
  'note',
  'links',
  'video-placeholder',
  'storyline-placeholder',
  'continue',
  'attachment-placeholder',
  'quote',
  'banner',
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

  it('forbids copying narration scripts and pins production to []', () => {
    expect(prompt).toMatch(/NARRATION \/ voice-over \/ audio scripts are NEVER copied/);
    expect(prompt).toMatch(/"production" is kept for schema compatibility and is ALWAYS \[\]/);
    expect(PROMPT_EXAMPLE_BLUEPRINT).toMatch(/"production": \[\]/);
    expect(prompt).toMatch(/a row number is NEVER a slideNo/);
    expect(prompt).toMatch(/NEVER put a table row number here/);
  });

  it('makes author directives binding, wherever they appear', () => {
    expect(prompt).toMatch(/BINDING/);
    expect(prompt).toMatch(/on-slide label boxes/);
  });

  it('embeds a worked example that passes our own validator', () => {
    const v = validateBlueprint(PROMPT_EXAMPLE_BLUEPRINT);
    expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(v.ready).toBe(true);
    expect(prompt).toContain(PROMPT_EXAMPLE_BLUEPRINT);
    // The per-block worked example shows intent as an OBJECT (critique #1).
    expect(prompt).toMatch(/"intent" is never a string label/);
  });

  it('treats speaker notes neutrally — no fixed role', () => {
    expect(prompt).toMatch(/SPEAKER NOTES have NO fixed role/);
    expect(prompt).toMatch(/never assume they are guidance/);
    // The old blanket assumption must not resurface.
    expect(prompt).not.toMatch(/speaker notes are binding/i);
  });

  it('carries the directive alias table with a deterministic fallback', () => {
    expect(prompt).toMatch(/alias table/i);
    for (const uiName of ['flipcards', 'statement', 'numbered list', 'labeled graphic']) {
      expect(prompt.toLowerCase(), `alias "${uiName}" missing`).toContain(uiName);
    }
    expect(prompt).toMatch(/nearest listed block that can carry the TEXT/);
    expect(prompt).toMatch(/Never bury source text inside a placeholder label/);
  });

  it('moves labeled graphic / matching / fill-in out of the storyline bucket', () => {
    const storylineLine = prompt.split('\n').find((l) => /→ "storyline-placeholder"/.test(l))!;
    expect(storylineLine).not.toMatch(/labeled graphic|matching|fill-in/);
    expect(storylineLine).toMatch(/horizontal accordion/); // a Mighty block — stays a placeholder
    expect(prompt).toMatch(/labeled graphic .*→ "labeled-graphic"/);
    expect(prompt).toMatch(/matching .*→ "matching"/);
    expect(prompt).toMatch(/fill in the blank .*→ "fill-in-the-blank"/);
    expect(prompt).toMatch(/table .*→ "table"/);
    expect(prompt).toMatch(/A directive naming TWO blocks/);
  });

  it('explains table-based (docx) storyboards: row provenance, legend, narration column', () => {
    expect(prompt).toMatch(/## Table-based storyboards/);
    expect(prompt).toContain('"sourceRef.row"');
    expect(prompt).toMatch(/counting the header row as row 1/);
    expect(prompt).toMatch(/READ the legend and OBEY it/);
    expect(prompt).toMatch(/\[TĀLĀK\]/);
    expect(prompt).toMatch(/built-in placeholder image/);
  });

  it('states the comment, contradiction, title, and no-invented-quiz rules', () => {
    expect(prompt).toMatch(/open\/unaddressed comment is never content/i);
    expect(prompt).toMatch(/CONTRADICTIONS/);
    expect(prompt).toMatch(/Never silently pick one version/);
    expect(prompt).toMatch(/title derived — no title in source/);
    expect(prompt).toMatch(/emit ZERO "knowledge-check" blocks/);
    expect(prompt).toMatch(/formatting, NOT "suggested"/);
    expect(prompt).toMatch(/ALWAYS the literal "narration"/);
    expect(prompt).toMatch(/~60 characters/);
    expect(prompt).toMatch(/Emit COMPACT JSON/);
    expect(prompt).toMatch(/OMIT "excerpt"/);
  });

  it('appends operator per-deck instructions when given', () => {
    const withExtra = creatorPrompt('Slides 4-6 are decorative, skip them.');
    expect(withExtra).toContain('Operator instructions for this document');
    expect(withExtra).toContain('Slides 4-6 are decorative, skip them.');
    expect(creatorPrompt('   ')).not.toContain('Operator instructions');
  });
});
