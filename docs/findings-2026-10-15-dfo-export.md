# Findings — DFO export (US → EU), 2026-10-15

Archive: `~/Downloads/DFO-15oct` (`rise-local-archive` v1, `state: ready`,
tool 0.9.12, source plane **us**, account "Hanne Jacobsen" / dfo.no).
Pre-import analysis only — nothing imported yet.

## Export health

| | |
|---|---|
| Courses | 169 saved, 0 skipped, 0 failed (160 regular, 9 `onePage`) |
| Stacks (multi-language) | 0 |
| Blocks | 55 variants, **0 new variants**; 312 new field paths (168 distinct) |
| Assets | 7462 keys → 5453 files (5.0 GB), 0 failed, 0 orphaned; 78 × `403` all OPTIONAL provenance (71 `inputKey`, 4 `originalImage`, 3 `media.tmp`) → blanked silently per policy |
| Storyline | 15 blocks / 14 courses, all SL 3.96 / 3.103 → `automatic`; 14 zips ≈ 1 MB each; 1 `source-placeholder` (empty block in test course `87SVEKKM…`) |
| Mondrian | 130 blocks / 34 courses, every `blockumentId` has its doc in `blockuments/` |
| Question banks | 1 bank "test", 0 questions, 0 draw-from-bank blocks |
| AI Scenario | none |
| Typefaces | 21 (4 client-uploaded: Arial, Source Sans Pro, SourceSans3 DF, SourceSerif4 DF), all 78 font files archived |
| Label sets | 17 custom (Norwegian), `labelSetId` set on all 169 courses |

## Blockers / decisions before import

