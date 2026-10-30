// Account-level exports: block templates and custom typefaces (+ font files).
// Raw docs go to account/, inventories to _metadata/, fonts into the shared
// assets/ store. (We deliberately do NOT touch the Review 360 servers — Storyline
// /Mighty blocks are recreated as placeholders; their bundles are handled out of
// band.)

import { downloadKeyList, type AssetSink } from '@/core/assets';
import {
  buildBlockTemplateInventory,
  blockTemplatesToCsv,
  blockTemplatesToJson,
  extractBlockTemplates,
} from '@/core/census/block-templates';
import {
  buildTypefaceInventory,
  collectFontKeys,
  courseTypefaceNameMap,
  extractTypefaces,
  mergeForeignTypefaces,
  typefacesFromFontFaces,
  typefacesToCsv,
  typefacesToJson,
  unknownTypefaceIdsOf,
} from '@/core/census/typefaces';
import { DEFAULT_PACING, pacedDelay } from '@/core/pacing/delay';
import type { Storage } from '@/core/storage/storage';
import type { BackgroundRequest } from '@/shared/messaging';
import { cdnDownload } from './assets';
import { rpc } from '../rpc';
import { extractItems, type ProgressEvent } from './shared';

export interface AccountExtrasSummary {
  blockTemplates: number;
  typefaces: number;
  fonts: { written: number; deduped: number; failed: number };
  /** Shared-in (foreign-tenant) typefaces resolved per course / still unknown. */
  foreign: { resolved: number; unresolved: number };
}

/** Fetch a RAW_RESULT export; returns {raw, doc} or null (logging the error). */
/** A course id valid on the LIVE account (the FETCH_TYPEFACES context). Prefers
 *  the live library (page 0); falls back to a saved id. */
async function liveCourseId(storage: Storage): Promise<string | undefined> {
  try {
    const resp = await rpc({ type: 'SEARCH_COURSES', page: 0, pageSize: 1 });
    if (resp.type === 'SEARCH_RESULT' && resp.result.ok) {
      const id = extractItems(resp.result.data)[0]?.id;
      if (id) return id;
    }
  } catch {
    /* fall back to a saved id */
  }
  return (await storage.listSaved())[0];
}

async function fetchRaw(
  req: BackgroundRequest,
  label: string,
  onEvent: (e: ProgressEvent) => void,
): Promise<{ raw: string; doc: unknown } | null> {
  const resp = await rpc(req);
  if (resp.type !== 'RAW_RESULT' || !resp.result.ok) {
    const err =
      resp.type === 'RAW_RESULT' && !resp.result.ok ? resp.result.error : 'unexpected response';
    onEvent({ kind: 'log', message: `${label} unavailable: ${err}` });
    return null;
  }
  return resp.result.data;
}

