// Phase 3 — import-run TYPES + pure helpers, split out of ./import (v0.9.16b)
// so the orchestration loop stays under the file-size cap. These are the
// operator-facing run contracts (ImportOptions, CourseStatus, outcome/result
// shapes) and the two stateless helpers the loop uses per course: the "refused
// to start" ExecResult and the prior-report parser for resume. Re-exported from
// ./import so the public surface (orchestrator/index) is unchanged.

import type { PacingConfig } from '@/core/pacing/delay';
import {
  READ_BACK_POLICY_VERSION,
  type ExecResult,
  type FidelityReport,
  type ManualWorkItem,
  type ParityReport,
} from '@/core/import';

export interface ImportOptions {
  dryRun: boolean;
  /** Override the Source ≠ Target guard (same-account write). */
  override?: boolean;
  pacing?: PacingConfig;
  targetFolderId?: string | null;
  /** Recreate referenced question banks + bind draw-from-bank blocks. Default
   *  OFF — draw-from-bank blocks become unbound placeholders (manual). */
  recreateBanks?: boolean;
  /** "Re-create folders" checkbox. ON → create the folder chains of the
   *  SELECTED courses on the target (deduped by name+parent against the live
   *  target tree, so folders from the account-settings step or a prior run are
   *  reused, never duplicated) and place each course into its folder. OFF
   *  (default) → nothing is created or moved; courses land in the root. */
  recreateFolders?: boolean;
  /** Recreate typefaces SHARED IN from another tenant (archived as `foreign`).
   *  Default OFF → flagged as manual work (someone else's font: licensing). */
  rehostForeignTypefaces?: boolean;
  /** "Interface language" select: ISO 639-1 code of the built-in label set to
   *  bind on courses whose source names none (`labelSetId: ""` resolves to an
   *  account default the export cannot see). Empty → leave the target default. */
  defaultLabelLanguage?: string;
  /** Cooperative cancel for the Stop button. Polled between courses and (via the
   *  executor) between paced write steps — never mid-write. */
  shouldStop?: () => boolean;
}

/** Per-course outcome status for the run summary / outcome table. */
export type CourseStatus =
  | 'planned' // dry-run
  | 'imported' // live, fully imported + (where applicable) parity-checked
  | 'partial' // live, confirmed course but failed mid-build — resumable on re-run
  | 'stopped' // live, halted by Stop mid-course — resumable on re-run
  | 'failed'; // live, failed before/at confirmation (orphan shell left in place)

export interface CourseImportOutcome {
  courseId: string;
  title?: string;
  status: CourseStatus;
  report: FidelityReport;
  /** A created-but-unconfirmed course shell left on the target (no auto-delete). */
  orphanedCourseId?: string;
  /** Read-back parity (live runs only): GET_COURSE the new course + diff vs source. */
  parity?: ParityReport;
}

export interface ImportRunResult {
  /** Set when the run was blocked before any write (guard failure). */
  blocked?: string;
  outcomes: CourseImportOutcome[];
  /** True when the run was halted early by the Stop button. */
  stopped?: boolean;
  /** Course ids that were queued but never started (Stop pressed before them). */
  notStarted?: string[];
}

/** A course we refuse to start (missing media of unknown state, …): a real
 *  failed outcome, never a silent skip. */
export function abortedResult(error: string): ExecResult {
  return { ok: false, dryRun: false, envelopes: [], flags: [], idMap: {}, survivingKeys: [], error };
}

/** What a persisted `<courseId>.report.json` tells us on a re-run. */
export interface PriorCourseReport {
  report: FidelityReport;
  parity?: ParityReport;
  manual: ManualWorkItem[];
  idMap?: Record<string, string>;
  /** Whether this report proves completion under the current parity contract. */
  currentReadBackPolicy: boolean;
  /** A FINISHED live import: ok, not stopped, with a real target course id. */
  completed: boolean;
}

export function parsePriorReport(raw: string | null | undefined): PriorCourseReport | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as FidelityReport & {
      readBackPolicyVersion?: number;
      parity?: ParityReport | null;
      manualWork?: ManualWorkItem[];
      idMap?: Record<string, string>;
    };
    const currentReadBackPolicy = p.readBackPolicyVersion === READ_BACK_POLICY_VERSION;
    return {
      report: p,
      parity: p.parity ?? undefined,
      manual: p.manualWork ?? [],
      idMap: p.idMap,
      currentReadBackPolicy,
      completed:
        currentReadBackPolicy &&
        p.ok === true &&
        p.dryRun === false &&
        !p.stopped &&
        typeof p.newCourseId === 'string' &&
        !!p.newCourseId,
    };
  } catch {
    return null; // corrupt report — treat as no prior run
  }
}