1. **`blocumentId` (misspelled) — never-seen cross-ref-shaped field.** 24
   `mondrian/mondrian` blocks across 7 courses (`6Pe6WMwL`, `8OZG6DoK`,
   `GtgN_Ipg`, `Je-vv1Wk`, `RhtFcZkv`, `Wfwi4iiE`, `zE8FIH7k`) carry BOTH
   `blockumentId` (the course's own doc, archived + remapped) AND
   `blocumentId` (4 distinct ids: `5bd3d602…`, `25eff0b9…`, `d50b594d…`,
   `be06aefa…`). Those ids are the **block-template library's** blockuments
   (`account/block-templates.json` carries the same `blocumentId` on its
   template blocks) — i.e. "cloned-from-template" provenance. They are NOT in
   `blockuments/`, `core/mondrian/collect.ts` only matches `blockumentId`, so
   the value ships verbatim pointing at a US-only mondrian document. Not in
   `catalog.fields.json`, not in any capture. Unknown whether EU preview/publish
   boot resolves it (the 2026-08-31 failure mode) or ignores it.
   → Options: (a) strip `blocumentId` on write (block templates are not
   migrated anyway, so the provenance is dead on EU); (b) import ONE affected
   course first (`GtgN_Ipgfs57hVCTWDuOvo0RY2HQhTaO` "Mitt ledelsesgrunnlag",
   1 such block) and preview + publish it before the batch. Recommend (b)
   with (a) as the fix if boot 404s.
2. **Upload cap margin.** Five assets sit at 214–260 MB raw (GIF screen
   recordings in `1BNmePjC…` "Fakturaadministrator i Unit4 ERP" ×3 and
   `ldf3N1V0…` "En reise gjennom regnskapsdivisjonen" ×1, one 223 MB mp4 in
   `3KLsnzUp…` / `5SE-_ZLF…`). Largest = 260.5 MB → 347.3 MiB base64, under
   `MAX_UPLOAD_BASE64` (350 MiB) by 2.7 MiB. Nothing is over the cap, but the
   panel will hold a ~350 MiB string; Rise's own limit for a 260 MB GIF through
   `CRUSH_IMAGE` is uncaptured. Run those 4 courses individually, watch memory.
   (TODO U1 still open.)
3. **3 courses reference typeface ids absent from the account catalog**
   (`607E5ZyF…` ×3 courses — "Kurs i medarbeiderskap", "Kurs i kommunikasjon
   og samhandling på jobb", "Bli bevisst egen kompetanse og veien videre";
   `blgF3jZM…`/`QBvtiXcz…` — "En sak for Walter"). All 4 sit in no folder
   (`folderPath: ""`) — likely courses shared INTO this account whose typefaces
   live in another account. `resolveTypefaces` reports them `unresolved` →
   manual-work flag; the EU course will fall back to the default font. (TODO U2.)

## Expected flags (no action needed before import)

- **1 cross-course lesson link**: `lessons[…]` button in one course points at
  a lesson of another course → `executor-steps-links` flags it loudly for
  manual re-pick. Intra-course links: 15, handled.
- **1 source-account share link** in authored HTML:
  `rise.articulate.com/share/Dxy0Sk9S…` = exported course "7 tips: Lærlingers
  beste tips til nye lærlinger" — must be re-pointed to the EU share URL after
  that course exists. (TODO U8.)
- **Built-in library refs**: 378 distinct (6191 uses) `assets/rise/…` /
  `cdn.articulate.com/assets/…` + 539 `content-pass/uploads/…` scenario poses
  (new pose id 115). Shipped verbatim + HEAD-probed on EU per invariant.
- **`sharePassword`** on 5 courses, `reviewId` on 9, `courseReviewItems` on
  63 — review/share state is not migrated (expected).
- Folders: 35 (shared team folders `AKU`, `Regnskap`, `Innkjøp og faktura`…,
  1 deleted folder `private / Ida`). (TODO U6 wording.)

## Novelty — 323 new field paths (ACCEPTED 2026-10-19 → `catalog.fields.json` + block catalog)

All on **known** variants; the novelty tool diffed against
`core/census/catalog.fields.json`. Groups:

| Group | Paths | Classification |
|---|---|---|
| `metadata.contentValidation{,.pass,.version}` + bare `metadata` on 23 more variants | 83 | already **accepted** (2026-10-11 row) — extend the variant list |
| `createdAt`/`updatedAt` on `divider/*`, `gallery/four column` | 6 | accepted — `SERVER_OWNED_FIELDS`, dropped on write |
| Image metadata (`originalImage.*`, `dimensions.*`, `isSquare`, `align`, `alt`, `isSkipCrush`, `imageType`, `isProcessing`, `sourcedFrom`) on more variants/slots (`background.media.image`, `items[].avatar`, `items[].background`, `items[].front`) | ~90 | accepted current schema (same as `_mercedes2` row) |
| Block background image `background.{key,type,useCrushedKey}` on `continue`, `flashcard`, `image/text aside`, `text/paragraph` | 12 | accepted — same shape as other variants; keys covered by the generic scan |
| `media.tmp.*` incl. `uploadProgress: 0`, `error` (transient upload state left in doc) | ~20 | accepted OPTIONAL provenance — blanked silently when unavailable |
| Video inside `interactive/tabs` + `labeledgraphic` items (`items[].media.video.*`, `captions[]`, `captionUID`) | 23 | accepted — same video record as `multimedia/video`; 25 `.vtt` keys archived |
| Link-preview embed inside `accordion`/`tabs` (`items[].media.embed.{provider,providerUrl,favicon,thumbnail,title,description}` + `items[].settings.showMetaData`) | 13 | **new field (benign)** — embedly card metadata, copy-faithful, external URLs |
| **`items[].media.customVideo.{src,poster,subtitle,thumbnail,title}`** on `multimedia/video` (15 blocks, 2 courses: "Online Security Fundamentals" = Rise sample, "Verktøykasse for <xxxxxxx>") | 6 | **new shape** — Rise stock sample video on `https://video.riseusercontent.com/PRMG-…/*.m3u8` (public CloudFront, HEAD 200 from EU). Not an uploadable key, not matched by any host regex → copied verbatim. Treat like built-in assets: probe + `builtin-asset` flag would be the consistent policy; today it passes silently. |
| `items[].media.image.aiImageGenSettings.{prompt,style,orientation}` | 4 | **new field (benign)** — AI-image provenance text, copy-faithful |
| Settings: `backgroundMode`/`styleMode` (Mighty), `noteIcon`/`noteSize`, `columns`/`images`, `divider*`, `isCustomColor`, `customPadding*` | ~16 | accepted current schema (style harvest already knows these) |
| `items[].character.poses.115.*` | 8 | accepted — new scenario pose record, `cdn.articulate.com/content-pass` |
| **`blocumentId`** on `mondrian/mondrian` | 1 | **see Blocker 1** |

## Refetch 2026-10-19

24 courses the operator saw as "updated" in Rise were force-refetched by moving
`courses/<id>.json` (+ the one `blockuments/<id>.json`) out of the archive. All
24 came back content-identical (lessons, blocks, media keys); only
`exportSettings`/`order`/`experiments`/permissions/snapshots differed — they had
been published, not edited. One Custom-block graph moved `_v` 51 → 52 (adds
`shapeDef.orient`). The 170th course is Hanne's 2026-10-16 copy of the
shared-in "En sak for Walter" (`AYf58Ty…`, `copyOf 2AbymuEu…`). The inventory
was re-saved afterwards. Backups removed; the archive is the import input.

## Verdict

**Not yet ready for the full batch.** Ready for a **pilot**: import
`GtgN_Ipgfs57hVCTWDuOvo0RY2HQhTaO` (1 `blocumentId` block) and one
`customVideo` course, preview + publish both on EU. If boot is clean, accept
the novelty rows and run the remaining 167 courses, with the four
large-asset courses run singly.
