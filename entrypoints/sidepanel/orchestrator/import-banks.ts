// Phase 3 — Operation B: question-bank listing + standalone import. Split out of
// import.ts; shares the relay, source identity, refresh, and bank id-map
// persistence from ./import-shared. Re-exported from ./import so the public
// surface is unchanged.

import {
  checkSourceNotTarget,
  IdMap,
  remapIds,
  postBank,
  putBank,
  type AccountIdentity,
  type SourceBank,
} from '@/core/import';
import { DEFAULT_PACING, pacedDelay, type PacingConfig } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import type { ProgressEvent } from './shared';
import {
  readSourceIdentity,
  refreshToken,
  readBankIdMap,
  writeBankIdMap,
  relayThroughTab,
  safeJson,
} from './import-shared';

// --- B) Question banks: list + standalone import ------------------------------

export interface LocalBank {
  id: string;
  title: string;
  questionCount: number;
}

/** List the question banks saved locally (id + title + question count) for the
 *  selectable B list. Titles come from the saved bank index when present. */
export async function listLocalBanks(storage: Storage): Promise<LocalBank[]> {
  const titleById = new Map<string, string>();
  const indexRaw = await storage.readBankIndex();
  if (indexRaw) {
    try {
      const doc = JSON.parse(indexRaw) as unknown;
      const arr = Array.isArray(doc)
        ? doc
        : (((doc as Record<string, unknown>).items as unknown[]) ??
           ((doc as Record<string, unknown>).questionBanks as unknown[]) ??
           Object.values(doc as Record<string, unknown>));
      for (const it of (arr ?? []) as Record<string, unknown>[]) {
        if (it && typeof it.id === 'string' && typeof it.title === 'string') {
          titleById.set(it.id, it.title);
        }
      }
    } catch {
      /* tolerate */
    }
  }
  const ids = await storage.listSavedBanks();
  const out: LocalBank[] = [];
  for (const id of ids) {
    let questionCount = 0;
    let title: string | undefined;
    const raw = await storage.readQuestionBank(id);
    if (raw) {
      try {
        const b = JSON.parse(raw) as SourceBank;
        questionCount = Array.isArray(b.questions) ? b.questions.length : 0;
        // The bank's own JSON carries the real title; prefer it over the index.
        if (typeof b.title === 'string' && b.title) title = b.title;
      } catch {
        /* tolerate */
      }
    }
    out.push({ id, title: title ?? titleById.get(id) ?? id, questionCount });
  }
  return out;
}

export interface BankImportOutcome {
  sourceBankId: string;
  title: string;
  newBankId?: string;
  questionCount: number;
  ok: boolean;
  error?: string;
  /** Empty bank shell left on the target (question write failed; no auto-delete). */
  orphanedBankId?: string;
}

export interface BankImportOptions {
  dryRun: boolean;
  override?: boolean;
  pacing?: PacingConfig;
  /** Cooperative cancel for the Stop button (polled between banks). */
  shouldStop?: () => boolean;
}

/**
 * Operation B — import selected question banks as standalone resources. Creates
 * each bank (POST → PUT questions, copy-faithful with regenerated ids) and
 * persists source bank id → { newBankId, questionIds } so course import (C)
 * auto-binds draw-from-bank blocks. (Bank-question media is not re-uploaded — it
 * stays flagged, consistent with the course path.)
 */
