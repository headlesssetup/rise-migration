// Storyboard phase 1 — the PlannedCourse intermediate format.
//
// The parser emits BLOCK INTENTS (what the storyboard asks for), never Rise
// JSON — mapping to real block payloads is phase 2 (`map.ts`). Every intent
// carries provenance back to the SD (rendered slide number + raw cell text) so
// the review UI and the production report can cite what the client sees.
// Anything the conventions engine cannot classify lands in `unparsed[]`,
// loudly — same posture as novelty review: nothing passes silently.

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

/** One item of an item-based interactive (accordion panel, tab, card, step). */
export interface IntentItem {
  title: string;
  /** Item body as sanitized HTML (`<p>…</p>` paragraphs). */
  body: string;
}

export interface KcOption {
  /** Option text (plain). */
  text: string;
  /** Green (`00B050`) in the SD = correct — official convention. */
  correct: boolean;
}

export interface KcQuestion {
  /** Question stem as HTML. */
  stem: string;
  options: KcOption[];
  /** Post-answer feedback as HTML (from the italic `Atgriezeniskā saite:`). */
  feedback?: string;
}

export type BlockIntent =
  | {
      kind: 'text';
      heading?: string;
      /** HTML paragraphs (links preserved as `<a href>`). */
      paragraphs: string[];
    }
  | {
      kind: 'list';
      ordered: boolean;
      heading?: string;
      intro: string[];
      /** List entries as HTML paragraphs. */
      items: string[];
      /** Prose after the list (rendered as a follow-up text block). */
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
  | {
      kind: 'note';
      /** HTML paragraphs. */
      paragraphs: string[];
    }
  | {
      /** Resource links row → a Rise button stack (one button per hyperlink). */
      kind: 'links';
      heading?: string;
      intro: string[];
      buttons: { label: string; destination: string; description: string }[];
      /** Prose after the last link (rendered as a follow-up text block). */
      trailing?: string[];
    }
  | {
      /** Rise's native empty video block — awaiting the expert recording. */
      kind: 'video-placeholder';
      /** e.g. "Eksperta video lekcija (~5 min) — Žaneta". */
      label: string;
    }
  | {
      /** Flagged text block: "replace with Storyline/Mighty, see slide N". */
      kind: 'storyline-placeholder';
      label: string;
    };

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
