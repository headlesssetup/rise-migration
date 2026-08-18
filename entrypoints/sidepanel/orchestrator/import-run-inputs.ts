// Import run INPUTS: everything that reads the archive before/without writing —
// asset coverage checks, the per-course archive readers, the pre-run time
// estimate, and the inventory folder map. Split out of ./import (v0.9.0
// restructure; ./import re-exports the public names, so the orchestrator
// barrel and ImportView are unchanged).

import { isLocalizedStack } from '@/core/l10n';
import {
  collectAssetKeys,
  isOrphanStatus,
  type AssetFailure,
  type OptionalAssetReason,
} from '@/core/assets';
import {
  blockKey,
  buildPlan,
  estimateImportSeconds,
  findBankRef,
  sumEstimates,
  type AssetEntry,
  type ImportEstimate,
  type PlanInput,
  type SourceBank,
} from '@/core/import';
import { isKnownLegacyStorylineMeta } from '@/core/storyline/compatibility';
import type { Storage } from '@/core/storage/storage';
import type { Block, GetCourseDocument } from '@/shared/types/rise';
import { unwrap, type ProgressEvent } from './shared';
import type { StorylineManifestEntry } from './storyline';

/**
 * Media keys a course's document references that the archive has NO bytes for
 * (and that are not recorded as terminal orphans). The usual cause is simply
 * that "Download assets" was never run for this archive — in which case the
 * import would create the course, convert the stack, and only then die on the
 * first upload, leaving a partial to clean up. Cheap to check up front.
 */
export function missingAssetKeys(
  doc: unknown,
  courseId: string,
  entries: {
    key: string;
    file?: string;
    orphaned?: boolean;
    optionalUnavailable?: boolean;
  }[],
): string[] {
  const have = new Set(
    entries
      .filter((e) => e.file || e.orphaned || e.optionalUnavailable)
      .map((e) => e.key),
  );
  const missing = new Set<string>();
  for (const k of collectAssetKeys(doc, courseId)) {
    if (!have.has(k.key)) missing.add(k.key);
  }
  return [...missing];
}

/**
 * Split a manifest's `failed` list into the three states the import must treat
 * differently. A required 403/404 is blanked + manually flagged. A typed
 * optional 403/404 is blanked without a flag. Anything else (500, network, 0)
 * is UNKNOWN and blocks import rather than silently discarding possible media.
 */
export function classifyAssetFailures(
  failed:
    | {
        key: string;
        status?: number;
        error?: string;
        optionalReason?: OptionalAssetReason;
      }[]
    | undefined,
): {
  orphans: { key: string; status?: number }[];
  optional: {
    key: string;
    status?: number;
    optionalReason: OptionalAssetReason;
  }[];
  unresolved: { key: string; status?: number; error?: string }[];
} {
  const orphans: { key: string; status?: number }[] = [];
  const optional: {
    key: string;
    status?: number;
    optionalReason: OptionalAssetReason;
  }[] = [];
  const unresolved: { key: string; status?: number; error?: string }[] = [];
  for (const f of failed ?? []) {
    if (isOrphanStatus(f.status) && f.optionalReason) {
      optional.push({
        key: f.key,
        status: f.status,
        optionalReason: f.optionalReason,
      });
    } else if (isOrphanStatus(f.status)) orphans.push({ key: f.key, status: f.status });
    else unresolved.push({ key: f.key, status: f.status, error: f.error });
  }
  return { orphans, optional, unresolved };
}

/** Map a course's saved asset manifest → plan AssetEntry[] (downloaded + terminal).
 *  `fileByKey` also yields the archive filename so we can read bytes for upload.
 *  `unresolved` lists keys whose bytes are missing for a NON-terminal reason. */
export async function readCourseAssets(
  storage: Storage,
  courseId: string,
): Promise<{
  entries: AssetEntry[];
  fileByKey: Map<string, string>;
  unresolved: { key: string; status?: number; error?: string }[];
}> {
  const raw = await storage.readAssetManifest('courses', courseId);
  const entries: AssetEntry[] = [];
  const fileByKey = new Map<string, string>();
  const unresolved: { key: string; status?: number; error?: string }[] = [];
  if (!raw) return { entries, fileByKey, unresolved };
  try {
    const m = JSON.parse(raw) as {
      assets?: { key: string; kind: string; file: string; ext: string; size?: number }[];
      failed?: {
        key: string;
        status?: number;
        error?: string;
        optionalReason?: OptionalAssetReason;
      }[];
    };
    for (const a of m.assets ?? []) {
      entries.push({ key: a.key, kind: a.kind, file: a.file, ext: a.ext, size: a.size });
      fileByKey.set(a.key, a.file);
    }
    // Terminal orphans are imported as block-less (flagged) keys; anything else
    // aborts the course in runImport rather than dropping media as "deleted".
    const split = classifyAssetFailures(m.failed);
    for (const f of split.orphans) entries.push({ key: f.key, kind: 'media-other', orphaned: true });
    for (const f of split.optional) {
      entries.push({
        key: f.key,
        kind: 'media-other',
        optionalUnavailable: true,
        optionalReason: f.optionalReason,
      });
    }
    unresolved.push(...split.unresolved);
  } catch {
    /* tolerate a malformed manifest — treat as no assets */
  }
  return { entries, fileByKey, unresolved };
}

