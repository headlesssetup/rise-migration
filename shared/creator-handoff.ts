// Handoff of a pasted blueprint from the Creator ENTRY page to the REVIEW page
// (v0.9.0 two-page split), over `chrome.storage.session`:
//   · survives a page refresh (session-scoped to the BROWSER session, not the
//     page), self-cleans on browser exit;
//   · shared across extension pages (trusted contexts) — content scripts never
//     see it;
//   · one slot per blueprint, so several pending reviews coexist.
// The RAW pasted text is stored, never a parsed blueprint: the review page
// re-runs validateBlueprint — storage is not trusted as pre-validated input.

export interface PendingBlueprint {
  pastedText: string;
  /** The picked .json file's name, when the text came from a file. */
  fileName: string | null;
  createdAt: string;
}

const PREFIX = 'creator:pending:';

/** The storage surface used — injectable for tests. */
export interface HandoffArea {
  set(items: Record<string, unknown>): Promise<void>;
  get(key: string): Promise<Record<string, unknown>>;
  remove(key: string): Promise<void>;
}

function sessionArea(): HandoffArea {
  return browser.storage.session as unknown as HandoffArea;
}

/** Stage a pasted blueprint for review; returns the slot id for `?b=<id>`. */
export async function putPendingBlueprint(
  pastedText: string,
  fileName: string | null,
  area: HandoffArea = sessionArea(),
): Promise<string> {
  const id = crypto.randomUUID();
  const slot: PendingBlueprint = {
    pastedText,
    fileName,
    createdAt: new Date().toISOString(),
  };
  try {
    await area.set({ [PREFIX + id]: slot });
  } catch (e) {
    // storage.session quota is 10 MB shared across slots (plan W6). The pasted
    // text stays in the entry page's textarea — nothing is lost.
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not stage the blueprint for review (${msg}). The JSON may be unusually large — your pasted text is untouched.`,
    );
  }
  return id;
}

export async function getPendingBlueprint(
  id: string,
  area: HandoffArea = sessionArea(),
): Promise<PendingBlueprint | null> {
  const key = PREFIX + id;
  const got = await area.get(key);
  const v = got[key] as PendingBlueprint | undefined;
  return v && typeof v.pastedText === 'string' ? v : null;
}

export async function removePendingBlueprint(
  id: string,
  area: HandoffArea = sessionArea(),
): Promise<void> {
  await area.remove(PREFIX + id);
}
