// Storyboard phase 2 — map PlannedCourse block INTENTS to real Rise block JSON.
//
// Shapes come from DONORS, never from guesswork: the editor's own CREATE_BLOCKS
// payloads (capture_creation4aug — a fresh block ships exactly
// {family, id, items, settings, type, variant}) and real exported blocks from
// the operator's archives / captures. Settings objects are donor-verbatim.
// Text values are the monolingual plain-HTML form (heading = inline HTML,
// paragraph/description = `<p>…</p>` HTML) as captured from the editor.
//
// The one shape without a captured pristine donor is the EMPTY video block
// (a video block minus its media — Rise renders its native placeholder); it is
// marked with a review note and the pilot verifies it (plan phase 5).

import { newId } from '@/core/import/ids';
import { riseTemplateFor } from '@/core/rise-format';
import type { Block } from '@/shared/types/rise';
import type { BlockIntent, BlueprintBlock } from '@/core/creator/blueprint';

export interface Mints {
  /** cuid-style client id (blocks, items). */
  cuid(): string;
  /** UUID (knowledge-check question/answer ids — mirrors the editor). */
  uuid(): string;
}

export function defaultMints(): Mints {
  return {
    cuid: newId,
    uuid: () =>
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : // last-resort fallback (very old runtimes) — RFC4122-shaped
          'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
          }),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Donor-verbatim settings (see file header for provenance).
const TEXT_SETTINGS = {};
const LIST_SETTINGS = { paddingTop: 0 };
const INTERACTIVE_SETTINGS = {
  audioPosition: 'bottom',
  markerColorContrast: 'AUTO',
  paddingBottom: 3,
  paddingLinked: true,
  paddingTop: 0,
  snippetColorContrast: 'AUTO',
  v: 2,
  zoomOnClick: true,
};
const FLASHCARD_SETTINGS = { paddingTop: 0 };
const SORTING_SETTINGS = {
  backgroundColor: '#f5f5f5',
  markerColorContrast: 'AUTO',
  mediaWidth: '1',
  paddingBottom: 3,
  paddingLinked: true,
  paddingTop: 3,
  quotesInline: false,
  snippetColorContrast: 'AUTO',
  zoomOnClick: true,
};
const TIMELINE_SETTINGS = {
  attachedToNextBlock: false,
  audioPosition: 'bottom',
  backgroundType: 'LIGHT',
  markerColorContrast: 'AUTO',
  mediaWidth: '1',
  paddingBottom: 0,
  paddingLinked: true,
  paddingTop: 0,
  quotesInline: false,
  snippetColorContrast: 'AUTO',
  v: 2,
  zoomOnClick: true,
};
const KC_SETTINGS = {};
// Donor: operator's hand-made export (QLklxuftEPP… "Quick Test", 2026-08-10).
const NOTE_SETTINGS = {
  paddingTop: 3,
  quotesInline: false,
  audioPosition: 'bottom',
  paddingBottom: 3,
  paddingLinked: true,
  markerColorContrast: 'AUTO',
  snippetColorContrast: 'AUTO',
};
const BUTTON_STACK_SETTINGS = {
  paddingTop: 3,
  quotesInline: false,
  paddingBottom: 3,
  paddingLinked: true,
  markerColorContrast: 'AUTO',
  snippetColorContrast: 'AUTO',
};
const VIDEO_SETTINGS = {
  accentColor: null,
  backgroundColor: null,
  backgroundType: 'ACCENT',
  cardMode: 'WHITE',
  customBackgroundColorContrast: 'AUTO',
  customPaddingBottom: 3,
  customPaddingLinked: false,
  customPaddingTop: 2,
  entranceAnimation: true,
  markerColorContrast: 'AUTO',
  paddingBottom: 3,
  paddingLinked: false,
  paddingTop: 2,
  snippetColorContrast: 'AUTO',
  v: 2,
};

function textBlock(mint: Mints, heading: string | undefined, paragraphsHtml: string): Block {
  if (heading !== undefined && heading !== '') {
    return {
      id: mint.cuid(),
      type: 'text',
      family: 'text',
      variant: 'heading paragraph',
      items: [
        {
          id: mint.cuid(),
          heading: `<strong>${escapeHtml(heading)}</strong>`,
          paragraph: paragraphsHtml,
        },
      ],
      settings: { ...TEXT_SETTINGS },
    };
  }
  return {
    id: mint.cuid(),
    type: 'text',
    family: 'text',
    variant: 'paragraph',
    items: [{ id: mint.cuid(), paragraph: paragraphsHtml }],
    settings: { ...TEXT_SETTINGS },
  };
}