export async function importBanks(
  storage: Storage,
  target: AccountIdentity | undefined,
  bankIds: string[],
  opts: BankImportOptions,
  onEvent: (e: ProgressEvent) => void,
): Promise<{ blocked?: string; outcomes: BankImportOutcome[] }> {
  const pacing = opts.pacing ?? DEFAULT_PACING;
  const outcomes: BankImportOutcome[] = [];

  const source = await readSourceIdentity(storage);
  const verdict = checkSourceNotTarget(source, target, opts.override);
  if (!verdict.ok && !opts.dryRun) {
    onEvent({ kind: 'log', message: `BLOCKED: ${verdict.reason}` });
    return { blocked: verdict.reason, outcomes };
  }

  // Start on a fresh bearer (idle panels lapse the ~15 min token).
  await refreshToken(onEvent, 'run start');

  // Merge into any previously-imported banks so C sees the full set.
  const bound = await readBankIdMap(storage);
  // Account-local owner (see runImport) — author of the bank lock_data.
  const author = target?.userId ?? target?.sub ?? 'unknown';

  let stopped = false;
  for (const [i, bankId] of bankIds.entries()) {
    if (opts.shouldStop?.()) {
      stopped = true;
      onEvent({ kind: 'log', message: 'Stop requested — halting before the next bank.' });
      break;
    }
    const raw = await storage.readQuestionBank(bankId);
    if (!raw) {
      onEvent({ kind: 'log', message: `Skipped bank (not in archive): ${bankId}` });
      continue;
    }
    let bank: SourceBank;
    try {
      bank = JSON.parse(raw) as SourceBank;
    } catch {
      outcomes.push({ sourceBankId: bankId, title: bankId, questionCount: 0, ok: false, error: 'unreadable bank JSON' });
      continue;
    }
    const title = bank.title ?? bankId;
    const qCount = Array.isArray(bank.questions) ? bank.questions.length : 0;
    onEvent({ kind: 'log', message: `[${i + 1}/${bankIds.length}] Bank "${title}" (${qCount} question(s))` });

    // Regenerate question ids (copy-faithful) so the target bank owns fresh ids.
    const ids = new IdMap();
    const questions = remapIds(bank.questions ?? [], ids) as Array<{ id?: string }>;
    const questionIds = questions.map((q) => String(q.id ?? '')).filter(Boolean);

    // Hoisted so the catch can report a shell that was created before the
    // question write failed (empty bank left on target — no auto-delete).
    let createdBankId: string | undefined;
    try {
      let newBankId: string;
      if (opts.dryRun) {
        newBankId = `dry-bank-${bankId}`;
      } else {
        await pacedDelay(pacing);
        const cresp = await relayThroughTab(postBank({ folderId: null, title }));
        if (!cresp.ok) throw new Error(`create failed (HTTP ${cresp.status})`);
        newBankId = String((safeJson(cresp.text) as { id?: string } | null)?.id ?? '');
        if (!newBankId) throw new Error('create returned no id');
        createdBankId = newBankId; // the shell now exists on the target

        await pacedDelay(pacing);
        const presp = await relayThroughTab(
          putBank({
            bankId: newBankId,
            questions: questions as unknown[],
            session: `${Date.now()}`,
            lockData: { user_id: author, staff: false, content_team_admin: false },
          }),
        );
        if (!presp.ok) throw new Error(`write questions failed (HTTP ${presp.status})`);
      }
      bound.set(bankId, { newBankId, questionIds });
      outcomes.push({ sourceBankId: bankId, title, newBankId, questionCount: qCount, ok: true });
      onEvent({ kind: 'log', message: `  ${opts.dryRun ? 'planned' : 'OK'} → bank ${newBankId}` });
    } catch (e) {
      const orphanNote = createdBankId
        ? ` — empty bank ${createdBankId} left on target (delete manually if needed)`
        : '';
      outcomes.push({
        sourceBankId: bankId,
        title,
        questionCount: qCount,
        ok: false,
        error: (e as Error).message,
        orphanedBankId: createdBankId,
      });
      onEvent({ kind: 'log', message: `  FAILED: ${(e as Error).message}${orphanNote}` });
    }
    if (i < bankIds.length - 1) await pacedDelay(pacing);
  }

  // Persist the merged map (skip in dry-run so a preview never alters state).
  if (!opts.dryRun) await writeBankIdMap(storage, bound);

  // Banks summary: ok/failed counts + ids needing manual cleanup / re-run.
  const attempted = new Set(outcomes.map((o) => o.sourceBankId));
  const notStarted = bankIds.filter((id) => !attempted.has(id));
  const orphaned = outcomes.map((o) => o.orphanedBankId).filter((x): x is string => !!x);
  const okN = outcomes.filter((o) => o.ok).length;
  const failN = outcomes.filter((o) => !o.ok).length;
  onEvent({
    kind: 'log',
    message: `— Banks summary${stopped ? ' (STOPPED)' : ''} — ${okN} ${opts.dryRun ? 'planned' : 'ok'}, ${failN} failed${notStarted.length ? `, ${notStarted.length} not started` : ''}`,
  });
  if (orphaned.length) {
    onEvent({
      kind: 'log',
      message: `  empty banks left in place (delete manually if needed): ${orphaned.join(', ')}`,
    });
  }
  return { outcomes };
}
