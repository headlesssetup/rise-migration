// Pending-translation SET parser (F5, findings-2026-08-04-us-run.md).
//
// `GET /manage/api/content/{id}/translations/updates` is the ONLY truthful
// pending signal: `stackItems[].pendingChangesCount` materializes LAZILY
// (0 seconds after import, populated hours later) and the badge number
// (`updateCount`) is a smaller, segment-ish tally (63 for 255 pending cells on
// the live capture) — so pending must be compared as a SET of (l10nId, locale)
// entries, never as counts.
//
// Capture-pinned shape (capture_banks-and-count.mitm, US 2026-08-04):
//   { updateCount, localeUpdateCounts: {ru: 63},
//     courseUpdates: [entry, …],
//     lessonItemUpdates: { <lessonId>: { <blockId|'root'>: [entry, …] } },
//     mondrianUpdates: {count, locales}, aiScenarioUpdates: {count, locales},
//     inProgress }
// entry = { locale, localeId, l10nId, updatedAt, value, valueType,
//           translatedAt: string|null, targetValue }
//
// mondrian (Storyline inner text) and aiScenario are SEPARATE translation
// subsystems we do not migrate — excluded from the set on purpose.

export interface PendingCell {
  l10nId: string;
  locale: string;
  /** The AI stamp; null = never stamped (the US pending rule is
   *  `default row updatedAt > translatedAt`). Informational. */
  translatedAt: string | null;
}

export interface PendingUpdates {
  /** The decorative badge tally (segment-ish) — NEVER compare against this. */
  updateCount: number | null;
  /** The truth: every pending (l10nId, locale) entry. */
  pending: PendingCell[];
  inProgress: boolean;
}

function isEntry(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).l10nId === 'string' &&
    typeof (v as Record<string, unknown>).locale === 'string';
}

function pushEntries(arr: unknown, out: PendingCell[]): void {
  if (!Array.isArray(arr)) return;
  for (const e of arr) {
    if (!isEntry(e)) continue;
    out.push({
      l10nId: e.l10nId as string,
      locale: e.locale as string,
      translatedAt: typeof e.translatedAt === 'string' ? e.translatedAt : null,
    });
  }
}

/** Flatten a `translations/updates` body into the pending SET. Tolerant of
 *  missing sections; ignores mondrian/aiScenario (separate subsystems). */
export function parseTranslationUpdates(body: unknown): PendingUpdates {
  const b = (body ?? {}) as Record<string, unknown>;
  const pending: PendingCell[] = [];
  pushEntries(b.courseUpdates, pending);
  const liu = b.lessonItemUpdates;
  if (liu && typeof liu === 'object' && !Array.isArray(liu)) {
    for (const inner of Object.values(liu as Record<string, unknown>)) {
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        for (const arr of Object.values(inner as Record<string, unknown>)) {
          pushEntries(arr, pending);
        }
      }
    }
  }
  return {
    updateCount: typeof b.updateCount === 'number' ? b.updateCount : null,
    pending,
    inProgress: b.inProgress === true,
  };
}

/** Stable "l10nId locale" key for set comparisons + report listings. */
export function pendingKey(c: Pick<PendingCell, 'l10nId' | 'locale'>): string {
  return `${c.l10nId} ${c.locale}`;
}

/** Compare an actual pending set against an expected one (both as entries).
 *  Returns the two difference sides as sorted key lists. */
export function diffPendingSets(
  actual: Pick<PendingCell, 'l10nId' | 'locale'>[],
  expected: Pick<PendingCell, 'l10nId' | 'locale'>[],
): { unexpected: string[]; missing: string[] } {
  const a = new Set(actual.map(pendingKey));
  const e = new Set(expected.map(pendingKey));
  return {
    unexpected: [...a].filter((k) => !e.has(k)).sort(),
    missing: [...e].filter((k) => !a.has(k)).sort(),
  };
}
