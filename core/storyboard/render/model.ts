// SBDOC (Rise → docx storyboard) — the document model the renderer emits and
// the docx writer consumes. Format contract: docs/rise-storyboard-format.md.

/** One formatted text run (the SD-convention vocabulary: bold = item title,
 *  green `00B050` = correct answer, link = clickable). */
export interface SbRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** RRGGBB hex, uppercase (e.g. `00B050`). */
  color?: string;
  /** Hyperlink target URL. */
  link?: string;
}

export interface SbPara {
  runs: SbRun[];
  /** Real Word list membership (bullet / decimal numbering). */
  list?: 'bullet' | 'number';
  /** Indent level (720 twips per level) — item CONTENT under an item title in
   *  accordion-style blocks, so title vs content reads at a glance. */
  indent?: number;
}

/** `edit` = the storyboard pipeline can rebuild this family; `ro` = rendered
 *  for review only (shaded row; edits to it are conflicts, never merges). */
export type SbFidelity = 'edit' | 'ro';

/** A block's primary image reference (resolved to bytes at export time). */
export interface SbImage {
  /** Asset key from the archive (e.g. `rise/courses/…/abc.jpg`). */
  key: string;
  /** Original pixel dimensions (may be absent). */
  width?: number;
  height?: number;
}

export interface SbRow {
  /** 1-based ordinal within the lesson (literal text, never auto-numbering). */
  no: number;
  blockId: string;
  family: string;
  variant: string;
  /** Human label for the Block column. */
  label: string;
  fidelity: SbFidelity;
  content: SbPara[];
  /** Notes column: media chips, flags, demotion reasons. Free-form. */
  notes: string[];
  /** 8-hex FNV-1a of the block's archived JSON — change-detection hint. */
  rev: string;
  /** Primary image for this block (banner, text-aside, gallery hero, etc.). */
  image?: SbImage;
  /** Rendering hint for the prose writer. */
  prose?: 'impact' | 'continue' | 'divider';
}

export interface SbLesson {
  id: string;
  /** 1-based ordinal across the course. */
  no: number;
  title: string;
  type: string;
  rows: SbRow[];
  /** Lesson-level note (section marker, read-only lesson reason). */
  note?: string;
  /** Author-entered lesson description (rich HTML in the source), if any. */
  description?: SbPara[];
}

export interface SbCourse {
  courseId: string;
  title: string;
  /** The course cover "intro" text (`course.description`, rich HTML), if any. */
  description?: SbPara[];
  generatedAt: string;
  toolVersion: string;
  /** Materialized locale on a stack; null on a monolingual course. */
  locale: string | null;
  lessons: SbLesson[];
  /** Course-level warnings shown in the doc + the UI. */
  flags: string[];
  blockCount: number;
}

/** FNV-1a 32-bit over UTF-16 code units, as 8 hex chars. A cheap deterministic
 *  fingerprint for rev tokens and media chips — a HINT only; any real diff
 *  runs against the archive JSON itself. */
export function fnv1a8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
