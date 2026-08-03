// Multi-language ("stack") course detection + metadata helpers.
// Protocol: docs/rise-multilang.md. A stack is ONE course whose document is
// l10n-ified: localizable values are {l10nId} refs resolved through per-locale
// tables in payload.l10n. These helpers are pure and read-only.

import type { GetCourseDocument, L10nLocale, SearchResultItem } from '@/shared/types/rise';

/**
 * Is this GET_COURSE payload a multi-language stack? Checks all three markers
 * independently (a partial/odd conversion may leave only some of them):
 * - course.localizationMetadata.isLocalized === true
 * - course.defaultLocaleId is a non-empty string (monolingual: null)
 * - payload.l10n.locales is a non-empty array (monolingual l10n holds only
 *   languageCodeMetadata)
 */
export function isLocalizedStack(doc: GetCourseDocument | undefined | null): boolean {
  const course = doc?.course;
  if (course?.localizationMetadata?.isLocalized === true) return true;
  if (typeof course?.defaultLocaleId === 'string' && course.defaultLocaleId) return true;
  const locales = doc?.l10n?.locales;
  return Array.isArray(locales) && locales.length > 0;
}

/** The stack's default locale code (e.g. "en-us"), if any. */
export function defaultLocaleOf(doc: GetCourseDocument | undefined | null): string | undefined {
  const dl = doc?.l10n?.defaultLocale;
  if (typeof dl === 'string' && dl) return dl;
  // Fall back to resolving defaultLocaleId against the locale rows.
  const id = doc?.course?.defaultLocaleId;
  if (typeof id === 'string' && id) {
    const row = (doc?.l10n?.locales ?? []).find((l) => l.id === id);
    if (typeof row?.locale === 'string') return row.locale;
  }
  return undefined;
}

/**
 * The default locale, or throw: a stack whose default locale cannot be resolved
 * (no `l10n.defaultLocale`, no resolvable `defaultLocaleId`) is malformed, and
 * proceeding would silently break the write-order invariant (the default
 * locale's cells must be written FIRST or every cell imports as "pending").
 * Loud failure per CLAUDE.md — the course aborts instead of degrading.
 */
export function requireDefaultLocale(doc: GetCourseDocument | undefined | null): string {
  const def = defaultLocaleOf(doc);
  if (!def) {
    throw new Error(
      'stack has no resolvable default locale (l10n.defaultLocale and course.defaultLocaleId both unusable) — aborting this course',
    );
  }
  return def;
}

/** Locale rows of a stack, default locale first, archived (deletedAt) excluded. */
export function stackLocales(doc: GetCourseDocument | undefined | null): L10nLocale[] {
  const rows = (doc?.l10n?.locales ?? []).filter((l) => !l.deletedAt);
  const def = defaultLocaleOf(doc);
  return [...rows].sort((a, b) => {
    if (a.locale === def && b.locale !== def) return -1;
    if (b.locale === def && a.locale !== def) return 1;
    return String(a.locale ?? '').localeCompare(String(b.locale ?? ''));
  });
}

/**
 * Locale codes that exist as LIVE (non-archived) rows, plus the default locale.
 * This is the set of languages the import can actually create on the target
 * (`convert-stack` runs one POST per formality group over these rows) — table
 * data for any OTHER locale (an archived row, or a table with no row at all)
 * cannot be written to the target and must be skipped + flagged, never shipped
 * to a locale the server doesn't know about.
 */
export function writableLocaleCodes(doc: GetCourseDocument | undefined | null): Set<string> {
  const codes = new Set<string>();
  const def = defaultLocaleOf(doc);
  if (def) codes.add(def);
  for (const row of stackLocales(doc)) {
    const code = typeof row.locale === 'string' ? row.locale : '';
    if (code) codes.add(code);
  }
  return codes;
}

/** Locale codes from a content/search listing row, default first (listing rows
 *  carry `locales[]` + `defaultLocaleId`; both empty/null on monolingual). */
export function listingLocales(item: SearchResultItem | undefined | null): string[] {
  const rows = Array.isArray(item?.locales) ? item!.locales! : [];
  const defId = item?.defaultLocaleId ?? null;
  const codes = rows
    .map((r) => ({ code: typeof r.locale === 'string' ? r.locale : '', isDef: r.id === defId }))
    .filter((r) => r.code);
  codes.sort((a, b) => (a.isDef === b.isDef ? a.code.localeCompare(b.code) : a.isDef ? -1 : 1));
  return codes.map((r) => r.code);
}

/** "en-us | ar | bs" — inventory/log format; '' when not a stack. */
export function formatLocales(codes: string[]): string {
  return codes.filter(Boolean).join(' | ');
}

/**
 * Does the archived course doc lag behind the live listing's language set?
 * True when the listing shows locales the archive's l10n overlay doesn't have —
 * e.g. the course was exported before languages were added (the export loop
 * then re-fetches instead of skipping).
 */
export function archiveIsStaleForLocales(
  item: SearchResultItem | undefined | null,
  archivedDoc: GetCourseDocument | undefined | null,
): boolean {
  const listed = new Set(listingLocales(item));
  if (listed.size === 0) return false; // not a stack per the listing
  const archived = new Set(
    (archivedDoc?.l10n?.locales ?? []).map((l) => String(l.locale ?? '')).filter(Boolean),
  );
  for (const code of listed) if (!archived.has(code)) return true;
  return false;
}

/** Target-language groups for the conversion POSTs: one POST per distinct
 *  formality among NON-default locales (formality is a per-call parameter).
 *  `null`/absent formality groups together. */
export function formalityGroups(
  doc: GetCourseDocument,
): { formality: string | null; locales: string[] }[] {
  const def = defaultLocaleOf(doc);
  const groups = new Map<string | null, string[]>();
  for (const row of stackLocales(doc)) {
    const code = typeof row.locale === 'string' ? row.locale : '';
    if (!code || code === def) continue;
    const f = typeof row.formality === 'string' && row.formality ? row.formality : null;
    const list = groups.get(f) ?? [];
    list.push(code);
    groups.set(f, list);
  }
  return [...groups.entries()].map(([formality, locales]) => ({ formality, locales }));
}
