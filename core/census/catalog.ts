// Known block catalog — the machine-readable seed mirroring
// docs/rise-block-catalog.md. Grown by novelty review: when a new variant or
// field is accepted, it's recorded here (and in the doc) so later runs pass it
// silently.

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
  // Accepted from novelty review (2026-06-19 scrape).
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
]);

// Families documented as a wildcard (e.g. `text/*`) — any variant is known.
export const KNOWN_FAMILIES = new Set<string>(['text']);

export function isKnownVariant(key: string): boolean {
  if (KNOWN_VARIANTS.has(key)) return true;
  const i = key.indexOf('/');
  return KNOWN_FAMILIES.has(i >= 0 ? key.slice(0, i) : key);
}

// Per-variant known field-paths. Seeded empty; populate from a scrape's
// `catalog.json` to enable field-level novelty (a field-path here is "known",
// anything else on that variant is surfaced as new). Until a variant has an
// entry, its fields are not flagged (avoids first-run noise — see catalog.json).
export const KNOWN_FIELDS: Record<string, string[]> = {};

export function knownFieldsFor(key: string): Set<string> | null {
  const f = KNOWN_FIELDS[key];
  return f ? new Set(f) : null;
}
