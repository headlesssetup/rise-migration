# Rise Creator AI pipeline design

> **STATUS (2026-08-16): the CHAT-PASTE mode of this design is IMPLEMENTED.**
> The Rise Creator page (`entrypoints/creator/`) ships the copyable prompt pack
> (`core/creator/prompt.ts`), strict closed-schema validation of pasted
> blueprint JSON (`core/creator/blueprint/validate.ts` — unknown fields/kinds
> fail, path-addressed errors, a copy-back error report as the manual repair
> pass), the pseudo-Rise preview as the operator gate, and the deterministic
> compiler → standard Import. Blueprint v1 gained `origin: 'source'|'suggested'`
> on blocks: the provider must mark invented/rephrased text and the preview
> badges it. The **API mode** (provider called programmatically, binary asset
> return, automated repair) **remains deferred** — everything below still
> governs it. The SD-docx → Rise parser was DROPPED the same day (client docx
> is too unreliable as deterministic input without an AI cleanup stage), so
> this pipeline is the only doc → Rise route.
>
> **v0.9.0: the flow is now TWO pages.** `creator.html` (prompt pack + paste +
> validate) hands off to `review.html` (re-validate + preview + unresolved ack
> + package write) via a `chrome.storage.session` slot holding the RAW pasted
> text (`shared/creator-handoff.ts`). The review page RE-validates — storage is
> never trusted; a consumed/expired slot dead-ends with a pointer back to the
> Creator page.

This document records the agreed boundary for general conversion.

## Provider input

Creator sends the selected provider:

- the original PPTX, DOCX, PDF, or other supported source file unchanged;
- the operator's prompt;
- fixed Creator instructions;
- the exact versioned Course Blueprint schema;
- a compact guide to the semantic Rise block vocabulary the compiler supports.

Creator does not unzip, render, inventory, or extract text/images from the
source. Source interpretation quality is the provider's responsibility.

## What the model knows about Rise

The model should understand Rise as an authoring vocabulary, not as a private
JSON protocol. For each supported blueprint block it receives:

- what learners see;
- the learning/design purpose;
- good and poor uses;
- required blueprint fields;
- practical content limits;
- supported media slots;
- registered fallbacks.

The model does not receive donor payloads, `family`/`variant` settings, ids,
media-key shapes, or authoring envelopes. Those remain deterministic compiler
and importer concerns.

## Pipeline

```text
original file + operator prompt + schema/block guide
  -> provider-native file understanding
  -> Course Blueprint JSON + optional provider-returned binary files
  -> strict schema validation
  -> semantic validation
  -> operator preview/edit
  -> registry-backed deterministic compiler
  -> local archive validation
  -> ready package on disk
  -> standard side-panel Import
```

One source file always produces one course. The provider decides lesson
boundaries and semantic blocks from content, order, layout, notes, and embedded
media it can understand. A slide is not automatically a lesson or one block.

## Provider output

The LLM returns only Course Blueprint, never Rise JSON. The blueprint is a
closed/versioned contract containing:

- course title and ordered lessons;
- supported semantic block intents;
- provider-reported source references on every content node;
- warnings, unresolved material, and assumptions;
- production-only material;
- typed references to provider-returned assets.

Unknown fields and unsupported block intents fail validation. Knowledge checks
must identify the source evidence for correct answers. Suggested or invented
content must be visibly distinguished from source-derived content.

## PowerPoint shaping guidance

The provider should reason from meaning and visual grouping. Examples:

- heading plus prose -> text;
- parallel explanatory concepts -> tabs or accordion;
- recall pairs -> flashcards;
- ordered actions -> process;
- dated events -> timeline;
- explicit, evidenced question/answer -> knowledge check;
- section divider -> possible lesson boundary;
- unsupported embedded media -> placeholder and warning.

It must not invent facts, quiz answers, dates, captions, alt text, or
attributions and present them as source content.

The provider reports understandable locations such as slide/page number and a
visible element description. It may classify material as used,
ignored-decoration, production-note, placeholder, or unresolved. Because
Creator does no independent extraction, this coverage is the provider's report,
not code-verified completeness; the operator compares the preview with the
original file.

## Binary assets

If source images/media must survive, the provider must return actual binary
files or retrievable file ids. Creator saves and hashes those bytes, then the
blueprint refers to them with typed `local-asset` objects.

If the provider returns JSON/text only, Creator has no bytes to save. The media
becomes a visible placeholder/warning; Creator does not open the source file as
a fallback extractor.

Before this can ship, a captured registry-backed local-media compiler/plan
adapter must:

1. resolve the local reference to bytes;
2. emit only a proven donor block/media slot;
3. use the standard importer upload/remap flow;
4. replace the local ref with the target Rise key;
5. prove through GET_COURSE read-back that neither a local ref nor foreign media
   key survived.

## Repair and preview

Schema/semantic failures may be returned to the provider in a bounded repair
pass. Repair still targets Course Blueprint only. In the shipped chat-paste
mode this is the operator loop — copy the error report, paste it back into the
chat, paste the corrected JSON — and it happens on the ENTRY page
(`creator.html`); the review page is a dead end for invalid JSON, never a
repair surface.

The operator preview exposes lesson/block order, proposed content, source refs,
assets, unsupported items, registry status, confidence/warnings, and unresolved
material. Operators edit the blueprint-level proposal; there is no raw Rise JSON
editor.
