// Phase 3 — import orchestration (panel-side). Reads a course out of the
// read-only archive, builds the plan, and runs it (dry or live) through the
// background's RELAY_WRITE, strictly sequential + human-paced. Persists a
// fidelity report + the resumable job log under `_import/`. The archive itself
// is never mutated (the immutable source of truth).

import {
  buildPlan,
  executePlan,
  buildFidelityReport,
  fidelityReportToJson,
  fidelityReportToMarkdown,
  checkSourceNotTarget,
  IdMap,
  findBankRef,
  type PlanInput,
  type AssetEntry,
  type SourceBank,
  type AccountIdentity,
  type FidelityReport,
  type Relay,
} from '@/core/import';
import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import type { Block } from '@/shared/types/rise';
import { rpc } from '../rpc';
import { unwrap, type ProgressEvent } from './shared';

/** The Relay the executor uses: one RELAY_WRITE round-trip to the background. */
const relayThroughTab: Relay = async (spec) => {
  const resp = await rpc({ type: 'RELAY_WRITE', spec });
  if (resp.type !== 'WRITE_RESULT') {
    return { ok: false, status: 0, text: '', error: 'unexpected background response' };
  }
  return resp.result;
};

/** Base64-encode bytes in chunks (avoids the call-stack limit of a single
 *  String.fromCharCode spread on large media). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Read the source account identity recorded in the archive manifest (for the
 *  Source ≠ Target guard). Older archives may not carry it. */
export async function readSourceIdentity(
  storage: Storage,
): Promise<AccountIdentity | undefined> {
  const raw = await storage.readManifest();
  if (!raw) return undefined;
  try {
    const m = JSON.parse(raw) as { sourceAccount?: AccountIdentity };
    return m.sourceAccount;
  } catch {
    return undefined;
  }
}

/** Map a course's saved asset manifest → plan AssetEntry[] (downloaded + orphan).
 *  `byKey` also yields the archive filename so we can read bytes for upload. */
async function readCourseAssets(
  storage: Storage,
  courseId: string,
): Promise<{ entries: AssetEntry[]; fileByKey: Map<string, string> }> {
  const raw = await storage.readAssetManifest('courses', courseId);
  const entries: AssetEntry[] = [];
  const fileByKey = new Map<string, string>();
  if (!raw) return { entries, fileByKey };
  try {
    const m = JSON.parse(raw) as {
      assets?: { key: string; kind: string; file: string; ext: string }[];
      failed?: { key: string; status?: number }[];
    };
    for (const a of m.assets ?? []) {
      entries.push({ key: a.key, kind: a.kind, file: a.file, ext: a.ext });
      fileByKey.set(a.key, a.file);
    }
    for (const f of m.failed ?? []) {
      // 403/404 ⇒ orphaned (deleted at source); other failures still block-less.
      entries.push({ key: f.key, kind: 'media-other', orphaned: true });
    }
  } catch {
    /* tolerate a malformed manifest — treat as no assets */
  }
  return { entries, fileByKey };
}

/** Collect the banks referenced by draw-from-bank blocks in a course doc. */
async function readReferencedBanks(
  storage: Storage,
  course: PlanInput['course'],
): Promise<Map<string, SourceBank>> {
  const ids = new Set<string>();
  for (const l of course.lessons ?? []) {
    for (const b of (l.items ?? []) as Block[]) {
      if (`${b.family}/${b.variant}` === 'knowledgeCheck/draw from question bank') {
        const { bankId } = findBankRef(b);
        if (bankId) ids.add(bankId);
      }
    }
  }
  const out = new Map<string, SourceBank>();
  for (const id of ids) {
    const raw = await storage.readQuestionBank(id);
    if (!raw) continue;
    try {
      const doc = JSON.parse(raw) as SourceBank;
      out.set(id, doc);
    } catch {
      /* skip unreadable bank */
    }
  }
  return out;
}

export interface ImportOptions {
  dryRun: boolean;
  /** Override the Source ≠ Target guard (same-account write). */
  override?: boolean;
  pacing?: PacingConfig;
  targetFolderId?: string | null;
}

export interface CourseImportOutcome {
  courseId: string;
  title?: string;
  report: FidelityReport;
}

