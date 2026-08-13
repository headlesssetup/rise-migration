# Capture plan — the EDITING protocol (block edit / delete / reorder, locks)

> **STATUS (2026-08-12): CAPTURE DONE + EXTRACTED.** Operator session
> `_capture/capture-editing-20260812.mitm` (no step stamps — actions are
> transparent in flow order); extraction in
> `docs/captures/2026-08-12-editing-envelopes.jsonl`; findings documented in
> `docs/rise-api-reference.md` **§4a** (DELETE_BLOCKS, MOVE_BLOCKS,
> BULK_UPDATE_BLOCKS = undo/redo, UPDATE_LESSON_ORDER, DUPLICATE_LESSON,
> DELETE_LESSON response, UPDATE_LESSON_DEBOUNCE, INSERT_BLOCK_TEMPLATE,
> PUT_LOCK/DEL_LOCK with lesson granularity + 24 h TTL). **Operator decision:
> steps 9–10 (multi-editor locking / stale-write probes) are DESCOPED** —
> single-author assumption; we mirror PUT/DEL_LOCK for fidelity only. Remaining
> uncaptured: `BULK_UPDATE_BLOCKS.updates[]` element shape, and whether any
> `updatedAt` echo is server-enforced (assume NOT — fingerprint before apply).

> **Why this session.** The tool currently only CREATES content. The next major
> capability (docx storyboard → update an EXISTING course, with a reviewed
> diff) needs the editor's *mutation* envelopes, which our captures do not
> cover. Known today: `UPDATE_BLOCK` / `UPDATE_BLOCK_DEBOUNCE`, `UPDATE_LESSON`,
> one `UPDATE_LESSON_ORDER`, one `DELETE_LESSON`, `DELETE_TYPEFACE`. **Never
> captured: block DELETE, block REORDER/MOVE, block DUPLICATE, editor UNDO, the
> lock WRITE transport, and every concurrency signal.** Nothing in this plan is
> implemented until the capture confirms it — same discipline as always
> (`docs/rise-api-reference.md` is grown only from captures).

## Setup (same as previous sessions)

- Throwaway course on the **test/EU account** — never a client course. Make it
  from scratch: 3 lessons ("A", "B", "C"), each with 4–5 cheap blocks
  (paragraph, heading+paragraph, bulleted list, accordion with 2 panels, one
  image block with any uploaded image). The image block matters: we need to see
  whether deleting a media-bearing block triggers any asset-side call.
- mitmproxy recording to a file named `capture-editing-<date>.mitm`; keep the
  browser devtools **WS/socket.io tab visible** — locks are known to broadcast
  on the socket (`GET_LOCKS`), and the lock *write* transport is exactly what
  we're hunting.
- Perform ONE action at a time, wait ~5 s between actions, and keep a plain
  text note of `hh:mm — what I did` (the timestamps are how we align the
  capture with intent).

## Script — do these in order

Each numbered step is one capture goal. Prefix your note line with the step
number.

**1. Baseline open.** Open the course editor, wait for it to settle, click
nothing for 10 s. (Gives us the session/lock acquisition on open + a clean
`GET_COURSE`.)

**2. Text edit in place.** Edit one paragraph block's text, click outside,
wait. Then edit the SAME block again. (Confirms `UPDATE_BLOCK[_DEBOUNCE]`
carries the WHOLE block vs a delta; two edits show whether any revision/etag
field increments.)

**3. Item-level edit inside one block.** In the accordion: rename a panel,
then ADD a third panel, then DELETE that panel, then DRAG panel 2 above
panel 1. Wait between each. (Is item add/remove/reorder still just
`UPDATE_BLOCK` with the full `items[]`, or separate envelopes?)

**4. Block delete.** Delete one text block via the block's ⋯ menu. Then delete
the IMAGE block. (The core missing envelope. The image case shows whether any
asset delete/detach call rides along — we expect none, verify.)

**5. Block reorder.** Drag a block up within lesson A. Then, if the UI offers
"move to another lesson" (⋯ menu), move a block from A to B; if it doesn't,
note "no cross-lesson move in UI" and skip.

**6. Block duplicate / copy.** Duplicate a block in place. If the UI offers
"copy to" another lesson/course, do one of each. (Shows who mints the new
block id — client or server.)

**7. Undo.** Immediately after a text edit, press Ctrl/Cmd+Z and let it save.
Then delete a block and press Ctrl/Cmd+Z. (Does undo emit a compensating
`UPDATE_BLOCK`/`CREATE_BLOCKS`, or a dedicated envelope? Does an undone delete
restore the SAME block id?)

**8. Lesson ops.** Rename lesson B. Drag lesson C above B. Delete lesson C.
Undo the delete if the UI offers it. (Re-confirms `UPDATE_LESSON` /
`UPDATE_LESSON_ORDER` / `DELETE_LESSON` payloads on a current build, and what
lesson delete does to its blocks server-side.)

**9. Locks + second editor — the important one.** Open the SAME course in a
second browser (or profile) logged into the same account:
   1. With both editors on lesson A, edit a block in editor 1. Watch editor 2 —
      note what it shows (lock banner? live refresh?).
   2. Try to edit the same block from editor 2 while editor 1 is mid-edit.
   3. Close editor 1's tab; note how long until editor 2 may edit.
   (We need: the lock acquire/release WRITE envelope or socket emit, the lock
   granularity — course / lesson / block, TTL, and what a locked-out client
   receives when it tries to write anyway.)

**10. Stale-write probe.** In editor 2 (after editor 1 is closed), edit a block
that editor 1 had ALSO edited earlier. (Does the server accept a write based on
stale state unconditionally? Any `updatedAt`/version precondition visible in
the request or response?)

**11. Settle + read-back.** Close everything, reopen the editor once, let
`GET_COURSE` load, close. (Final persisted shape of everything the session
touched.)

## Optional (only if time allows)

- **Quiz lesson**: add a quiz lesson, add one question, edit it, delete it —
  quiz lessons are structurally different and currently out of storyboard
  scope, but a capture now is cheap.
- **Course settings**: toggle one setting (already-known envelope
  `UPDATE_COURSE_DEBOUNCE {id, settings}`) — re-confirmation only.

## Deliverables back to the repo

- `capture-editing-<date>.mitm` + your timestamped note.
- We then extract into `docs/rise-api-reference.md` (new §: editing envelopes)
  and record open verdicts here: lock granularity/TTL, undo semantics, whether
  any write carries a precondition (the answer decides how the future
  update-course path detects concurrent edits — fingerprint-only vs server-side
  precondition).

## What this unblocks (not built yet — operator decision gates each)

Update-an-existing-course import mode: diff/changeset review → paced
`UPDATE_BLOCK` / `DELETE_BLOCK?` / reorder writes under the captured lock
discipline. **Deletion stays policy-forbidden until this capture proves the
envelope and the operator explicitly revises the invariant in `CLAUDE.md`.**