/** Optional lead-in text block for interactives that carry heading/intro. */
function leadIn(mint: Mints, heading: string | undefined, intro: string[]): Block[] {
  if ((heading === undefined || heading === '') && intro.length === 0) return [];
  return [textBlock(mint, heading, intro.join(''))];
}

export interface MappedRow {
  blocks: Block[];
  notes: string[];
}

/** Map one planned block (intent) to its Rise block payload(s). */
export function mapIntent(intent: BlockIntent, mint: Mints): MappedRow {
  // Refuse any semantic block that is not explicitly enabled in the donor
  // registry. The switch below emits the donor shape; it never improvises one.
  riseTemplateFor(intent.kind);
  const notes: string[] = [];
  switch (intent.kind) {
    case 'text':
      return { blocks: [textBlock(mint, intent.heading, intent.paragraphs.join(''))], notes };

    case 'list': {
      const blocks = leadIn(mint, intent.heading, intent.intro);
      blocks.push({
        id: mint.cuid(),
        type: 'list',
        family: 'list',
        variant: intent.ordered ? 'numbered' : 'bulleted',
        items: intent.items.map((paragraph, i) => ({
          id: mint.cuid(),
          ...(intent.ordered ? { number: String(i + 1) } : {}),
          paragraph,
        })),
        settings: { ...LIST_SETTINGS },
      });
      if (intent.outro?.length) blocks.push(textBlock(mint, undefined, intent.outro.join('')));
      return { blocks, notes };
    }

    case 'accordion':
    case 'tabs': {
      const blocks = leadIn(mint, intent.heading, intent.intro);
      blocks.push({
        id: mint.cuid(),
        type: 'interactive',
        family: 'interactive',
        variant: intent.kind,
        items: intent.items.map((it) => ({
          id: mint.cuid(),
          title: it.title,
          description: it.body,
        })),
        settings: { ...INTERACTIVE_SETTINGS },
      });
      return { blocks, notes };
    }

    case 'flashcards': {
      const blocks = leadIn(mint, intent.heading, intent.intro);
      blocks.push({
        id: mint.cuid(),
        type: 'interactive',
        family: 'flashcard',
        variant: 'flashcard',
        items: intent.items.map((it) => ({
          id: mint.cuid(),
          front: { type: 'description', description: `<p>${escapeHtml(it.title)}</p>` },
          back: { type: 'description', description: it.body || `<p>${escapeHtml(it.title)}</p>` },
        })),
        settings: { ...FLASHCARD_SETTINGS },
      });
      return { blocks, notes };
    }

    case 'process': {
      // Process carries its own intro item — no separate lead-in text block.
      const items: Record<string, unknown>[] = [
        {
          id: mint.cuid(),
          type: 'intro',
          title: intent.heading ?? '',
          isHidden: false,
          description: intent.intro.join(''),
        },
        ...intent.items.map((it) => ({
          id: mint.cuid(),
          type: 'step',
          title: it.title,
          isHidden: false,
          description: it.body,
        })),
      ];
      return {
        blocks: [
          {
            id: mint.cuid(),
            type: 'interactive',
            family: 'interactive-fullscreen',
            variant: 'process',
            items,
            settings: { ...INTERACTIVE_SETTINGS },
          },
        ],
        notes,
      };
    }

    case 'timeline': {
      const blocks = leadIn(mint, intent.heading, intent.intro);
      blocks.push({
        id: mint.cuid(),
        type: 'interactive',
        family: 'interactive-fullscreen',
        variant: 'timeline',
        items: intent.events.map((e) => ({
          id: mint.cuid(),
          date: e.date,
          title: e.title,
          description: e.body,
        })),
        settings: { ...TIMELINE_SETTINGS },
      });
      return { blocks, notes };
    }

    case 'sorting': {
      const blocks = leadIn(mint, intent.heading, intent.intro);
      blocks.push({
        id: mint.cuid(),
        type: 'interactive',
        family: 'interactive-fullscreen',
        variant: 'sorting',
        piles: intent.piles.map((title, i) => ({ id: i + 1, title })),
        items: intent.cards.map((c) => ({
          id: mint.cuid(),
          title: c.title,
          pileId: c.pile,
        })),
        settings: { ...SORTING_SETTINGS },
      });
      return { blocks, notes };
    }

    case 'knowledge-check': {
      const blocks = leadIn(mint, intent.heading, intent.intro);
      for (const q of intent.questions) {
        const multi = q.options.filter((o) => o.correct).length > 1;
        blocks.push({
          id: mint.cuid(),
          type: 'knowledgeCheck',
          family: 'knowledgeCheck',
          variant: multi ? 'multiple response' : 'multiple choice',
          items: [
            {
              id: mint.uuid(),
              type: multi ? 'MULTIPLE_RESPONSE' : 'MULTIPLE_CHOICE',
              title: q.stem,
              answers: q.options.map((o) => ({
                id: mint.uuid(),
                title: `<p>${escapeHtml(o.text)}</p>`,
                correct: o.correct,
              })),
              ...(q.feedback ? { feedback: q.feedback } : {}),
            },
          ],
          settings: { ...KC_SETTINGS },
        });
      }
      return { blocks, notes };
    }

    case 'note':
      return {
        blocks: [
          {
            id: mint.cuid(),
            type: 'text',
            family: 'impact',
            variant: 'note',
            items: [{ id: mint.cuid(), paragraph: intent.paragraphs.join('') }],
            settings: { ...NOTE_SETTINGS },
          },
        ],
        notes,
      };

    case 'links': {
      const blocks = leadIn(mint, intent.heading, intent.intro);
      blocks.push({
        id: mint.cuid(),
        type: 'interactive',
        family: 'buttons',
        variant: 'button stack',
        items: intent.buttons.map((b) => ({
          id: mint.cuid(),
          type: 'link',
          label: b.label,
          description: b.description,
          destination: b.destination,
        })),
        settings: { ...BUTTON_STACK_SETTINGS },
      });
      if (intent.trailing?.length) {
        blocks.push(textBlock(mint, undefined, intent.trailing.join('')));
      }
      return { blocks, notes };
    }

    case 'video-placeholder':
      notes.push(
        'Tukšs video bloks (Rise dabiskais aizvietotājs) — donora forma bez tiešas nolasīšanas, pilots pārbauda',
      );
      return {
        blocks: [
          {
            id: mint.cuid(),
            type: 'multimedia',
            family: 'multimedia',
            variant: 'video',
            items: [{ id: mint.cuid() }],
            settings: { ...VIDEO_SETTINGS },
          },
        ],
        notes,
      };

    case 'storyline-placeholder':
      return {
        blocks: [
          textBlock(mint, undefined, `<p><strong>⚠ ${escapeHtml(intent.label)}</strong></p>`),
        ],
        notes,
      };

    case 'continue':
      // Donor: editor-created continue divider (capture_creation4aug) —
      // items[0] = {type:'', title, buttonColor:'brand', completeHint}.
      return {
        blocks: [
          {
            id: mint.cuid(),
            type: 'divider',
            family: 'continue',
            variant: 'continue',
            items: [
              {
                id: mint.cuid(),
                type: '',
                title: intent.label,
                buttonColor: 'brand',
                completeHint: 'Pabeidz augstāk esošo saturu, lai turpinātu.',
              },
            ],
            settings: { v: 2 },
          },
        ],
        notes,
      };

    case 'attachment-placeholder':
      return {
        blocks: [
          textBlock(mint, undefined, `<p><strong>📎 ${escapeHtml(intent.label)}</strong></p>`),
        ],
        notes,
      };
  }
}

