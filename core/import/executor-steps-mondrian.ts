// Executor step handler — mondrian (Custom block) blockument recreation.
// Capture-proven flow (docs/rise-api-reference.md §mondrian, 2026-08-31):
//   1. POST createFromBlank {parentId: newCourseId, parentType:"course"}
//      → a fresh blockument owning one root "Canvas" group item (ADOPTED).
//   2. Per asset: POST signed-asset-url {name, blockumentId} → presigned S3
//      PUT (byte transfer, outside pacing; ACL echo rides isPresignedPut) →
//      ducks CRUSH_IMAGE {courseId, original:<mondrian path>} — this pipeline
//      DOES crush (the editor does; unlike block media, which never does).
//   3. Full-state transactions: the doc first, then items parents-first (the
//      editor writes one entity per transaction; mirrored).
// The source→new blockumentId lands in ctx.blockumentMap; create-blocks swaps
// every block's `blockumentId` through it (a dangling id 404s boot).

import {
  applyAssetMap,
  blockumentTransaction,
  collectGraphAssets,
  createBlockumentFromBlank,
  crushMondrianAsset,
  remapBlockumentGraph,
  signedAssetUrl,
  type BlockumentGraph,
  type BlockumentItem,
} from '@/core/mondrian';
import * as env from './envelopes';
import { MAX_UPLOAD_BASE64, type PlanStep } from './plan';
import { WriteError } from './executor-types';
import type { ExecCtx } from './executor-run-state';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function handleCreateBlockument(
  ctx: ExecCtx,
  step: Extract<PlanStep, { kind: 'create-blockument' }>,
): Promise<void> {
  const { deps, mint, mintUuid, log, dryRun, result, keyMap, pfx, send } = ctx;

  // A blockument is 1:1 with its block in every capture, but be safe: a second
  // block referencing the same source blockument reuses the recreated one.
  if (ctx.blockumentMap.has(step.sourceBlockumentId)) {
    log(`${pfx()} reuse blockument ${step.sourceBlockumentId} (already recreated)`);
    return;
  }
  const graph = deps.input.blockuments?.get(step.sourceBlockumentId) as
    | BlockumentGraph
    | undefined;
  if (!graph) {
    throw new WriteError(
      `No archived graph for blockument ${step.sourceBlockumentId} — re-export the course with 0.9.9+`,
      step.kind,
    );
  }
  const plane = deps.targetPlane;
  if (!plane && !dryRun) {
    throw new WriteError(
      'Target plane unknown — cannot address mondrian-api (open a logged-in Rise tab and retry)',
      step.kind,
    );
  }
  const p = plane ?? 'eu'; // dry-run only: envelopes are recorded, never sent

  // 1. Create the empty blockument parented to the NEW course.
  const created = await send(createBlockumentFromBlank(p, ctx.newCourseId), step.kind);
  let newBid: string;
  let canvasId: string;
  if (dryRun) {
    newBid = mintUuid();
    canvasId = mintUuid();
  } else {
    const docs = isObject(created.blockuments) ? Object.keys(created.blockuments) : [];
    newBid = docs[0] ?? '';
    const items = isObject(created.items) ? Object.values(created.items) : [];
    const canvas = items.find((i) => isObject(i) && i.parentId === newBid) as
      | { id?: unknown }
      | undefined;
    canvasId = typeof canvas?.id === 'string' ? canvas.id : '';
    if (!newBid || !canvasId) {
      throw new WriteError(
        'createFromBlank returned no blockument/canvas id',
        step.kind,
        JSON.stringify(created).slice(0, 300),
      );
    }
  }

  // 2. Remap the archived graph onto the created blockument.
  const remapped = remapBlockumentGraph(graph, step.sourceBlockumentId, newBid, canvasId, mintUuid);

  // 3. Upload the graph's assets and build the asset id/path map.
  const assetMap = new Map<string, { id: string; path: string }>();
  for (const rec of collectGraphAssets(graph)) {
    let bytes: { base64: string; contentType?: string } | null = null;
    if (!dryRun) {
      bytes = await deps.readAsset(rec.path);
      if (!bytes) {
        throw new WriteError(
          `Missing archived bytes for mondrian asset ${rec.path} — re-export the course assets`,
          step.kind,
        );
      }
      if (bytes.base64.length > MAX_UPLOAD_BASE64) {
        throw new WriteError(
          `Mondrian asset ${rec.path} is too large to upload via the extension`,
          step.kind,
        );
      }
    }
    const signed = await send(signedAssetUrl(p, rec.name, newBid), step.kind);
    let newId: string;
    let newPath: string;
    let putUrl = '';
    let mime = 'application/octet-stream';
    if (dryRun) {
      newId = mint();
      const ext = rec.path.split('.').pop() ?? 'png';
      newPath = `mondrian/assets/blockument/${newBid}/${newId}.${ext}`;
    } else {
      const asset = isObject(signed.asset) ? signed.asset : {};
      newId = typeof asset.id === 'string' ? asset.id : '';
      newPath = typeof asset.path === 'string' ? asset.path : '';
      putUrl = typeof signed.url === 'string' ? signed.url : '';
      mime = typeof signed.mimeType === 'string' ? signed.mimeType : mime;
      if (!newId || !newPath || !putUrl) {
        throw new WriteError(
          'signed-asset-url returned no asset id/path/url',
          step.kind,
          JSON.stringify(signed).slice(0, 300),
        );
      }
    }
    if (!dryRun && bytes) {
      const put = await deps.relay(
        env.s3Put({ url: putUrl, base64Body: bytes.base64, contentType: mime }),
      );
      result.envelopes.push({ step: step.kind, label: 'S3 PUT (mondrian asset)' });
      if (!put.ok) {
        throw new WriteError(`Mondrian asset S3 PUT failed (HTTP ${put.status})`, step.kind, put.text);
      }
    } else {
      result.envelopes.push({ step: step.kind, label: 'S3 PUT (mondrian asset)' });
    }
    // The editor crushes right after the PUT (capture) — mirror it. The derived
    // rise/courses/<newCourseId>/… key lives server-side; items don't carry it.
    await send(crushMondrianAsset(ctx.newCourseId, newPath), step.kind);
    assetMap.set(rec.id, { id: newId, path: newPath });
    keyMap.set(rec.path, newPath); // old mondrian path must never survive
  }

  // 4. Write the document, then its items (parents first), as full-state
  //    transactions — one entity per call, mirroring the editor.
  const items: BlockumentItem[] = applyAssetMap(remapped.items, assetMap);
  await send(blockumentTransaction(p, newBid, { blockument: remapped.doc }), step.kind);
  for (const item of items) {
    await send(blockumentTransaction(p, newBid, { items: { [item.id]: item } }), step.kind);
  }

  ctx.blockumentMap.set(step.sourceBlockumentId, newBid);
  log(
    `${pfx()} OK   blockument "${step.title || step.sourceBlockumentId}" recreated as ${newBid} ` +
      `(${items.length} item(s), ${assetMap.size} asset(s))`,
  );
}
