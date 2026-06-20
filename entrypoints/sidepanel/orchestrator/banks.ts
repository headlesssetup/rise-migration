// Question-bank orchestration: paced fetch + save of reusable banks (API ref §9),
// then load them back from disk for profiling.

import { extractBanks, hasInlineQuestions } from '@/core/census/question-banks';
import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import { rpc } from '../rpc';
import { describeShape, type ProgressEvent } from './shared';

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
