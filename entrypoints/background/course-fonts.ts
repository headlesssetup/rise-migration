// Recover a course's font FILES from the Rise editor page's @font-face rules
// (issue #12 "route B", automated after mig30oct 2026-10-30). FETCH_TYPEFACES
// lists only typefaces the account owns; a font shared in from another tenant
// (mig30oct: "DB Head", "DB Sans", "DBNeoScreenSans") resolves nowhere through
// the API — yet the editor renders it, so its stylesheet names every file:
//
//   @font-face { font-family: rise-tf-<hex>; font-weight: 700;
//                src: url("https://articulateusercontent.com/rise/fonts/auth0|…/x-DBHead-Black.woff") }
//
// `<hex>` is the typeface ID, each character as a 6-digit hex code point
// ("000047 000034 …" → "G4…"). Read-only: boot the course editor in an INACTIVE
// temporary tab (the same move token refresh already makes), read the rules,
// close the tab. One call per course; the panel paces it like any authoring read.

import { courseEditorUrl } from '@/shared/rise-editor';
import { resolveTarget, waitForCreatedTabComplete } from './tabs';
import type { TabPin } from '@/shared/messaging';

export interface CourseFontFace {
  typefaceId: string;
  weight: string;
  style: string;
  url: string;
}

/** Decode a `rise-tf-<hex>` family into its typeface id (null if not one). */
export function decodeRiseTypefaceFamily(family: string): string | null {
  const m = /^["']?rise-tf-([0-9a-f]+)["']?$/i.exec(family.trim());
  if (!m || m[1]!.length % 6 !== 0) return null;
  let id = '';
  for (let i = 0; i < m[1]!.length; i += 6) id += String.fromCodePoint(parseInt(m[1]!.slice(i, i + 6), 16));
  return id;
}

// Serialized into the page by executeScript — must stay self-contained.
function readFontFaces(): { family: string; weight: string; style: string; src: string }[] {
  const out: { family: string; weight: string; style: string; src: string }[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet
    }
    for (const r of Array.from(rules ?? [])) {
      if (!(r instanceof CSSFontFaceRule)) continue;
      const family = r.style.getPropertyValue('font-family');
      if (!/rise-tf-/i.test(family)) continue;
      out.push({
        family,
        weight: r.style.getPropertyValue('font-weight') || '400',
        style: r.style.getPropertyValue('font-style') || 'normal',
        src: r.style.getPropertyValue('src'),
      });
    }
  }
  return out;
}

/** Boot `courseId`'s editor in a temporary inactive tab on the pinned/active
 *  plane, poll its stylesheets until the course's `rise-tf-*` rules appear (the
 *  SPA injects them after boot), and return them decoded. Never throws. */
export async function scrapeCourseFontFaces(
  courseId: string,
  pin?: TabPin,
  timeoutMs = 25_000,
): Promise<{ ok: true; faces: CourseFontFace[] } | { ok: false; error: string }> {
  const resolved = await resolveTarget(pin);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const url = courseEditorUrl(resolved.target.url, courseId);
  if (!url) return { ok: false, error: 'Could not build the course editor URL' };
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    if (typeof tabId !== 'number') return { ok: false, error: 'Temporary editor tab has no id' };
    await waitForCreatedTabComplete(tabId, 20_000);
    const deadline = Date.now() + timeoutMs;
    let rows: ReturnType<typeof readFontFaces> = [];
    let stable = 0;
    while (Date.now() < deadline) {
      const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: readFontFaces });
      const now = (inj?.result as ReturnType<typeof readFontFaces> | undefined) ?? [];
      // Done once rules exist and stopped growing for two polls.
      stable = now.length > 0 && now.length === rows.length ? stable + 1 : 0;
      rows = now;
      if (stable >= 2) break;
      await new Promise((r) => setTimeout(r, 1_500));
    }
    const faces: CourseFontFace[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const typefaceId = decodeRiseTypefaceFamily(row.family);
      const src = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(row.src)?.[1];
      if (!typefaceId || !src) continue;
      const sig = `${typefaceId}|${row.weight}|${row.style}|${src}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      faces.push({ typefaceId, weight: row.weight, style: row.style, url: src });
    }
    return { ok: true, faces };
  } catch (e) {
    return { ok: false, error: `Font-face scrape failed: ${(e as Error).message}` };
  } finally {
    if (typeof tabId === 'number') await chrome.tabs.remove(tabId).catch(() => {});
  }
}