export interface ImportRunResult {
  /** Set when the run was blocked before any write (guard failure). */
  blocked?: string;
  outcomes: CourseImportOutcome[];
}

/**
 * Run an import for the selected source course ids. Enforces the Source ≠ Target
 * guard once up front, then imports each course strictly sequentially. Persists
 * `_import/<courseId>.report.{md,json}` + `<courseId>.joblog.json` (resume map).
 */
export async function runImport(
  storage: Storage,
  courseIds: string[],
  target: AccountIdentity | undefined,
  opts: ImportOptions,
  onEvent: (e: ProgressEvent) => void,
): Promise<ImportRunResult> {
  const pacing = opts.pacing ?? DEFAULT_PACING;
  const outcomes: CourseImportOutcome[] = [];

  // Safe-import gate: never write into the source account (unless overridden).
  const source = await readSourceIdentity(storage);
  const verdict = checkSourceNotTarget(source, target, opts.override);
  if (!verdict.ok && !opts.dryRun) {
    onEvent({ kind: 'log', message: `BLOCKED: ${verdict.reason}` });
    return { blocked: verdict.reason, outcomes };
  }
  onEvent({
    kind: 'log',
    message: `${opts.dryRun ? 'DRY-RUN' : 'LIVE'} import → ${target?.name ?? 'unknown target'} (${verdict.reason})`,
  });

  for (const [i, courseId] of courseIds.entries()) {
    onEvent({ kind: 'course', index: i, total: courseIds.length, courseId });

    const raw = await storage.readCourse(courseId);
    if (!raw) {
      onEvent({ kind: 'log', message: `Skipped (not in archive): ${courseId}` });
      continue;
    }
    const course = unwrap(raw);
    const { entries, fileByKey } = await readCourseAssets(storage, courseId);
    const banksById = await readReferencedBanks(storage, course);

    const input: PlanInput = {
      course,
      assets: entries,
      banksById,
      author: target?.sub ?? 'unknown',
      targetFolderId: opts.targetFolderId ?? 'all',
    };
    const steps = buildPlan(input);

    // Resume: rehydrate a prior job log so a retry never double-creates.
    const priorLog = await storage.readImportArtifact(`${courseId}.joblog.json`);
    const ids = priorLog
      ? IdMap.fromJSON(JSON.parse(priorLog) as Record<string, string>)
      : new IdMap();

    const readAsset = async (sourceKey: string) => {
      const file = fileByKey.get(sourceKey);
      if (!file) return null;
      const name = file.replace(/^assets\//, '');
      const bytes = await storage.readAsset(name);
      if (!bytes) return null;
      const ext = name.split('.').pop() ?? '';
      return { base64: bytesToBase64(bytes), contentType: contentTypeForExt(ext) };
    };

    const res = await executePlan(steps, {
      input,
      relay: relayThroughTab,
      readAsset,
      ids,
      dryRun: opts.dryRun,
      pace: () => pacedDelay(pacing),
      log: (m) => onEvent({ kind: 'log', message: m }),
    });

    const report = buildFidelityReport(steps, res, courseId);
    // Persist outputs (never into the read-only archive dirs).
    await storage.writeImportArtifact(
      `${courseId}.report.md`,
      fidelityReportToMarkdown(report),
    );
    await storage.writeImportArtifact(
      `${courseId}.report.json`,
      fidelityReportToJson(report),
    );
    await storage.writeImportArtifact(
      `${courseId}.joblog.json`,
      JSON.stringify(res.idMap, null, 2),
    );

    outcomes.push({
      courseId,
      title: typeof course.course?.title === 'string' ? course.course.title : undefined,
      report,
    });
    onEvent({
      kind: 'log',
      message: res.ok
        ? `${opts.dryRun ? 'Planned' : 'Imported'} "${course.course?.title ?? courseId}" — ${report.planned.blocks} block(s), ${report.flags.length} flag(s)`
        : `FAILED "${course.course?.title ?? courseId}": ${res.error}`,
    });

    if (i < courseIds.length - 1) await pacedDelay(pacing);
  }

  return { outcomes };
}

const EXT_CT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

function contentTypeForExt(ext: string): string {
  return EXT_CT[ext.toLowerCase()] ?? 'application/octet-stream';
}
