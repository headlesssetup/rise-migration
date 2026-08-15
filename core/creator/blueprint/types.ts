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
      kind: 'accordion' | 'tabs' | 'flashcards' | 'process';
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