export interface MappedBlockRecord {
  /** Rise block id (post-mapping). */
  blockId: string;
  slideNo: number | null;
  kind: BlockIntent['kind'];
}

export interface MappedLesson {
  title: string;
  blocks: Block[];
  /** Per-block origin (for the plan report). */
  records: MappedBlockRecord[];
  notes: string[];
}

/** Map a whole planned lesson. */
export function mapLesson(
  title: string,
  planned: BlueprintBlock[],
  mint: Mints,
): MappedLesson {
  const blocks: Block[] = [];
  const records: MappedBlockRecord[] = [];
  const notes: string[] = [];
  for (const pb of planned) {
    const mapped = mapIntent(pb.intent, mint);
    for (const b of mapped.blocks) {
      blocks.push(b);
      records.push({
        blockId: String(b.id),
        slideNo: pb.sourceRef.slideNo ?? null,
        kind: pb.intent.kind,
      });
    }
    for (const n of [...pb.notes, ...mapped.notes]) {
      const slide = pb.sourceRef.slideNo != null
        ? `slaids ${pb.sourceRef.slideNo}`
        : pb.sourceRef.row != null
          ? `rinda ${pb.sourceRef.row}`
          : pb.sourceRef.label;
      notes.push(`[${slide}] ${n}`);
    }
  }
  return { title, blocks, records, notes };
}
