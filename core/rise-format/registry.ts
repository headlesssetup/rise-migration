import type { BlockIntentKind } from '@/core/creator/blueprint';

export const RISE_TEMPLATE_REGISTRY_REVISION = '2026-08-14.1' as const;

export type TemplateVerification = 'compiler-tested' | 'live-verified' | 'disabled';
export type DonorConfidence = 'captured' | 'derived';

export interface RiseTemplateRegistration {
  intent: BlockIntentKind;
  /** Rise family/variant emitted for the semantic intent. */
  outputs: readonly string[];
  /** Where the JSON shape and settings came from. */
  donor: string;
  donorConfidence: DonorConfidence;
  verification: TemplateVerification;
  note?: string;
}

/**
 * Shipping bar: every enabled intent has a documented donor and compiler test.
 * `live-verified` is deliberately stronger and controls the preview warning.
 */
export const RISE_TEMPLATE_REGISTRY: Readonly<
  Record<BlockIntentKind, RiseTemplateRegistration>
> = {
  text: {
    intent: 'text',
    outputs: ['text / heading paragraph', 'text / paragraph'],
    donor: 'capture_creation4aug editor CREATE_BLOCKS payload and exported text blocks',
    donorConfidence: 'captured',
    verification: 'compiler-tested',
  },
  list: {
    intent: 'list',
    outputs: ['list / numbered', 'list / bulleted'],
    donor: 'capture_creation4aug editor CREATE_BLOCKS payload and exported list blocks',
    donorConfidence: 'captured',
    verification: 'compiler-tested',
  },
  accordion: {
    intent: 'accordion',
    outputs: ['interactive / accordion'],
    donor: 'capture_creation4aug editor payload and operator archive donor',
    donorConfidence: 'captured',
    verification: 'compiler-tested',
  },
  tabs: {
    intent: 'tabs',
    outputs: ['interactive / tabs'],
    donor: 'capture_creation4aug editor payload and operator archive donor',
    donorConfidence: 'captured',
    verification: 'compiler-tested',
  },
  flashcards: {
    intent: 'flashcards',
    outputs: ['flashcard / flashcard'],
    donor: 'operator archive exported flashcard block',
    donorConfidence: 'captured',
    verification: 'compiler-tested',
  },
  process: {
    intent: 'process',
    outputs: ['interactive-fullscreen / process'],
    donor: 'operator archive exported process block',
    donorConfidence: 'captured',
    verification: 'compiler-tested',
  },
  timeline: {
    intent: 'timeline',
    outputs: ['interactive-fullscreen / timeline'],
    donor: 'operator archive exported timeline block',
    donorConfidence: 'captured',
    verification: 'compiler-tested',
  },
  sorting: {
    intent: 'sorting',
    outputs: ['interactive-fullscreen / sorting'],
    donor: 'operator archive exported sorting block',
    donorConfidence: 'captured',
    verification: 'compiler-tested',
  },
  'knowledge-check': {
    intent: 'knowledge-check',
    outputs: ['knowledgeCheck / multiple choice', 'knowledgeCheck / multiple response'],
    donor: 'capture_creation4aug editor payload and exported knowledge-check blocks',
    donorConfidence: 'captured',
    verification: 'compiler-tested',
  },
  note: {
    intent: 'note',
    outputs: ['impact / note'],
    donor: 'operator hand-made Quick Test export, 2026-08-10',
    donorConfidence: 'captured',
    verification: 'compiler-tested',
  },
  links: {
    intent: 'links',
    outputs: ['buttons / button stack'],
    donor: 'operator archive exported button-stack block',
    donorConfidence: 'captured',
    verification: 'compiler-tested',
  },
  'video-placeholder': {
    intent: 'video-placeholder',
    outputs: ['multimedia / video (empty)'],
    donor: 'exported native video block with captured settings; media fields deliberately omitted',
    donorConfidence: 'derived',
    verification: 'compiler-tested',
    note: 'Not yet verified as a pristine editor-created empty video block on a live pilot.',
  },
  'storyline-placeholder': {
    intent: 'storyline-placeholder',
    outputs: ['text / paragraph warning'],
    donor: 'capture_creation4aug exported text block; placeholder is escaped text only',
    donorConfidence: 'captured',
    verification: 'compiler-tested',
  },
  continue: {
    intent: 'continue',
    outputs: ['continue / continue'],
    donor: 'capture_creation4aug editor-created continue divider',
    donorConfidence: 'captured',
    verification: 'compiler-tested',
  },
  'attachment-placeholder': {
    intent: 'attachment-placeholder',
    outputs: ['text / paragraph warning'],
    donor: 'capture_creation4aug exported text block; placeholder is escaped text only',
    donorConfidence: 'captured',
    verification: 'compiler-tested',
  },
};

export function riseTemplateFor(kind: BlockIntentKind): RiseTemplateRegistration {
  const registration = RISE_TEMPLATE_REGISTRY[kind];
  if (registration.verification === 'disabled') {
    throw new Error(`Rise template ${kind} is disabled in registry ${RISE_TEMPLATE_REGISTRY_REVISION}.`);
  }
  return registration;
}

export function registryWarnings(kinds: Iterable<BlockIntentKind>): string[] {
  const warnings: string[] = [];
  for (const kind of new Set(kinds)) {
    const row = riseTemplateFor(kind);
    if (row.verification !== 'live-verified') {
      warnings.push(
        `${kind}: ${row.verification}${row.donorConfidence === 'derived' ? ', derived donor' : ''}${row.note ? ` — ${row.note}` : ''}`,
      );
    }
  }
  return warnings;
}