/** Build the storyline attach map for a source course from its storyline
 *  manifest: `blockKey(lessonId, blockId)` → {reviewPrefix, meta, title}, but
 *  ONLY for blocks whose package has been uploaded
 *  (manifest.uploads[leaf].reviewPrefix exists). Blocks without an uploaded
 *  package are left to the manual flag path. Keyed by LESSON + BLOCK id —
 *  block ids are client-generated and real courses reuse them across lessons
 *  (the v0.6.3 collision class), so a blockId-only key would attach the same
 *  package to every same-id block. */
export async function readStorylineAttach(
  storage: Storage,
  courseId: string,
): Promise<
  | {
      /** Monolingual: blockKey(lessonId, blockId) → the uploaded package. */
      byBlock: Map<string, { reviewPrefix: string; meta?: unknown; title?: string }>;
      /** STACK (docs/rise-multilang.md §4.3b): `${blockKey}|${locale}` →
       *  package, one per language (each language can carry its own bundle). */
      byBlockLocale: Map<
        string,
        { locale: string; l10nId?: string; reviewPrefix: string; meta?: unknown; title?: string }
      >;
    }
  | undefined
> {
  const raw = await storage.readStorylineManifest(courseId);
  if (!raw) return undefined;
  try {
    const m = JSON.parse(raw) as {
      blocks?: Array<{
        blockId: string;
        lessonId?: string;
        leaf?: string;
        meta?: unknown;
        compatibility?: 'automatic' | 'legacy-unsupported' | 'source-placeholder';
        locale?: string;
        l10nId?: string;
      }>;
      uploads?: Record<string, { reviewPrefix?: string }>;
    };
    const byBlock = new Map<string, { reviewPrefix: string; meta?: unknown; title?: string }>();
    const byBlockLocale = new Map<
      string,
      { locale: string; l10nId?: string; reviewPrefix: string; meta?: unknown; title?: string }
    >();
    for (const b of m.blocks ?? []) {
      // Legacy packages may exist in pre-policy manifests and may even have a
      // stale upload record from an `unpackFailed` Review item. They must never
      // reach copy_review_item; the planner inserts the explicit placeholder.
      if (
        b.compatibility === 'legacy-unsupported' ||
        isKnownLegacyStorylineMeta(b.meta)
      ) continue;
      if (!b.leaf) continue;
      const reviewPrefix = m.uploads?.[b.leaf]?.reviewPrefix;
      if (!reviewPrefix) continue;
      // Every manifest since Stage D records lessonId; an entry without one
      // cannot be joined safely, so it's skipped here and the plan flags that
      // block for manual attach (loud in the report, never a wrong attach).
      if (!b.lessonId) continue;
      const key = blockKey(b.lessonId, b.blockId);
      const title =
        b.meta && typeof b.meta === 'object' ? (b.meta as { title?: string }).title : undefined;
      if (b.locale) {
        byBlockLocale.set(`${key}|${b.locale}`, {
          locale: b.locale,
          l10nId: b.l10nId,
          reviewPrefix,
          meta: b.meta,
          title,
        });
      } else {
        byBlock.set(key, { reviewPrefix, meta: b.meta, title });
      }
    }
    return byBlock.size || byBlockLocale.size ? { byBlock, byBlockLocale } : undefined;
  } catch {
    return undefined;
  }
}

/** Collect the banks referenced by draw-from-bank blocks in a course doc. */
export async function readReferencedBanks(
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

/**
 * Run an import for the selected source course ids. Enforces the Source ≠ Target
 * guard once up front, then imports each course strictly sequentially. Persists
 * `_import/<courseId>.report.{md,json}` + `<courseId>.joblog.json` (resume map).
 */
/** "Ready to import?" — rough pre-run estimate for the selected courses.
 *  Local only (archive reads + pure buildPlan; no network, no ids minted).
 *  Returns per-course estimates + the language count so the UI can show
 *  "N courses (M multi-language), ~X min (rough)". */
export async function estimateCourses(
  storage: Storage,
  courseIds: string[],
): Promise<{
  estimate: ImportEstimate;
  stacks: number;
  missing: number;
  /** Archived but unusable: the course read/plan threw (a malformed archive or
   *  a plan-level refusal) — distinct from `missing` (not in the archive). */
  unreadable: number;
}> {
  const per: ImportEstimate[] = [];
  let stacks = 0;
  let missing = 0;
  let unreadable = 0;
  for (const courseId of courseIds) {
    const raw = await storage.readCourse(courseId);
    if (!raw) {
      missing++;
      continue;
    }
    try {
      const course = unwrap(raw);
      if (isLocalizedStack(course)) stacks++;
      const { entries } = await readCourseAssets(storage, courseId);
      const steps = buildPlan({
        course,
        assets: entries,
        banksById: new Map(),
        author: 'estimate',
      });
      per.push(estimateImportSeconds(steps, entries));
    } catch {
      unreadable++;
    }
  }
  return { estimate: sumEstimates(per), stacks, missing, unreadable };
}

/** Course id → source folderId, from `_metadata/inventory.json`. */
export async function readCourseFolders(storage: Storage): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const raw = await storage.readInventory();
  if (!raw) return m;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : ((parsed as { items?: unknown[] }).items ?? []);
    for (const r of rows as Record<string, unknown>[]) {
      if (typeof r.id === 'string' && typeof r.folderId === 'string' && r.folderId) {
        m.set(r.id, r.folderId);
      }
    }
  } catch {
    /* tolerate */
  }
  return m;
}
