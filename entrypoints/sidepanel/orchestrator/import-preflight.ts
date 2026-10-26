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
import { unwrap } from './shared';

export interface ImportPreflightWarning {
  kind: 'folders' | 'storyline' | 'banks';
  /** One operator-facing sentence: what will happen and which step fixes it. */
  message: string;
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
  opts: { recreateFolders: boolean },
): Promise<ImportPreflightWarning[]> {
  const warnings: ImportPreflightWarning[] = [];
  const n = courseIds.length;

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
  const bankShort: string[] = [];
  const unboundBanks = new Set<string>();

  for (const id of courseIds) {
    const raw = await storage.readCourse(id);
    if (!raw) continue; // reported by the run itself ("not in archive")
    let doc: ReturnType<typeof unwrap>;
    try {
      doc = unwrap(raw);
    } catch {
      continue; // unreadable → the run reports it
    }
    const title = titleOf(doc, id);

    // Storyline/Mighty packages the course import could attach — one per
    // package ref (a stack carries one per language), excluding never-attached
    // placeholders (no leaf) and legacy packages (never uploaded by design).
    const packages = findStorylineBlocks(doc).filter(
      (b) => b.leaf && !isKnownLegacyStorylineMeta(b.meta),
    );
    if (packages.length) {
      const attach = await readStorylineAttach(storage, id);
      const uploaded = attach ? attach.byBlock.size + attach.byBlockLocale.size : 0;
      const missing = Math.max(0, packages.length - uploaded);
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
  if (bankShort.length) {
    warnings.push({
      kind: 'banks',
      message:
        `${bankShort.length} selected course(s) draw from ${unboundBanks.size} question bank(s) that ` +
        `step B has not imported — run step B (Question banks) first, or those draw-from-bank ` +
        `blocks become empty placeholders to attach manually: ${few(bankShort)}.`,
    });
  }

  return warnings;
}
