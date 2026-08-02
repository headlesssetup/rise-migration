// "Ready to import?" — a deliberately ROUGH pre-run time estimate, computed
// from the plan (pure, no network). The honest unit is the paced write
// envelope: every authoring call costs ~one pacing gap (~1.6 s) plus HTTP
// time; uploads add S3 transfer time; a stack conversion adds a fixed AI-wait
// allowance. Displayed before a live run so the operator can decide whether to
// start a multi-hour batch now.

import { DEFAULT_PACING } from '@/core/pacing/delay';
import type { AssetEntry, PlanStep } from './plan';

/** Rough per-envelope HTTP overhead on top of the pacing gap (seconds). */
const HTTP_OVERHEAD_S = 0.5;
/** Rough S3 throughput for asset byte transfers (bytes/second). */
const S3_THROUGHPUT_BPS = 1.5 * 1024 * 1024;
/** Fixed allowance for one stack's AI conversion wait (seconds) — captures
 *  showed 15–70 s per language on a minimal course; polling is paced. */
const STACK_AWAIT_S = 90;

/** How many paced authoring envelopes a step costs (rough). */
function pacedEnvelopes(step: PlanStep): number {
  switch (step.kind) {
    case 'create-course':
      return 2; // POST /content + GET_COURSE handshake
    case 'create-bank':
    case 'put-bank':
    case 'create-lesson':
    case 'update-lesson':
    case 'create-blocks':
    case 'set-theme':
    case 'set-title':
    case 'set-course-description':
    case 'patch-block-media':
    case 'bind-draw-from-bank':
    case 'convert-stack':
    case 'write-l10n':
    case 'cleanup-l10n':
      return 1;
    case 'set-course-images':
      return 1; // + its uploads are separate GET_YURLs below
    case 'upload-asset':
    case 'upload-lesson-media':
    case 'upload-l10n-asset':
      return 1; // GET_YURL is paced; the S3 PUT itself is byte-time (below)
    case 'attach-storyline':
      return 2; // copy_review_item + media patch
    case 'attach-storyline-l10n':
      return 2; // copy_review_item + the storyline cell write (per language)
    case 'set-locale-labelset':
      return 3; // CREATE_LABEL_SET + UPDATE_LABELS + UPDATE_LOCALE
    case 'set-stack-titles':
      return 2; // ~one small batch per locale; call it two envelopes
    default:
      return 0; // flags, lock/unlock (unused), await-stack (allowance below)
  }
}

export interface ImportEstimate {
  seconds: number;
  envelopes: number;
  uploadBytes: number;
  stacks: number;
}

/**
 * Rough wall-clock estimate for ONE course's plan. `assets` supplies byte sizes
 * for the upload steps (unknown sizes cost only their envelope).
 */
export function estimateImportSeconds(
  steps: PlanStep[],
  assets: AssetEntry[] = [],
): ImportEstimate {
  const sizeByKey = new Map(assets.map((a) => [a.key, a.size ?? 0]));
  let envelopes = 0;
  let uploadBytes = 0;
  let stacks = 0;
  for (const step of steps) {
    envelopes += pacedEnvelopes(step);
    if (
      step.kind === 'upload-asset' ||
      step.kind === 'upload-lesson-media' ||
      step.kind === 'upload-l10n-asset'
    ) {
      uploadBytes += sizeByKey.get(step.sourceKey) ?? 0;
    }
    if (step.kind === 'await-stack') stacks = 1;
  }
  const perEnvelope = DEFAULT_PACING.baseMs / 1000 + HTTP_OVERHEAD_S;
  const seconds = Math.round(
    envelopes * perEnvelope + uploadBytes / S3_THROUGHPUT_BPS + stacks * STACK_AWAIT_S,
  );
  return { seconds, envelopes, uploadBytes, stacks };
}

/** Sum per-course estimates into a run total. */
export function sumEstimates(list: ImportEstimate[]): ImportEstimate {
  return list.reduce(
    (acc, e) => ({
      seconds: acc.seconds + e.seconds,
      envelopes: acc.envelopes + e.envelopes,
      uploadBytes: acc.uploadBytes + e.uploadBytes,
      stacks: acc.stacks + e.stacks,
    }),
    { seconds: 0, envelopes: 0, uploadBytes: 0, stacks: 0 },
  );
}

/** "~2 h 15 m" / "~40 min" / "~90 s" — deliberately imprecise formatting. */
export function formatEstimate(seconds: number): string {
  if (seconds < 120) return `~${Math.max(10, Math.round(seconds / 10) * 10)} s`;
  const mins = Math.round(seconds / 60);
  if (mins < 90) return `~${mins} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round((mins % 60) / 5) * 5;
  return m > 0 ? `~${h} h ${m} m` : `~${h} h`;
}
