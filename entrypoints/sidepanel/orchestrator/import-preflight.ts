// Pre-run ORDERING preflight for a course import — the "did you forget a step?"
// checks the protocol documents but nothing enforced (docs/rise-import-protocol
// .md: folders before courses; Stage D Storyline upload before courses; step B
// banks before courses). Pure archive reads: no network, no writes, no ids.
// Each finding is one warning the panel shows with Continue anyway / Abort —
// nothing here blocks, because every one of these is a legitimate choice
// (courses in root, Storyline attached by hand, banks attached by hand); it
// just must never be an ACCIDENT.

import type { Storage } from '@/core/storage/storage';
import { isKnownLegacyStorylineMeta } from '@/core/storyline/compatibility';
import { findStorylineBlocks } from '@/core/storyline/detect';
import { findBankRef } from '@/core/import';
import type { Block } from '@/shared/types/rise';
import { readBankIdMap } from './import-shared';
import { readCourseFolders, readStorylineAttach } from './import-run-inputs';
import { unwrap, type ProgressEvent } from './shared';

export interface ImportPreflightWarning {
  kind: 'folders' | 'storyline' | 'storyline-manual' | 'banks' | 'labels';
  /** One operator-facing sentence: what will happen and which step fixes it. */
  message: string;
}

/** What the Storyline manifest says about a course's packages: which leaves
 *  step D can never stage (the course is not exportable from this account, or
 *  the entry is a never-staged `source-placeholder`). Tolerant: no/unreadable
 *  manifest → nothing is manual (D has simply not run yet). */
async function readManualStorylineLeaves(
  storage: Storage,
  courseId: string,
): Promise<{ exportBlocked: boolean; leaves: Set<string> }> {
  const out = { exportBlocked: false, leaves: new Set<string>() };
  const raw = await storage.readStorylineManifest(courseId);
  if (!raw) return out;
  try {
    const m = JSON.parse(raw) as {
      exportBlocked?: unknown;
      blocks?: Array<{ leaf?: string; compatibility?: string }>;
    };
    out.exportBlocked = !!m.exportBlocked;
    for (const b of m.blocks ?? []) {
      if (b.leaf && (out.exportBlocked || b.compatibility === 'source-placeholder')) {
        out.leaves.add(b.leaf);
      }
    }
  } catch {
    /* tolerate — the run reports an unreadable manifest */
  }
  return out;
}

const DRAW_FROM_BANK = 'knowledgeCheck/draw from question bank';

function titleOf(doc: unknown, id: string): string {
  const t = (doc as { course?: { title?: unknown } })?.course?.title;
  return typeof t === 'string' && t ? t : id;
}

function few(names: string[], max = 3): string {
  const shown = names.slice(0, max).map((n) => `"${n}"`);
  return names.length > max ? `${shown.join(', ')}, +${names.length - max} more` : shown.join(', ');
}

/**
 * Check the selected courses for skipped prerequisite steps. Returns one
 * warning per finding kind (never per course) so the confirm box stays short.
 */
