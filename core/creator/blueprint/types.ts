/**
 * Provider-neutral course plan. Parsers and (later) AI providers may produce
 * this shape; only the deterministic Rise compiler may turn it into Rise JSON.
 */

import type { LocalAssetRef } from '@/core/local-assets';
export type { LocalAssetRef } from '@/core/local-assets';

export const COURSE_BLUEPRINT_FORMAT = 'rise-course-blueprint' as const;
export const COURSE_BLUEPRINT_VERSION = 1 as const;

export interface BlueprintSource {
  kind: 'intea-storyboard' | 'ai-provider';
  originalFileName?: string;
  provider?: string;
  model?: string;
}

/** Human-readable provenance. It is diagnostic metadata, never Rise content. */
export interface BlueprintSourceRef {
  label: string;
  slideNo?: number | null;
  row?: number;
  excerpt?: string;
}

/** One item of an item-based interactive (accordion panel, tab, card, step). */
export interface IntentItem {
  title: string;
  /** Item body as sanitized HTML (`<p>…</p>` paragraphs). */
  body: string;
}

export interface KcOption {
  text: string;
  correct: boolean;
  feedback?: string;
}

export interface KcQuestion {
  stem: string;
  options: KcOption[];
  feedback?: string;
}

export interface FillInQuestion {
  /** Sentence/question as sanitized HTML; the gap may be written as `_____`. */
  stem: string;
  /** Accepted answers (plain text, any one counts as correct). */
  answers: string[];
  feedback?: string;
}

/**
 * Semantic block vocabulary accepted by the deterministic compiler. It does
 * not expose raw Rise JSON fields, donor settings, ids, or media keys.
 */
export type BlockIntent =
  | { kind: 'text'; heading?: string; paragraphs: string[] }
  | {
      kind: 'list';
      ordered: boolean;
      heading?: string;
      intro: string[];
      items: string[];
      outro?: string[];
    }
  | {
      /** `labeled-graphic`: each item is one marker (title = short label,
       *  body = its popup text) on the built-in placeholder image; positions
       *  are compiler-generated. */
      kind: 'accordion' | 'tabs' | 'flashcards' | 'process' | 'labeled-graphic';
      heading?: string;
      intro: string[];
      items: IntentItem[];
    }
  | {
      kind: 'timeline';
      heading?: string;
      intro: string[];
      events: { date: string; title: string; body: string }[];
    }
  | {
      kind: 'sorting';
      heading?: string;
      intro: string[];
      piles: string[];
      cards: { title: string; pile: number }[];
    }
  | {
      kind: 'knowledge-check';
      heading?: string;
      intro: string[];
      questions: KcQuestion[];
    }
  | {
      /** One Rise fill-in block per question; `answers` = accepted typed answers. */
      kind: 'fill-in-the-blank';
      heading?: string;
      intro: string[];
      questions: FillInQuestion[];
    }
  | {
      /** One Rise matching block: `pairs[].left` is the draggable, `right` its match. */
      kind: 'matching';
      heading?: string;
      intro: string[];
      stem: string;
      pairs: { left: string; right: string }[];
      feedback?: string;
    }
  | {
      /** `text/table` — one header row + body rows; every row has columns.length cells. */
      kind: 'table';
      heading?: string;
      intro: string[];
      columns: string[];
      rows: string[][];
    }
  | { kind: 'note'; paragraphs: string[] }
  | {
      kind: 'links';
      heading?: string;
      intro: string[];
      buttons: { label: string; destination: string; description: string }[];
      trailing?: string[];
    }
  | { kind: 'video-placeholder'; label: string }
  | { kind: 'storyline-placeholder'; label: string }
  | { kind: 'continue'; label: string }
  | { kind: 'attachment-placeholder'; label: string };

export interface BlueprintBlock {
  intent: BlockIntent;
  sourceRef: BlueprintSourceRef;
  notes: string[];
  /** Content fidelity. Absent or 'source' = taken from the source document as
   *  written; 'suggested' = invented or rephrased by the provider and must be
   *  visibly distinguished for review (docs/creator-ai-design.md). */
  origin?: 'source' | 'suggested';
}

export interface BlueprintLesson {
  title: string;
  blocks: BlueprintBlock[];
}

export interface BlueprintUnresolvedItem {
  sourceRef: BlueprintSourceRef;
  reason: string;
}

export interface BlueprintProductionItem {
  kind: 'narration';
  lesson: string;
  sourceRef: BlueprintSourceRef;
  text: string;
}

export interface CourseBlueprint {
  format: typeof COURSE_BLUEPRINT_FORMAT;
  formatVersion: typeof COURSE_BLUEPRINT_VERSION;
  source: BlueprintSource;
  title: string;
  lessons: BlueprintLesson[];
  /** Assets returned by a provider and saved beside the blueprint/package. */
  assets: LocalAssetRef[];
  unresolved: BlueprintUnresolvedItem[];
  production: BlueprintProductionItem[];
}

export type BlockIntentKind = BlockIntent['kind'];