export async function fetchAccountExtras(
  storage: Storage,
  onEvent: (e: ProgressEvent) => void,
): Promise<AccountExtrasSummary> {
  const summary: AccountExtrasSummary = {
    blockTemplates: 0,
    typefaces: 0,
    fonts: { written: 0, deduped: 0, failed: 0 },
    foreign: { resolved: 0, unresolved: 0 },
  };

  // 1) Block templates.
  const bt = await fetchRaw({ type: 'FETCH_BLOCK_TEMPLATES' }, 'Block templates', onEvent);
  if (bt) {
    await storage.writeBlockTemplates(bt.raw);
    const rows = buildBlockTemplateInventory(extractBlockTemplates(bt.doc));
    await storage.writeBlockTemplateInventory(
      blockTemplatesToJson(rows),
      blockTemplatesToCsv(rows),
    );
    summary.blockTemplates = rows.length;
    onEvent({ kind: 'log', message: `Block templates: ${rows.length} → account/ + _metadata/.` });
  }

  // 2) Typefaces (needs a courseId context) + font files. The context course
  // must exist on the LIVE account the tab is on — an archived id from a
  // different account/plane 404s — so prefer a course from the live library and
  // only fall back to a saved id.
  const courseId = await liveCourseId(storage);
  if (!courseId) {
    onEvent({ kind: 'log', message: 'Typefaces skipped: no course available for context.' });
  } else {
    const tf = await fetchRaw({ type: 'FETCH_TYPEFACES', courseId }, 'Typefaces', onEvent);
    if (tf) {
      // Shared-in typefaces (issue #12): the account list omits typefaces shared
      // in from another tenant, yet saved courses reference them. Re-ask
      // FETCH_TYPEFACES in the context of each affected course and merge what
      // comes back as `foreign`. Paced (authoring reads); one call per course,
      // skipping courses whose unknown ids an earlier call already resolved.
      let doc: unknown = tf.doc;
      let raw = tf.raw;
      const known = new Set(extractTypefaces(tf.doc).map((t) => String(t.id ?? '')));
      const pending = new Map<string, Set<string>>(); // unknown id → course ids
      for (const id of await storage.listSaved()) {
        const c = await storage.readCourse(id);
        if (!c) continue;
        try {
          for (const tfId of unknownTypefaceIdsOf(JSON.parse(c), known)) {
            if (!pending.has(tfId)) pending.set(tfId, new Set());
            pending.get(tfId)!.add(id);
          }
        } catch {
          /* unreadable course doc — the course export already reported it */
        }
      }
      if (pending.size) {
        onEvent({
          kind: 'log',
          message: `Typefaces: ${pending.size} shared-in typeface id(s) not in the account list — resolving per course…`,
        });
        const perCourse: { courseId: string; doc: unknown }[] = [];
        const tried = new Set<string>();
        for (const [tfId, courses] of pending) {
          if (known.has(tfId)) continue; // resolved by an earlier course's call
          const cid = [...courses].find((c) => !tried.has(c)) ?? [...courses][0]!;
          if (tried.has(cid)) continue;
          tried.add(cid);
          await pacedDelay(DEFAULT_PACING);
          const r = await fetchRaw({ type: 'FETCH_TYPEFACES', courseId: cid }, `Typefaces (course ${cid})`, onEvent);
          if (!r) continue;
          perCourse.push({ courseId: cid, doc: r.doc });
          for (const t of extractTypefaces(r.doc)) if (typeof t.id === 'string') known.add(t.id);
        }
        // Route B (mig30oct 2026-10-30): ids the API never listed are read
        // from the course editor's own @font-face rules (temporary inactive
        // tab, one per course, paced like any authoring read).
        const scraped = new Set<string>();
        const stillUnknown = [...pending].filter(([id]) => !known.has(id));
        for (const [i, [tfId, courses]] of stillUnknown.entries()) {
          if (known.has(tfId)) continue;
          const cid = [...courses].find((c) => !scraped.has(c));
          if (!cid) continue;
          scraped.add(cid);
          await pacedDelay(DEFAULT_PACING);
          onEvent({
            kind: 'log',
            message: `  [${i + 1}/${stillUnknown.length} fonts] reading @font-face rules from course ${cid}'s editor (temporary tab)…`,
          });
          const resp = await rpc({ type: 'SCRAPE_COURSE_FONTS', courseId: cid });
          if (resp.type !== 'COURSE_FONTS_RESULT' || !resp.result.ok) {
            const err = resp.type === 'COURSE_FONTS_RESULT' && !resp.result.ok ? resp.result.error : 'unexpected response';
            onEvent({ kind: 'log', message: `  ⚠ @font-face read failed for course ${cid}: ${err}` });
            continue;
          }
          let names = new Map<string, string>();
          try {
            names = courseTypefaceNameMap(JSON.parse((await storage.readCourse(cid)) ?? 'null'));
          } catch {
            /* unreadable course doc — no names, nothing recoverable */
          }
          const recovered = typefacesFromFontFaces(resp.result.data.faces, names);
          if (recovered.length) perCourse.push({ courseId: cid, doc: { typefaces: recovered } });
          for (const t of recovered) known.add(String(t.id));
        }
        const { merged, added } = mergeForeignTypefaces(tf.doc, perCourse);
        doc = merged;
        raw = JSON.stringify(merged, null, 2);
        summary.foreign.resolved = added.length;
        for (const a of added) {
          onEvent({ kind: 'log', message: `  • shared-in typeface "${a.name}" (${a.id}) resolved via course ${a.sharedVia} — archived as foreign (re-host needs operator opt-in at import)` });
        }
        for (const [tfId, courses] of pending) {
          if (known.has(tfId)) continue;
          summary.foreign.unresolved += 1;
          onEvent({
            kind: 'log',
            message: `  ⚠ shared-in typeface ${tfId} used by ${courses.size} course(s) could NOT be resolved (FETCH_TYPEFACES per course, then the editor's @font-face rules) — the import will flag it by name`,
          });
        }
      }
      await storage.writeTypefaces(raw);
      const rows = buildTypefaceInventory(extractTypefaces(doc));
      await storage.writeTypefaceInventory(typefacesToJson(rows), typefacesToCsv(rows));
      summary.typefaces = rows.length;

      const fontKeys = collectFontKeys(doc);
      if (fontKeys.length) {
        // Fonts are account-level — store them under account/assets/ (separate
        // from the huge content-addressed course assets/ store).
        const fontSink: AssetSink = {
          hasAsset: (n) => storage.hasAccountAsset(n),
          writeAsset: (n, b) => storage.writeAccountAsset(n, b),
        };
        const res = await downloadKeyList(
          fontKeys,
          fontSink,
          cdnDownload,
          undefined,
          'account/assets/',
          {
            label: 'fonts',
            onProgress: (message) => onEvent({ kind: 'log', message }),
          },
        );
        summary.fonts = { written: res.written, deduped: res.deduped, failed: res.failed.length };
        // Persist the font key→archive-file map so the import can re-upload
        // custom font bytes by their source key (CREATE_TYPEFACE on the target).
        await storage.writeFontManifest(JSON.stringify(res.files, null, 2));
      }
      onEvent({
        kind: 'log',
        message: `Typefaces: ${rows.length} (fonts ${summary.fonts.written} new, ${summary.fonts.deduped} deduped, ${summary.fonts.failed} failed${summary.foreign.resolved ? `; ${summary.foreign.resolved} shared-in resolved` : ''}${summary.foreign.unresolved ? `; ${summary.foreign.unresolved} shared-in UNRESOLVED` : ''}).`,
      });
    }
  }

  // (No Review 360 fetch — Storyline/Mighty blocks are recreated as placeholders;
  // their bundles are obtained out of band, never from the Review servers.)

  return summary;
}
