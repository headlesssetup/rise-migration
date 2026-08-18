// Import-plan TYPES: PlanInput, the 33-variant PlanStep union, and the upload
// size limits — split out of plan.ts (v0.9.0 restructure; plan.ts re-exports
// this surface, so './plan' and the barrel are unchanged). The PlanStep union
// is the protocol-ordered write vocabulary (docs/rise-import-protocol.md §1);
// a cohesive protocol module under the ~700-line allowance.

import type { OptionalAssetReason } from '@/core/assets/keys';
import type { GetCourseDocument } from '@/shared/types/rise';

export interface AssetEntry {
  key: string;
  kind: string;
  /** Archive path `assets/<hash>.<ext>` — absent for orphaned keys. */
  file?: string;
  ext?: string;
  /** Raw byte size (from the asset manifest) — used to PREDICT the relay-cap
   *  overflow in the plan (so a dry-run preview flags oversized media too). */
  size?: number;
  /** 403/404 at source (assets-summary `orphaned`): no bytes to upload. */
  orphaned?: boolean;
  /** Unavailable non-rendering source/provenance bytes. Silently blanked. */
  optionalUnavailable?: boolean;
  optionalReason?: OptionalAssetReason;
}

/** Upload size ceiling (as base64 length). The S3 PUT now goes DIRECT from the
 *  side panel (host_permissions exempt it from CORS), so the bytes no longer cross
 *  a 64MiB chrome.runtime message — the ceiling is memory (the base64 round-trip),
 *  not messaging. Set generously so large media (e.g. animated GIFs) migrate, while
 *  still flagging pathologically huge assets to avoid an out-of-memory crash.
 *  Shared by the PLANNER (predict overflow from the manifest size → dry-run flag)
 *  and the EXECUTOR (runtime backstop on the actual base64 length). */
export const MAX_UPLOAD_BASE64 = 350 * 1024 * 1024; // ≈ 262MB of raw bytes

/** Predict whether raw bytes of `size` exceed the upload ceiling once base64-encoded
 *  (base64 inflates ~4/3). Unknown/zero size → not predicted (executor backstops). */
export function exceedsUploadLimit(size: number | undefined): boolean {
  if (typeof size !== 'number' || size <= 0) return false;
  return Math.ceil(size / 3) * 4 > MAX_UPLOAD_BASE64;
}

/** ~MB for an oversize flag message. */
export function approxMb(size: number): number {
  return Math.round(size / (1024 * 1024));
}

/** A referenced reusable question bank (from `question-banks/<id>.json`). */
export interface SourceBank {
  id: string;
  title?: string;
  questions?: unknown[];
  folder_id?: string | null;
}

export interface PlanInput {
  /** Parsed GET_COURSE payload: `{course, lessons}`. */
  course: GetCourseDocument;
  /** The course's asset manifest entries (downloaded + orphaned). */
  assets: AssetEntry[];
  /** Banks referenced by draw-from-bank blocks, keyed by source bank id. */
  banksById: Map<string, SourceBank>;
  /** Target account user id (author of created lessons/locks). */
  author: string;
  /** Mapped target folder id for the course, or null/'all' for the root. */
  targetFolderId?: string | null;
  /** Recreate referenced question banks (POST→PUT) and bind draw-from-bank
   *  blocks to them. Default OFF: draw-from-bank blocks are created as unbound
   *  placeholders and flagged for manual handling (like Storyline/Mighty) — a
   *  course import does not silently spawn banks in the target account. */
  recreateBanks?: boolean;
  /** Banks already imported as a separate step (B): source bank id →
   *  { newBankId, questionIds }. When a draw-from-bank block's bank is here, the
   *  plan emits a bind step (auto-bind) WITHOUT creating the bank — the bank and
   *  its question ids already exist on the target. Supersedes `recreateBanks`. */
  boundBanks?: Map<string, { newBankId: string; questionIds: string[] }>;
  /** Staged Storyline packages already uploaded to the TARGET Review 360, keyed
   *  by `blockKey(sourceLessonId, sourceBlockId)` → its `review/items/{leaf}`
   *  prefix + meta/title. When an entry exists for a storyline block, the plan
   *  emits an ATTACH (copy_review_item + media patch) instead of a manual flag.
   *  Built by the orchestrator from the course's storyline manifest (only
   *  entries whose package has been uploaded). Lesson+block keyed — block ids
   *  repeat across lessons (v0.6.3), so a blockId-only key would attach one
   *  package to every same-id block. */
  storylineAttach?: Map<string, { reviewPrefix: string; meta?: unknown; title?: string }>;
  /** STACK only (docs/rise-multilang.md §4.3b):
   *  `${blockKey(sourceLessonId, sourceBlockId)}|${locale}` → the uploaded
   *  package for THAT language. Each entry becomes a copy_review_item + a
   *  storyline cell write; languages with no uploaded package are flagged
   *  instead. */
  storylineAttachL10n?: Map<
    string,
    { locale: string; l10nId?: string; reviewPrefix: string; meta?: unknown; title?: string }
  >;
}

