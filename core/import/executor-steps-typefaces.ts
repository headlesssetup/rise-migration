// Executor step handler helper — course typefaces: match by name on the TARGET
// account, recreate missing custom fonts, and settle stale theme slots. Split
// out of executor-steps-lifecycle.ts (size cap), which re-exports it.

import * as env from './envelopes';
import {
  targetByName,
  usedTypefaceIds,
  authoritativeTypefaceIds,
  courseTypefaceNames,
  similarTargetNames,
  resolveTypefaces,
  buildCreateTypefaceFonts,
  type Typeface,
} from './typefaces';
import { WriteError, payloadOf } from './executor-types';
import type { ExecCtx } from './executor-run-state';

// Match the course's typefaces to the TARGET account by name (FETCH_TYPEFACES)
// and recreate any custom font it lacks (upload .woff files → CREATE_TYPEFACE).
// Returns source typeface id → target typeface id.
export async function resolveAndRecreateTypefaces(
  ctx: ExecCtx,
  course: Record<string, unknown>,
  source: Map<string, Typeface>,
): Promise<Map<string, string>> {
  const { deps, mint, log, dryRun, result, send } = ctx;
  // Target typefaces are pre-fetched by the orchestrator against a live
  // existing course — FETCH_TYPEFACES 404s on a just-created course id.
  const target = deps.targetTypefaces ?? new Map<string, Typeface>();
  // Seed from the account-settings step (A): ids it already resolved/created
  // are reused as-is; only ids it didn't cover go through resolve/recreate.
  const seed = deps.typefaceIdMap ?? new Map<string, string>();
  const used = usedTypefaceIds(course);
  const unseeded = used.filter((id) => !seed.has(id));
  const courseNames = courseTypefaceNames(course);
  const { idMap, toRecreate, unresolved, foreignHeld } = resolveTypefaces(
    unseeded,
    source,
    targetByName(target),
    { rehostForeign: deps.rehostForeignTypefaces === true, courseNames },
  );
  for (const id of unseeded) {
    const name = courseNames.get(id);
    if (idMap.has(id) && name && !source.has(id)) {
      ctx.decide(
        'Fonts',
        `Font "${name}" is not in the source account's font list; used the target's font of the same name`,
      );
    }
  }
  for (const [k, v] of seed) idMap.set(k, v);
  for (const tf of foreignHeld) {
    result.flags.push({
      kind: 'typeface',
      detail: `Typeface "${tf.name}" is shared in from another tenant (${tf.fonts.length} file(s) archived) — tick "Re-host shared-in typefaces" to recreate it, or set the font manually`,
    });
  }

  for (const tf of toRecreate) {
    const uploaded = new Map<string, { key: string; url: string; type: string; filename: string }>();
    for (const f of tf.fonts) {
      const filename = f.original ?? f.key.split('/').pop() ?? 'font.woff';
      const yurl = payloadOf(
        await send(env.getYurl({ courseId: ctx.newCourseId, filename, assetPath: 'fonts/' }), 'set-theme'),
      );
      const newKey = dryRun ? `rise/fonts/${mint()}.woff` : String(yurl.key ?? '');
      const url = String(yurl.url ?? '');
      const type = String(yurl.type ?? 'font/woff');
      if (!dryRun) {
        const bytes = await deps.readFontBytes?.(f.key);
        if (!bytes) {
          log(`WARN missing archived font bytes for ${f.key} (skipping)`);
          continue;
        }
        const put = await deps.relay(env.s3Put({ url, base64Body: bytes.base64, contentType: type }));
        result.envelopes.push({ step: 'set-theme', label: 'S3 PUT (font)' });
        if (!put.ok) throw new WriteError(`Font S3 PUT failed (HTTP ${put.status})`, 'set-theme', put.text);
      } else {
        result.envelopes.push({ step: 'set-theme', label: 'S3 PUT (font)' });
      }
      uploaded.set(f.key, { key: newKey, url, type, filename: String(yurl.filename ?? filename) });
    }
    if (uploaded.size === 0) {
      result.flags.push({ kind: 'typeface', detail: `Custom font "${tf.name}" has no archived bytes — provision it manually on the target` });
      continue;
    }
    // A rejected CREATE_TYPEFACE (live DFO 2026-10-19: HTTP 400 for a custom
    // "Arial" built from one ArialUnicodeMS.ttf) must not abort a course whose
    // lessons and blocks are already written — flag the font as manual work
    // and keep going; the theme ships with the unmapped id (Rise falls back).
    let cresp: Record<string, unknown> | null = null;
    try {
      cresp = payloadOf(
        await send(env.createTypeface({ name: tf.name, fonts: buildCreateTypefaceFonts(tf, uploaded) }), 'set-theme'),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`WARN CREATE_TYPEFACE failed for "${tf.name}" (continuing): ${msg}`);
      result.flags.push({
        kind: 'typeface',
        detail: `Custom font "${tf.name}" could not be created on the target (${msg.slice(0, 160)}) — provision it manually`,
      });
      continue;
    }
    const newId = dryRun ? mint() : String(cresp.id ?? '');
    if (newId) idMap.set(tf.id, newId);
    else result.flags.push({ kind: 'typeface', detail: `CREATE_TYPEFACE returned no id for "${tf.name}"` });
  }
  // Only the AUTHORITATIVE slots are work: a theme-only id beside top-level
  // ids is a stale leftover the course does not display (mig30oct: two such
  // ids in Führungssparring were flagged as missing fonts).
  // A stale theme slot is not left holding a SOURCE-account id (Rise has
  // adopted theme ids before — v0.9.16c): it is pointed at the font the
  // course actually displays in that slot, and the choice is reported.
  const authoritative = authoritativeTypefaceIds(course);
  const theme = (course.theme ?? {}) as Record<string, unknown>;
  for (const u of unresolved) {
    const name = courseNames.get(u) ?? source.get(u)?.name;
    const label = name ? `"${name}"` : `typeface ${u}`;
    if (!authoritative.has(u)) {
      const slot = (['headingTypefaceId', 'bodyTypefaceId', 'uiTypefaceId'] as const).find((k) => theme[k] === u);
      const shown = slot ? course[slot] : undefined;
      if (typeof shown === 'string' && shown) {
        idMap.set(u, idMap.get(shown) ?? shown);
        const shownName = courseNames.get(shown) ?? source.get(shown)?.name;
        ctx.decide(
          'Fonts',
          `Theme slot ${slot} held a leftover font id from the source account (${name ? `"${name}", ` : ''}${u}) that the course does not display; set it to the course's own ${shownName ? `"${shownName}"` : 'font'} instead`,
        );
        continue;
      }
      result.flags.push({
        kind: 'typeface',
        detail: `Theme holds a leftover source-account font id (${label}) with no course font to replace it — check Theme → Fonts`,
      });
      continue;
    }
    const similar = name ? similarTargetNames(name, target) : [];
    result.flags.push({
      kind: 'typeface',
      detail:
        `Font ${label} is not on the target — upload it or pick a replacement in Theme → Fonts` +
        (similar.length ? ` (the target has similar: ${similar.map((n) => `"${n}"`).join(', ')})` : ''),
    });
  }
  return idMap;
}
