# Findings — 2026-10-11 EU → US run (`12october-migrate`, tool 0.9.12)

Source: EU plane, archive `12october-migrate` (exported as "John Doe" /
`migration@tictaclearn.de`; courses owned by Anna Helmbold). Target: US plane.
First production run in the **EU → US** direction (the PRD's business case is
US → EU).

| Source course | Target course | Lessons | Blocks | Uploads | Result |
|---|---|---|---|---|---|
| `Df_CnNbDWXVsPfW5iJMLevRRZ35XkDBe` Film Fysisk träning under cancerbehandling | `l1UDWI-om_v98bO92-MD-sftcTi3nxsR` | 1 | 1 | 4 | imported, parity OK, 0 surviving keys |
| `5jrhj2HYK1k8wzWi5zxvuLIYeAXV2X83` FaR arrangörsutbildning | `0SKUqFc19f3uK0PaLIdBmcUOpXyTN9DX` | 3 | 22 | 10 | imported, parity OK, 0 surviving keys |
| `rPQnFyhayus0nOZB2BHpxH1AplXkErbe` Förbättringsarbeten inom cancerrehabilitering | `ScM9Zwfbw-fVz4Wwitoa9rznIUZW4Jwm` | 15 | 151 | 82 | imported, parity OK, 0 surviving keys, 2 manual (oversize originals) |

Operator verified the US dashboard cards and previews: matching.

## What went right

- Archive integrity: all course/asset-manifest sha256 match; 91/91 asset files
  present with matching hash + size; every `rise/courses/…` key covered; no
  cross-course keys. No Storyline/Mighty, mondrian, AI scenario, bank draws,
  intra-course lesson links or stacks.
- EU built-in refs (`cdn.eu.articulate.com`, `articulateusercontent.eu`,
  `images.eu.articulate.com` theme covers) raised **no** `builtin-asset` flags on
  the US plane — the probes passed.
- Typefaces (Lato, Merriweather, Open Sans — all built-ins) matched by name on
  the target once the account export was in the folder. No duplicates created.
- Novelty: 0 new variants, 30 new fields → accepted into the catalog (this commit).

## Findings

1. **Course import without the account export ships SOURCE typeface ids.**
   The first readiness check found `account/` with only `folders.json`.
   Without `account/typefaces.json`, `sourceTypefaces` is empty and the theme is
   written verbatim with source ids (`core/import/executor-steps-lifecycle.ts`
   ~279) → wrong font on target. Nothing warns. Every course doc already carries
   `course.typefaces` (id → name), which would be enough to name-match built-ins.
2. **Oversize OPTIONAL provenance raises a manual-work flag.** The two
   oversize files were `media.video.inputKey` originals (380 MB, 339 MB); the
   played transcodes (41 / 38 MB) migrated fine. The planner checks
   `exceedsUploadLimit` before considering optionality
   (`core/import/plan-lesson-body.ts` ~419), so optional provenance becomes
   "⚠ too large — attach manually". This time the operator *wanted* the originals
   on the target, so the flag was useful — but its wording/location is wrong (next).
3. **Manual-work location says "Course-level" for a block-level item.** The
   report's `manualWork[].location` was `Course-level`; the flag detail does name
   the block id (`cmradytu…`, `cmramsc6…`), but the operator had to be told
   "lesson 3 'Processguide', block 4 of 6". Report the lesson title + block
   position + original filename (`media.video.originalUrl`) + archive path.
4. **Expected divergence `course.media.image` is invisible and over-worded.**
   Parity reports "target keeps Rise's random default" for courses with an empty
   source `course.media`; the dashboard card and cover come from
   `theme.coverImage` (copied verbatim) and looked identical. The field is not
   visibly rendered anywhere observed. Don't present it as something the operator
   might need to fix.
