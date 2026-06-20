// Question-bank orchestration: paced fetch + save of reusable banks (API ref §9),
// then load them back from disk for profiling.

import {
  extractBankFolders,
  buildFolderInventory,
} from '@/core/census/folders';
import {
  buildBankInventory,
  collectBankReferences,
  extractBanks,
  hasInlineQuestions,
  type BankInventoryRow,
  type BankUsage,
} from '@/core/census/question-banks';
import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import { rpc } from '../rpc';
import { describeShape, unwrap, type ProgressEvent } from './shared';

export interface BankFetchResult {
  bankCount: number;
  saved: number;
  skipped: number;
  failed: string[];
}

/** Detect reusable question banks, then paced-fetch + save each raw (API ref §9).
 *  Banks are separate from course content and referenced by draw-from-bank
 *  blocks, so they're needed for that block's migration. */
export async function fetchQuestionBanks(
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
  pacing: PacingConfig = DEFAULT_PACING,
): Promise<BankFetchResult> {
  onEvent({ kind: 'log', message: 'Listing question banks…' });
  const listResp = await rpc({ type: 'LIST_QUESTION_BANKS' });
  if (listResp.type !== 'BANKS_RESULT' || !listResp.result.ok) {
    const err =
      listResp.type === 'BANKS_RESULT' && !listResp.result.ok
        ? listResp.result.error
        : 'unexpected response';
    onEvent({ kind: 'log', message: `Question banks unavailable: ${err}` });
    return { bankCount: 0, saved: 0, skipped: 0, failed: [] };
  }

  await storage.writeBankIndex(listResp.result.data.raw);
  const banks = extractBanks(listResp.result.data.doc);
  onEvent({
    kind: 'log',
    message: `Found ${banks.length} question bank(s)${
      banks.length === 0 ? ` (response shape: ${describeShape(listResp.result.data.doc)})` : ''
    }.`,
  });

  const failed: string[] = [];
  let saved = 0;
  let didNetwork = false;

  for (const [i, b] of banks.entries()) {
    onEvent({ kind: 'course', index: i, total: banks.length, courseId: b.id });

    // The list already carries questions inline — save directly, no fetch.
    if (hasInlineQuestions(b.doc)) {
      await storage.writeQuestionBank(b.id, JSON.stringify(b.doc));
      saved += 1;
      continue;
    }

    // Fallback: a bank without inline questions → fetch it by id.
    if (didNetwork) await pacedDelay(pacing);
    didNetwork = true;
    const resp = await rpc({ type: 'GET_QUESTION_BANK', bankId: b.id });
    if (resp.type !== 'BANK_RESULT' || !resp.result.ok) {
      failed.push(b.id);
      onEvent({ kind: 'log', message: `Failed bank ${b.id}` });
      continue;
    }
    await storage.writeQuestionBank(b.id, resp.result.data.raw);
    saved += 1;
    onEvent({ kind: 'log', message: `Saved bank: ${b.title ?? b.id}` });
  }
  return { bankCount: banks.length, saved, skipped: 0, failed };
}

/** Load every saved question bank from disk for profiling. */
export async function scanSavedBanks(
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
): Promise<{ id: string; doc: unknown }[]> {
  const ids = await storage.listSavedBanks();
  onEvent({ kind: 'log', message: `Scanning ${ids.length} saved bank(s)…` });
  const out: { id: string; doc: unknown }[] = [];
  for (const id of ids) {
    const raw = await storage.readQuestionBank(id);
    if (!raw) continue;
    try {
      out.push({ id, doc: JSON.parse(raw) });
    } catch {
      onEvent({ kind: 'log', message: `Skipped unreadable bank: ${id}` });
    }
  }
  return out;
}

/**
 * Build the per-bank inventory (decision table) from saved banks, enriched with
 * folder name-paths + author profiles (from the banks index) and usage counts
 * (how many saved courses reference each bank via draw-from-bank).
 */
export async function buildBankInventoryRows(
  storage: Storage,
  banks: { id: string; doc: unknown }[],
): Promise<BankInventoryRow[]> {
  // Profiles + folder name-paths from the saved banks index.
  let profiles: unknown;
  const folderPaths: Record<string, string> = {};
  const indexRaw = await storage.readBankIndex();
  if (indexRaw) {
    try {
      const index = JSON.parse(indexRaw);
      profiles = (index as Record<string, unknown>)?.profiles;
      for (const f of buildFolderInventory(extractBankFolders(index))) {
        folderPaths[f.id] = f.path;
      }
    } catch {
      /* tolerate malformed index */
    }
  }

  // Usage: which saved courses reference each bank (draw-from-bank).
  const usage: Record<string, BankUsage> = {};
  for (const id of await storage.listSaved()) {
    const raw = await storage.readCourse(id);
    if (!raw) continue;
    let refs: string[] = [];
    try {
      refs = collectBankReferences(unwrap(raw));
    } catch {
      continue;
    }
    for (const bankId of refs) {
      const u = (usage[bankId] ??= { courseCount: 0, courseIds: [] });
      if (!u.courseIds.includes(id)) {
        u.courseIds.push(id);
        u.courseCount += 1;
      }
    }
  }

  return buildBankInventory(banks, { profiles, folderPaths, usage });
}