export async function checkImportPreconditions(
  storage: Storage,
  courseIds: string[],
  opts: { recreateFolders: boolean; defaultLabelLanguage?: string },
  onEvent: (e: ProgressEvent) => void = () => {},
): Promise<ImportPreflightWarning[]> {
  const warnings: ImportPreflightWarning[] = [];
  const n = courseIds.length;
  // Archive reads only, but hundreds of courses take seconds — the operator
  // must see the click registered and which course is being checked.
  onEvent({ kind: 'log', message: `Preflight: checking ${n} selected course(s) for skipped steps…` });

  // --- Folders: off + the course lives in a folder at the source → root. ---
  if (!opts.recreateFolders) {
    const courseFolders = await readCourseFolders(storage);
    const inFolder = courseIds.filter((id) => courseFolders.get(id));
    if (inFolder.length) {
      warnings.push({
        kind: 'folders',
        message:
          `${inFolder.length} of ${n} selected course(s) sit in a folder at the source, but ` +
          `"Re-create folders" is OFF — they will be created in the ROOT of the target account. ` +
          `Tick "Re-create folders" to place them in their folders.`,
      });
    }
  }

  // --- Storyline (step D) and banks (step B): per-course archive scan. ---
  const boundBanks = await readBankIdMap(storage);
  const storylineShort: string[] = [];
  let storylineMissing = 0;
  const manualShort: string[] = [];
  let storylineManual = 0;
  const bankShort: string[] = [];
  const unboundBanks = new Set<string>();
  const noLabelSet: string[] = [];

  for (const [i, id] of courseIds.entries()) {
    onEvent({ kind: 'import-status', label: `Preflight [${i + 1}/${n}]`, etaSeconds: null, done: false });
    const raw = await storage.readCourse(id);
    if (!raw) continue; // reported by the run itself ("not in archive")
    let doc: ReturnType<typeof unwrap>;
    try {
      doc = unwrap(raw);
    } catch {
      continue; // unreadable → the run reports it
    }
    const title = titleOf(doc, id);

    // Label set: "" resolves to an account default the export cannot see
    // (mig30oct: German on the US source, English on the EU target).
    const labelSetId = (doc.course as Record<string, unknown> | undefined)?.labelSetId;
    // Only an EXPORTED course carries the key ("" = none named); a Creator
    // build asserts nothing there.
    if (!opts.defaultLabelLanguage && labelSetId === '') {
      noLabelSet.push(title);
    }

    // Storyline/Mighty packages the course import could attach — one per
    // package ref (a stack carries one per language), excluding never-attached
    // placeholders (no leaf) and legacy packages (never uploaded by design).
    const packages = findStorylineBlocks(doc).filter(
      (b) => b.leaf && !isKnownLegacyStorylineMeta(b.meta),
    );
    if (packages.length) {
      const attach = await readStorylineAttach(storage, id);
      const uploaded = attach ? attach.byBlock.size + attach.byBlockLocale.size : 0;
      // Packages step D can never stage (not exportable from this account /
      // never-staged placeholders) are MANUAL work, not a "run D first" — the
      // hint must not send the operator back to a step that skips them again.
      const manual = await readManualStorylineLeaves(storage, id);
      const manualCount = manual.exportBlocked
        ? packages.length - uploaded
        : packages.filter((b) => b.leaf && manual.leaves.has(b.leaf)).length;
      const missing = Math.max(0, packages.length - uploaded - Math.max(0, manualCount));
      if (manualCount > 0) {
        storylineManual += manualCount;
        manualShort.push(title);
      }
      if (missing) {
        storylineMissing += missing;
        storylineShort.push(title);
      }
    }

    // Draw-from-bank blocks bind only to banks step B imported (banks.idmap).
    let unboundHere = false;
    for (const l of doc.lessons ?? []) {
      for (const b of (l.items ?? []) as Block[]) {
        if (`${b.family}/${b.variant}` !== DRAW_FROM_BANK) continue;
        const { bankId } = findBankRef(b);
        if (bankId && !boundBanks.has(bankId)) {
          unboundBanks.add(bankId);
          unboundHere = true;
        }
      }
    }
    if (unboundHere) bankShort.push(title);
  }

  if (storylineShort.length) {
    warnings.push({
      kind: 'storyline',
      message:
        `${storylineShort.length} selected course(s) contain ${storylineMissing} Storyline/Mighty ` +
        `package(s) not yet uploaded to the target Review 360 — run step D (Storyline → Review 360) ` +
        `BEFORE importing, or those blocks become manual-attach flags: ${few(storylineShort)}.`,
    });
  }
  if (manualShort.length) {
    warnings.push({
      kind: 'storyline-manual',
      message:
        `${manualShort.length} selected course(s) contain ${storylineManual} Storyline/Mighty ` +
        `package(s) that step D cannot stage (the course is not exportable from this account, or ` +
        `the package was never staged) — those blocks will be imported as manual-attach flags; ` +
        `attach them by hand on the target afterwards: ${few(manualShort)}.`,
    });
  }
  if (bankShort.length) {
    warnings.push({
      kind: 'banks',
      message:
        `${bankShort.length} selected course(s) draw from ${unboundBanks.size} question bank(s) that ` +
        `step B has not imported — run step B (Question banks) first, or those draw-from-bank ` +
        `blocks become empty placeholders to attach manually: ${few(bankShort)}.`,
    });
  }

  if (noLabelSet.length) {
    warnings.push({
      kind: 'labels',
      message:
        `${noLabelSet.length} selected course(s) name no label set — learners will see the TARGET ` +
        `account's default interface language (quiz "Incorrect"/"TAKE AGAIN", navigation), which ` +
        `may differ from the source. Pick an "Interface language" to bind one: ${few(noLabelSet)}.`,
    });
  }

  onEvent({ kind: 'import-status', label: 'Preflight complete', etaSeconds: null, done: true });
  onEvent({
    kind: 'log',
    message: warnings.length
      ? `⚠ Preflight: ${warnings.length} finding(s) across ${n} course(s).`
      : `✓ Preflight: no skipped steps across ${n} course(s).`,
  });
  return warnings;
}