5. **Folder not recreatable when the course owner's folder is invisible.**
   All three courses sat in `3d32e08d-…` (owner's folder) which the exporting
   account can't list, so `folders.json` lacks it and the courses landed in the
   target root. The inventory shows an empty `folderPath` with no explanation.
6. **Custom typeface with no archived bytes.** "TicTac Learn" (3 `rise/fonts/…`
   woff files: Maax, Maax-Italic, Maax-Bold) is in `account/typefaces.json` but
   none of its files are in `typefaces.assets.json`. Not used by these courses.
   If the account-settings step ever recreates it, `importAccountFonts` sends a
   `GET_YURL` per file BEFORE checking the bytes exist
   (`entrypoints/sidepanel/orchestrator/import-account.ts` ~256) — 3 wasted paced
   writes, then a correct "no uploadable files — skipping".
7. **Review 360 link inside content stays on the source account.** A button in
   `rPQnFy…` points at `https://360.articulate.com/review/content/71c97bda-…/review`.
   Copied verbatim (correct by copy-faithful rule), but it is a cross-account
   reference the scanner does not surface.
8. **`metadata` is VOLATILE in parity**, so the newly accepted
   `metadata.contentValidation.*`, `metadata.createdVia`, `metadata.isHeroImage`
   are sent but their retention on the target is unverified.
9. **AI captions** (`captions[].isAiGenerated: true`, Swedish `.vtt`) migrated
   as plain caption keys. Fine; noted as first sighting.

## Upload size cap — where it comes from

`MAX_UPLOAD_BASE64 = 350 MiB` (`core/import/plan-types.ts:34`, ≈ 262 MB raw) is
**our** ceiling, not Rise's. The panel reads the whole asset from the archive,
base64-encodes it, then decodes back to a Blob for the direct S3 PUT
(`entrypoints/sidepanel/orchestrator/import-shared.ts` ~172–213). The whole file
lives in memory as one giant string, and V8 caps a single string at ~512 MiB —
the 380 MB original would have been ~507 MiB of base64. The cap prevents a panel
OOM/crash. Rise's own upload size limit is UNCAPTURED.

## Manual follow-up done by the operator (this run)

- Replace the video in `ScM9Zwfb…` lesson 3 "Förbättringsarbete - Processguide",
  block 4/6 with `TicTac_Region-Blekinge_Trailer_Aktiva-overlamningar..mp4`, and
  lesson 8 "Förbättringsarbete - Samverkan mellan CaRe och palliativ medicinsk
  enhet", block 4/14 with `TicTac_Region-Blekinge_Trailer_samarbete_CaRe_och_palliativa.mp4`
  (renamed copies in `~/Downloads/12october-manual-upload/`, with the two
  `ai-captions-*.vtt`); re-check captions after the replace.

## TODO

- **U1 — lift the upload cap (stream, don't base64).** Hand the archive `File`
  (it is already a `Blob`) straight to `fetch(PUT)` for asset and font uploads;
  drop the base64 round-trip for the panel-direct path. Keep a cap only for the
  remaining `runtime.sendMessage` hops (Storyline `TODO(H5)`). Then
  `exceedsUploadLimit` becomes a capture-backed Rise limit (capture it first) or
  goes away. Would have migrated both originals automatically.
- **U2 — typeface fallback without `account/typefaces.json`.** Build the source
  map from `course.typefaces` (id → name) and name-match built-ins on the target;
  and/or a loud preflight warning "account export missing — fonts will not be
  remapped" (finding 1).
- **U3 — optional-provenance oversize handling.** Decide policy: either flag as
  "optional original not migrated (attach manually if wanted)" with its own
  wording, or blank silently like `optionalUnavailable`. Moot if U1 lands (finding 2).
- **U4 — manual-work location = lesson title + block n/N + original filename +
  archive file path** for media flags (finding 3).
- **U5 — soften/hide the `course.media.image` expected divergence** in the
  summary (finding 4).
- **U6 — explain unrecreatable folders** in inventory/import summary: "folder
  `<id>` not visible to the exporting account → course goes to root" (finding 5).
- **U7 — font recreate: check archived bytes before `GET_YURL`**; report
  custom typefaces with missing bytes at account-export time (finding 6).
- **U8 — surface `360.articulate.com/review/…` links** (and other source-account
  URLs) as an informational flag in the novelty/import report (finding 7).
- **U9 — verify `metadata` retention** on read-back for the accepted metadata
  fields, or document them as best-effort (finding 8).
