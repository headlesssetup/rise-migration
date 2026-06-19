// Known block catalog — the machine-readable seed mirroring
// docs/rise-block-catalog.md. Grown by novelty review: when a new variant or
// field is accepted, it's recorded here (and in the doc) so later runs pass it
// silently.

// Accepted variant→field baseline (generated from a scrape's catalog.json /
// novelty report). A variant present here is "known" and its listed field-paths
// are the baseline against which field-level novelty is diffed.
import fieldBaseline from './catalog.fields.json';

const FIELD_BASELINE = fieldBaseline as Record<string, string[]>;

export const KNOWN_VARIANTS = new Set<string>([
  // Documented / previously seen.
  'list/numbered',
  'image/hero',
  'multimedia/video',
  'flashcard/flashcard',
  'interactive-fullscreen/labeledgraphic',
  'interactive-fullscreen/process',
  'interactive-fullscreen/sorting',
  'continue/continue',
  'divider/numbered divider',
  'html/inline',
  'html/cdn',
  '360/storyline',
  'knowledgeCheck/draw from question bank',
  // Accepted from novelty review (earlier 2026-06-19 scrape).
  'buttons/button',
  'buttons/button stack',
  'gallery/three column',
  'image/text aside',
  'image/text overlay',
  'impact/b',
  'interactive/accordion',
  'knowledgeCheck/multiple response',
  'list/bulleted',
  'list/checkboxes',
  'multimedia/embed',
  // The 32 variants from the 579-course scrape are accepted via FIELD_BASELINE
  // (catalog.fields.json) — see isKnownVariant.
]);

// Families documented as a wildcard (e.g. `text/*`) — any variant is known.
export const KNOWN_FAMILIES = new Set<string>(['text']);

export function isKnownVariant(key: string): boolean {
  if (KNOWN_VARIANTS.has(key)) return true;
  if (key in FIELD_BASELINE) return true; // recorded with a field baseline
  const i = key.indexOf('/');
  return KNOWN_FAMILIES.has(i >= 0 ? key.slice(0, i) : key);
}

// Per-variant known field-paths, from the accepted baseline. A variant with an
// entry enables field-level novelty (anything not listed is surfaced as a new
// field); variants without an entry are not field-diffed (see catalog.json).
export function knownFieldsFor(key: string): Set<string> | null {
  const f = FIELD_BASELINE[key];
  return f ? new Set(f) : null;
}

