// Storyboard phase 1 — the PlannedCourse intermediate format.
//
// The parser emits BLOCK INTENTS (what the storyboard asks for), never Rise
// JSON — mapping to real block payloads is phase 2 (`map.ts`). Every intent
// carries provenance back to the SD (rendered slide number + raw cell text) so
// the review UI and the production report can cite what the client sees.
// Anything the conventions engine cannot classify lands in `unparsed[]`,
// loudly — same posture as novelty review: nothing passes silently.

import type {
  BlockIntent,
  IntentItem,
  KcOption,
  KcQuestion,
} from '@/core/creator/blueprint';

export type { BlockIntent, IntentItem, KcOption, KcQuestion } from '@/core/creator/blueprint';

/** Where a block came from in the SD. `slideNo` is the RENDERED auto-number
 *  (computed from Word's numbering, never the table row index — the two
 *  diverge when a row holds several numbered paragraphs). */
export interface Provenance {
  slideNo: number | null;
  /** 0-based row index within the storyboard table (internal diagnostics). */
  tableRow: number;
  /** `Mācību pieredze` cell, verbatim. */
  experience: string;
  /** `Komentāri` cell, verbatim. */
  comments: string;
  /** `Teksts uz ekrāna` cell as plain text (for the review UI side-by-side). */
  rawScreenText: string;
}

export interface PlannedBlock {
  intent: BlockIntent;
  provenance: Provenance;
  /** Review-facing notes: dropped buttons, designer remarks, fallbacks taken. */
  notes: string[];
}

export interface PlannedLesson {
  /** Divider-row text verbatim (e.g. `Tēma 1.1.1: …`). */
  title: string;
  blocks: PlannedBlock[];
}

/** A row the conventions engine refused to classify — surfaced loudly in the
 *  review UI; importing skips it only after explicit operator acknowledgement. */
export interface UnparsedRow {
  provenance: Provenance;
  reason: string;
}

/** One filming-script entry (the `Audio teksts` column) — production material
 *  for the film crew, NEVER course content. */
export interface ProductionItem {
  lesson: string;
  slideNo: number | null;
  experience: string;
  audioText: string;
}

export interface PlannedCourse {
  /** Course title = the SD's Heading1 (whole doc = one course). */
  title: string;
  lessons: PlannedLesson[];
  unparsed: UnparsedRow[];
  production: ProductionItem[];
}

export class StoryboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoryboardError';
  }
}
