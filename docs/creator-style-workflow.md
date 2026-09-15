# Script → styled Rise course: operator workflow (v0.9.12)

The end-to-end path as it works today (2026-09-15), from a designer's finished
courses and an SD storyboard to a course in the Rise account that carries the
house style. It works, and it is fiddly: every numbered step below is a manual
click or paste. The friction points are listed at the end for the next
iteration.

Roles of the four folders (keep them separate):

| Folder | Role | Access | Example |
|---|---|---|---|
| Export archive | the designer's finished courses WITH media; style source | read | `_export1309` |
| Creator folder | staging folder where packages and style profiles are written | read/write | `~/Downloads/creator1509` |
| Asset folder | the designer's pictures/PDFs the AI may place, named by module/chapter/slide | read | `_design_for_Europe` |
| Scripts | SD storyboard docx files, one per chapter | attached to the AI chat | `…_M1_4-nodala_SD_v2.docx` |

## A. One-time: export the reference courses

1. Side panel → Export. Export the finished courses (VAS 1.1, 1.2, 1.3) into a
   fresh folder **with assets** and let it finish (`manifest.json` must say
   `state: "ready"` and the folder must have `assets/` and
   `courses/<id>.assets.json`). A content-only fetch (state `building`, no
   `assets/`) is refused as a style source.

## B. One-time per house style: harvest the profile

2. Rise AI Creator page → card "0 · Style profiles & folders" → open the
   Review page (it works without a blueprint).
3. "Creator folder" card → connect an empty dedicated folder ("Change Creator
   folder…" if the wrong one is remembered). An export archive is refused.
4. "Style" card → "Harvest a new style…" → "Pick the style source archive…" →
   the export archive from step 1 → tick the courses, **the tidiest one
   first** (1.2, then 1.3, then 1.1) → name → "Harvest style".
   Read the report: the opener must list four blocks, the closer must show
   "Nākamā tēma:", banners should include Kopsavilkums / Uzdevums / Pārbaudi
   savas zināšanas!, all four donors ticked, ~20 asset files copied.
5. "Connect asset folder…" → the designer's picture folder. The Creator page
   shares this handle.

## C. Per course

6. Rise AI Creator page → step 1: (optional) deck instructions → **Copy
   prompt** (the copy includes the asset folder's file names).
7. External AI chat: attach the chapter's SD docx, paste the prompt, send.
8. Paste the returned JSON into step 2 → **Validate**. Errors → "Copy error
   report" back into the chat; warnings (e.g. hints moved out of `intent`)
   are fine.
9. **Review blueprint** → new tab. Check: lesson titles in navigation form
   ("3.1. …"), a section divider first, banners/quotes where the script has
   Kopsavilkums / Pārbaudi / Tēmas padziļināšanai rows, pictures named where
   the folder has them.
10. Style card: **the profile must be selected** ("Apply style: VAS"; a red
    line warns if not). The file check lists named pictures missing from the
    asset folder (left out, noted — not blocking).
11. Acknowledge unresolved items → **Approve → save package with style "…"**.
    Read the compiler notes (video ids to paste, missing pictures, lessons
    without an illustrated intro).
12. Side panel → Import Data → archive folder = the Creator folder → the
    course appears under C · Courses → import. The report in
    `_import/<id>.report.md` must say imported (not partial) with 0 surviving
    source keys.
13. Rise: open the course; designer review. Paste YouTube ids into the Mighty
    video cards (search the block HTML for `VIDEO_ID`), swap placeholder
    illustrations, place labeled-graphic markers.

## Known friction (input for the next iteration)

- Four folders and three pages; each handle must be connected/re-granted
  after a browser restart.
- The prompt must be re-copied whenever it changes (it embeds the file list).
- The AI chat is a manual copy/paste hop; validation errors mean another hop.
- A fresh Review tab used to start unstyled (now remembered/defaulted, but the
  selection is still a thing to check).
- Import is a separate side-panel run against the Creator folder.
- A partial/unstyled import leaves a course to delete by hand in Rise.
- Module 4 has no picture folder yet; openers fall back to the source
  illustration until the designer adds N4.
