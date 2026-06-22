// Account-level exports: block templates, custom typefaces (+ font files), and
// the Review-360 items inventory (which flags Mighty bundles). Raw docs go to
// account/, inventories to _metadata/, fonts into the shared assets/ store.

import { downloadKeyList } from '@/core/assets';
import {
  buildBlockTemplateInventory,
  blockTemplatesToCsv,
  blockTemplatesToJson,
  extractBlockTemplates,
} from '@/core/census/block-templates';
import {
  buildReviewItemsInventory,
  extractReviewItems,
  reviewItemsToCsv,
  reviewItemsToJson,
} from '@/core/census/review-items';
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
import type { ProgressEvent } from './shared';

export interface AccountExtrasSummary {
  blockTemplates: number;
  typefaces: number;
  fonts: { written: number; deduped: number; failed: number };
  reviewItems: number;
  mightyItems: number;
}

/** Fetch a RAW_RESULT export; returns {raw, doc} or null (logging the error). */
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
    reviewItems: 0,
    mightyItems: 0,
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

  // 2) Typefaces (needs a courseId context) + font files.
  const courseId = (await storage.listSaved())[0];
  if (!courseId) {
    onEvent({ kind: 'log', message: 'Typefaces skipped: no saved course for context.' });
  } else {
    const tf = await fetchRaw({ type: 'FETCH_TYPEFACES', courseId }, 'Typefaces', onEvent);
    if (tf) {
      await storage.writeTypefaces(tf.raw);
      const rows = buildTypefaceInventory(extractTypefaces(tf.doc));
      await storage.writeTypefaceInventory(typefacesToJson(rows), typefacesToCsv(rows));
      summary.typefaces = rows.length;

      const fontKeys = collectFontKeys(tf.doc);
      if (fontKeys.length) {
        const res = await downloadKeyList(fontKeys, storage, cdnDownload);
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

  // 3) Review-360 items (flag Mighty).
  const ri = await fetchRaw({ type: 'REVIEW_ITEMS' }, 'Review items', onEvent);
  if (ri) {
    await storage.writeReviewItems(ri.raw);
    const rows = buildReviewItemsInventory(extractReviewItems(ri.doc));
    await storage.writeReviewItemsInventory(reviewItemsToJson(rows), reviewItemsToCsv(rows));
    summary.reviewItems = rows.length;
    summary.mightyItems = rows.filter((r) => r.mighty).length;
    onEvent({
      kind: 'log',
      message: `Review items: ${rows.length} (${summary.mightyItems} Mighty) → account/ + _metadata/.`,
    });
  }

  return summary;
}
