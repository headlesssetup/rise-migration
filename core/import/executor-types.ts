// Phase 3 — executor TYPES + pure helpers, split out of executor.ts so the
// state-machine (executePlan) file stays focused and AI/human-readable. These are
// the injected-I/O contracts (Relay, ExecutorDeps), the result/flag shapes, the
// loud-fail error, and a few stateless helpers (JSON parsing, source indexing).
// Re-exported from ./executor so the public surface (@/core/import) is unchanged.

import type { GetCourseDocument, Lesson, Block } from '@/shared/types/rise';
import type { IdMap } from './ids';
import type { WriteSpec } from './envelopes';
import type { PlanStep, PlanInput } from './plan';
import type { Typeface } from './typefaces';

export interface RelayResponse {
  ok: boolean;
  status: number;
  text: string;
  error?: string;
}

export type Relay = (spec: WriteSpec) => Promise<RelayResponse>;

export interface AssetBytes {
  base64: string;
  contentType: string;
}

// MAX_UPLOAD_BASE64 (the upload size ceiling) is defined in ./plan and shared: the
// planner predicts overflow from the manifest size; this executor backstops it on
// the actual base64 length (unknown-size assets). The S3 PUT goes direct from the
// panel (no 64MB message hop), so the ceiling is memory, not messaging.

export interface ExecutorDeps {
  input: PlanInput;
  relay: Relay;
  /** Resolve a source media key to its archived bytes (base64) + content-type. */
  readAsset: (sourceKey: string) => Promise<AssetBytes | null>;
  /** Source account typefaces (parsed from account/typefaces.json), keyed by id.
   *  When provided, the import migrates fonts (match-by-name + recreate custom);
   *  otherwise it falls back to a plain theme round-trip. */
  sourceTypefaces?: Map<string, Typeface>;
  /** TARGET account typefaces (FETCH_TYPEFACES on a *live existing* course),
   *  fetched once by the orchestrator. Used to match by name + dedup recreation.
   *  We can't FETCH_TYPEFACES on the brand-new course (404 until it settles),
   *  so this must be pre-fetched against an existing target course. */
  targetTypefaces?: Map<string, Typeface>;
  /** source typeface id → target typeface id, pre-resolved by the account-settings
   *  step (A): all fonts already matched-by-name + custom ones recreated. When a
   *  course's typeface id is seeded here, set-theme reuses it (no per-course font
   *  upload); ids NOT seeded fall back to in-loop resolve/recreate. */
  typefaceIdMap?: Map<string, string>;
  /** Read a custom font's archived `.woff` bytes by its source key. */
  readFontBytes?: (fontKey: string) => Promise<AssetBytes | null>;
  ids?: IdMap;
  /** Human-paced gap between writes (no-op in tests). */
  pace?: () => Promise<void>;
  log?: (msg: string) => void;
  dryRun?: boolean;
  mintId?: () => string;
  /** Poll budget for transcode CHECK_STATUS (default a few tries). */
  maxStatusPolls?: number;
  /** Retries for the post-create GET_COURSE handshake (default 3), each preceded by
   *  a paced gap — a few seconds of slack so a just-created course is confirmed
   *  before any write even under replication lag. */
  courseHandshakeTries?: number;
  onProgress?: (done: number, total: number) => void;
  /** Cooperative cancel: checked at the top of each step (after the in-flight
   *  write fully finished — never mid-write). When it returns true the executor
   *  stops issuing further steps and returns cleanly with `stopped: true` and the
   *  partial id-map, so the course stays resumable (no rollback). */
  shouldStop?: () => boolean;
}

export interface ManualFlag {
  kind:
    | 'storyline'
    | 'draw-from-bank'
    | 'orphan-media'
    | 'unsupported-media'
    | 'missing-bank-ref'
    | 'orphan-bank'
    | 'title'
    | 'typeface';
  sourceBlockId?: string;
  sourceKey?: string;
  detail: string;
}

/** Group manual-handling flags by kind into a compact summary, e.g.
 *  "5 unsupported-media, 2 storyline". */
export function summarizeFlags(flags: ManualFlag[]): string {
  const counts = new Map<string, number>();
  for (const f of flags) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${kind}`)
    .join(', ');
}

export interface ExecResult {
  ok: boolean;
  dryRun: boolean;
  /** Every envelope that was (or would be) sent, in order — the dry-run plan. */
  envelopes: { step: PlanStep['kind']; label: string }[];
  flags: ManualFlag[];
  /** The resumable old→new id map (job log). */
  idMap: Record<string, string>;
  /** New course id once the shell is created. */
  newCourseId?: string;
  /** Always false now — automatic deletion is disabled (operator decision: no
   *  delete actions fire automatically until deletion is better researched).
   *  Retained for back-compat with readers that inspect it. */
  rolledBack?: boolean;
  /** A created course shell that was left in place (NOT deleted) because the
   *  import failed before the GET_COURSE handshake confirmed it. Reported so the
   *  operator can delete it manually if they choose. */
  orphanedCourseId?: string;
  /** Set when the run was cooperatively stopped (Stop button) mid-course. The
   *  partial course is kept and is resumable via the persisted job log. */
  stopped?: boolean;
  /** Surviving source media keys (must be empty on success). */
  survivingKeys: string[];
  error?: string;
}

/** Thrown on a loud-fail; carries the offending step + raw response. */
export class WriteError extends Error {
  constructor(
    message: string,
    readonly step: PlanStep['kind'],
    readonly raw?: string,
  ) {
    super(message);
    this.name = 'WriteError';
  }
}

export function parseJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function payloadOf(obj: Record<string, unknown>): Record<string, unknown> {
  const p = obj.payload;
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : obj;
}

/** Build source-id → object indexes once, so steps resolve their source doc. */
export function indexSource(course: GetCourseDocument): {
  lessons: Map<string, Lesson>;
  blocks: Map<string, { block: Block; lessonId: string }>;
} {
  const lessons = new Map<string, Lesson>();
  const blocks = new Map<string, { block: Block; lessonId: string }>();
  for (const l of course.lessons ?? []) {
    const lid = typeof l.id === 'string' ? l.id : '';
    if (lid) lessons.set(lid, l);
    for (const b of (l.items ?? []) as Block[]) {
      const bid = typeof b.id === 'string' ? b.id : '';
      if (bid) blocks.set(bid, { block: b, lessonId: lid });
    }
  }
  return { lessons, blocks };
}

/** A minimal author profile for authoring locks / bank PUT lock_data. */
export function authorProfile(author: string): Record<string, unknown> {
  return { user_id: author, staff: false, content_team_admin: false };
}
