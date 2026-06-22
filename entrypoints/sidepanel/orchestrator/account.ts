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
  extractTypefaces,
  typefacesToCsv,
  typefacesToJson,
} from '@/core/census/typefaces';
import type { Storage } from '@/core/storage/storage';
import type { BackgroundRequest } from '@/shared/messaging';
import { cdnDownload } from './assets';
import { rpc } from '../rpc';
import { extractItems, type ProgressEvent } from './shared';

export interface AccountExtrasSummary {
  blockTemplates: number;
  typefaces: number;
  fonts: { written: number; deduped: number; failed: number };
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
      await storage.writeTypefaces(tf.raw);
      const rows = buildTypefaceInventory(extractTypefaces(tf.doc));
      await storage.writeTypefaceInventory(typefacesToJson(rows), typefacesToCsv(rows));
      summary.typefaces = rows.length;

      const fontKeys = collectFontKeys(tf.doc);
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
        );
        summary.fonts = { written: res.written, deduped: res.deduped, failed: res.failed.length };
        // Persist the font key→archive-file map so the import can re-upload
        // custom font bytes by their source key (CREATE_TYPEFACE on the target).
        await storage.writeFontManifest(JSON.stringify(res.files, null, 2));
      }
      onEvent({
        kind: 'log',
        message: `Typefaces: ${rows.length} (fonts ${summary.fonts.written} new, ${summary.fonts.deduped} deduped, ${summary.fonts.failed} failed).`,
      });
    }
  }

  // (No Review 360 fetch — Storyline/Mighty blocks are recreated as placeholders;
  // their bundles are obtained out of band, never from the Review servers.)

  return summary;
}