export type PlanStep =
  | { kind: 'create-bank'; sourceBankId: string; title: string; summary: string }
  | { kind: 'put-bank'; sourceBankId: string; questionCount: number; summary: string }
  | {
      kind: 'create-course';
      sourceCourseId: string;
      title: string;
      /** Source course `type` (e.g. `"onePage"` for a microlearning) — passed to
       *  POST /content so the target course is the same kind. null/absent → standard. */
      courseType: string | null;
      summary: string;
    }
  | { kind: 'set-theme'; sourceCourseId: string; summary: string }
  | {
      // The clean title, written ONCE, as soon as the course can be titled
      // (right after the first lesson materializes it). No provisional
      // `!importing:`/`!unfinished:` markers exist any more (operator decision,
      // 2026-08-04): incomplete courses are identified via the run reports and
      // the read-back, never via title mangling. `final` = the write that also
      // carries the course description.
      kind: 'set-title';
      sourceCourseId: string;
      title: string;
      final?: boolean;
      summary: string;
    }
  | {
      // Upload + set the course's user-uploaded cover / card / logo image
      // (course-level media, not on a block) via UPDATE_COURSE
      // coverImage/cardImage/media (logo).
      kind: 'set-course-images';
      hasCover: boolean;
      hasCard: boolean;
      /** Course-level `media` object — the cover-page logo. */
      hasMedia: boolean;
      /** Course-level `lessonHeaderImage` object (may nest `originalImage`). */
      hasLessonHeader: boolean;
      summary: string;
    }
  | {
      kind: 'create-lesson';
      sourceLessonId: string;
      position: number;
      /** Always a PLAIN string — on a stack it is the MATERIALIZED
       *  default-locale title (the conversion extracts it into the lesson's
       *  title cell itself; idea 2 ships no source l10nIds at all). */
      title: string;
      lessonType: string | null;
      summary: string;
    }
  | {
      kind: 'update-lesson';
      sourceLessonId: string;
      lessonType: string;
      icon: string | null;
      summary: string;
    }
  | { kind: 'lock-lesson'; sourceLessonId: string; summary: string }
  | {
      // ALL of a lesson's blocks created in ONE ordered CREATE_BLOCKS. A single
      // array insert preserves order deterministically; per-block previousBlockId
      // chaining (interleaved with media uploads) mis-ordered larger lessons.
      kind: 'create-blocks';
      sourceLessonId: string;
      blocks: {
        sourceBlockId: string;
        family: string;
        variant: string;
        /** Known-incompatible Storyline packages become a visible text donor. */
        replacement?: 'legacy-storyline';
      }[];
      summary: string;
    }
  | {
      kind: 'bind-draw-from-bank';
      sourceLessonId: string;
      sourceBlockId: string;
      sourceBankId: string | null;
      drawCount: number;
      questionDrawType: string;
      summary: string;
    }
  | {
      kind: 'upload-asset';
      sourceLessonId: string;
      sourceBlockId: string;
      sourceKey: string;
      mediaKind: string;
      filename: string;
      summary: string;
    }
  | {
      // Lesson-level uploaded media (header image + any lesson `media`) — uploaded
      // BEFORE the lesson's UPDATE_LESSON so the payload carries the remapped key
      // instead of blanking it. Same upload chain as block media.
      kind: 'upload-lesson-media';
      sourceLessonId: string;
      sourceKey: string;
      filename: string;
      summary: string;
    }
  | {
      kind: 'patch-block-media';
      sourceLessonId: string;
      sourceBlockId: string;
      sourceKeys: string[];
      summary: string;
    }
  | { kind: 'unlock-lesson'; sourceLessonId: string; summary: string }
  | {
      kind: 'flag-storyline';
      sourceLessonId: string;
      sourceBlockId: string;
      reason?: 'legacy' | 'missing-package';
      summary: string;
    }
  | {
      // Storyline/Mighty block whose package is staged + uploaded to the target
      // Review 360: copy_review_item into the course, then patch media.storyline.
      kind: 'attach-storyline';
      sourceLessonId: string;
      sourceBlockId: string;
      /** `review/items/{leaf}` on the target account (from the upload). */
      reviewPrefix: string;
      meta?: unknown;
      title?: string;
      summary: string;
    }
  | {
      // Draw-from-bank block created as an unbound placeholder (bank recreation
      // off) — flagged for manual handling, like Storyline/Mighty.
      kind: 'flag-draw-from-bank';
      sourceLessonId: string;
      sourceBlockId: string;
      summary: string;
    }
  | {
      kind: 'flag-orphan-media';
      sourceLessonId: string;
      sourceBlockId: string;
      sourceKey: string;
      summary: string;
    }
  | {
      /** Remove a stale non-rendering source/provenance key without a manual flag. */
      kind: 'drop-optional-media';
      sourceKey: string;
      reason: OptionalAssetReason;
      summary: string;
    }
  | {
      // Uploaded media that isn't attached to a recreatable content block —
      // course cover/card/theme images, lesson header images, bank question
      // media. The captured write path doesn't cover writing these, so they are
      // flagged for manual handling and NOT written as source keys (protocol §8).
      kind: 'flag-unsupported-media';
      sourceKey: string;
      location: string;
      summary: string;
    }
  // --- Multi-language stacks (docs/rise-multilang.md, idea-2 shape) ----------
  | {
      // The course description, written pre-conversion with the MATERIALIZED
      // default-locale value (the conversion mints the description ref + its
      // default cell from it — there is no captured envelope for ADDING a
      // description to an already-converted stack).
      kind: 'set-course-description';
      value: string;
      summary: string;
    }
  | {
      // POST …/translations — the single conversion of the FULLY-BUILT
      // default-language course (idea 2). One step per formality group
      // (formality is a per-call parameter). The AI translates the REAL
      // content — and, decisively, stamps `translatedAt` on every cell, so a
      // migrated stack pends nothing. Target-locale rows are overwritten from
      // the archive afterwards; default rows are NEVER written post-conversion.
      kind: 'convert-stack';
      sourceLanguage: string;
      targetLanguages: string[];
      formality: string | null;
      summary: string;
    }
  | {
      // Poll GET …/translations until every expected language is `complete`,
      // then GET_COURSE the target and PAIR every source ref to the ref the
      // target's own conversion minted (core/l10n/pair.ts — course fields by
      // path, lessons via the id map, blocks via the minted client ids).
      kind: 'await-stack';
      expectedLocales: string[];
      summary: string;
    }
  | {
      // Media referenced ONLY from NON-DEFAULT locales' translation tables
      // (per-language overrides): the default locale's media rode the
      // materialized full build. Same upload chain as block media; keys are
      // remapped inside cell values at write time.
      kind: 'upload-l10n-asset';
      sourceKey: string;
      locale: string;
      mediaKind: string;
      filename: string;
      summary: string;
    }
  | {
      // One UPDATE_L10N_BATCH envelope: the listed source cells of ONE
      // NON-DEFAULT locale (values resolved from the archive at execution;
      // media keys remapped; every id mapped through the pairing map to the
      // target's own refs — an unmapped id is skipped, it was flagged at
      // await-stack). Default-locale cells are NEVER written post-conversion
      // (the write-order invariant, idea-2 form: a default write would re-pend
      // the cell in every locale).
      kind: 'write-l10n';
      locale: string;
      l10nIds: string[];
      batchIndex: number;
      batchTotal: number;
      summary: string;
    }
  | {
      // Recreate a custom per-language label set on the target account
      // (CREATE_LABEL_SET → UPDATE_LABELS(diff) → UPDATE_LOCALE bind).
      // Account-scoped: the executor dedupes via deps.labelSetCache.
      kind: 'set-locale-labelset';
      locale: string;
      iso639Code: string;
      name: string;
      /** Labels that differ from the language's built-in default set (or the
       *  full set when no default was archived). */
      labels: Record<string, unknown>;
      sourceLabelSetId: string;
      summary: string;
    }
  | {
      // Title + description cells for EVERY writable NON-DEFAULT locale
      // (fallback-resolved: a locale the source serves by default-language
      // fallback gets the default value — D2: the target displays exactly what
      // the source displays). The default locale is NEVER written here — its
      // cells were minted by the conversion from the clean pre-conversion
      // title/description.
      kind: 'set-stack-titles';
      summary: string;
    }
  | {
      // Source stack shows the learner language selector; the toggle envelope
      // (TOGGLE_LOCALE_SELECTOR) is not capture-proven → manual flag.
      kind: 'flag-locale-selector';
      summary: string;
    }
  | {
      // A stack cell holds a Storyline package reference (docs/rise-multilang.md
      // §4.3b). NEVER copied verbatim — its contentPrefix points at the SOURCE
      // course's S3 prefix and storyline keys are exempt from the foreign-key
      // invariant, so a verbatim copy would ship a dead reference silently.
      // v0.6.0: the block is recreated bare and every language is flagged for a
      // manual Review-360 attach (per-language attach automation → v0.6.1).
      kind: 'flag-l10n-storyline';
      l10nId: string;
      locales: string[];
      title?: string;
      summary: string;
    }
  | {
      // A source translation table exists for a locale the target can never
      // have: the locale row is ARCHIVED (deletedAt — convert-stack recreates
      // live languages only) or the table has no locale row at all. Writing
      // its cells would send UPDATE_L10N_BATCH for a locale unknown to the
      // target course (untested server behavior), so the data is skipped and
      // flagged loudly instead — restore the language at the source and
      // re-export to migrate it.
      kind: 'flag-l10n-locale';
      locale: string;
      reason: 'archived' | 'no-locale-row';
      cells: number;
      summary: string;
    }
  | {
      // STACK per-language Storyline attach (docs/rise-multilang.md §4.3b):
      // copy_review_item for THIS language's package, then write the storyline
      // cell for that locale. The block itself already carries the {l10nId} ref
      // (copy-faithful), so no block patch — patching would clobber the ref.
      kind: 'attach-storyline-l10n';
      sourceLessonId: string;
      sourceBlockId: string;
      /** The cell to write (source l10nId, kept verbatim on the target). */
      l10nId: string;
      locale: string;
      reviewPrefix: string;
      meta?: unknown;
      title?: string;
      summary: string;
    };
