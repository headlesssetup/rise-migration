// The Creator prompt pack: fixed instructions the operator copies into an
// external AI chat together with the source deck (PPTX/DOCX/PDF). The AI
// returns Course Blueprint JSON, which the Creator page validates strictly
// (blueprint/validate.ts) and compiles deterministically (compiler.ts).
// docs/creator-ai-design.md is the design contract.
//
// KEEP IN SYNC with blueprint/types.ts — prompt.test.ts asserts every
// BlockIntentKind and the key contract literals appear below.

import { COURSE_BLUEPRINT_FORMAT, COURSE_BLUEPRINT_VERSION } from './blueprint/types';

/** Build the copyable prompt; `deckInstructions` is the operator's per-deck note. */
export function creatorPrompt(deckInstructions?: string): string {
  const extra = deckInstructions?.trim();
  return `You convert ONE attached source document (a slide deck or text document) into ONE e-learning course, expressed as a "Course Blueprint" JSON object. The blueprint is compiled by a deterministic tool — your output must match the schema below EXACTLY.

## Output contract

- Return EXACTLY ONE fenced \`\`\`json code block containing the blueprint, and nothing else. No prose before or after, no comments inside the JSON.
- The schema is CLOSED: any field not listed below fails validation. Do not add fields.
- Keep ALL content in the SOURCE DOCUMENT'S LANGUAGE. Do not translate.
- One source file = one course.

## Fidelity rules (most important)

- Use the source text AS WRITTEN. Do not invent, embellish, or rephrase unless absolutely necessary to make a block work.
- Any block whose text you invented or rephrased MUST carry "origin": "suggested". Blocks taken from the source as written carry no origin field (or "origin": "source").
- NEVER invent facts, quiz answers, dates, captions, alt text, or attributions.
- A quiz question is only valid if the source clearly evidences which answer is correct. If it does not, put the question into "unresolved" instead of guessing.
- Comments and speaker notes written by the author about WHICH BLOCK TO USE (e.g. "make this an accordion") are BINDING instructions. If such a directive names something unsupported, emit the closest placeholder block and record the problem in "unresolved" — never approximate silently.
- Material you cannot place (unsupported media, illegible diagrams, ambiguous fragments) goes into "unresolved" with the reason. Nothing may be silently dropped.
- Narration / voice-over / filming scripts are NOT course content: put them into "production" entries.
- Images and binary media cannot travel through this chat: "assets" must stay []. Where an image or video is essential, use a placeholder block and add an "unresolved" entry describing it.

## Blueprint schema

Top level:
{
  "format": "${COURSE_BLUEPRINT_FORMAT}",
  "formatVersion": ${COURSE_BLUEPRINT_VERSION},
  "source": { "kind": "ai-provider", "originalFileName": "<the attached file's name>", "provider": "<your product name>", "model": "<your model name>" },
  "title": "<course title>",
  "lessons": [ { "title": "<lesson title>", "blocks": [ <block>... ] } ],
  "assets": [],
  "unresolved": [ { "sourceRef": <sourceRef>, "reason": "<why this material could not be placed>" } ],
  "production": [ { "kind": "narration", "lesson": "<lesson title>", "sourceRef": <sourceRef>, "text": "<narration text>" } ]
}

Every block:
{ "intent": <intent>, "sourceRef": <sourceRef>, "notes": ["<remark for the reviewer>"], "origin": "source" | "suggested" (optional) }

Every sourceRef (provenance — required on every block, unresolved item, and production item):
{ "label": "<human-readable location, e.g. 'Slide 7'>", "slideNo": <number or null>, "excerpt": "<short verbatim snippet of the source element>" }

Text fields marked HTML below accept ONLY these tags: <p>, <strong>, <em>, <b>, <i>, <a href>, <ul>, <ol>, <li>, <br>. Paragraph-level HTML fields are strings like "<p>…</p>". No other tags, no style attributes, no event handlers.

## Block intents (the complete, closed vocabulary)

1. "text" — heading + prose. Fields: { "kind": "text", "heading": "<plain text, optional>", "paragraphs": ["<p>…</p>", …] (HTML) }. The workhorse; use for any explanatory prose.
2. "list" — bulleted or numbered list. { "kind": "list", "ordered": true|false, "heading": optional, "intro": ["<p>…</p>", …] (HTML, may be []), "items": ["<p>…</p>", …] (HTML), "outro": optional HTML array }.
3. "accordion" — vertically stacked expandable panels. { "kind": "accordion", "heading": optional, "intro": [], "items": [{ "title": "<plain text>", "body": "<p>…</p>" (HTML) }, …] }. Use for parallel explanatory concepts read independently; panel bodies may be several paragraphs.
4. "tabs" — horizontal tabbed panels. Same fields as accordion with "kind": "tabs". Use for a small number (2–5) of parallel views of one topic.
5. "flashcards" — flip cards, front → back. Same item fields with "kind": "flashcards"; "title" is the FRONT (a term or question, short), "body" the BACK (its definition or answer, 1–2 sentences). Use ONLY for short recall pairs — long backs mean you picked the wrong block.
6. "process" — numbered step-by-step walkthrough. Same item fields with "kind": "process"; each item is one step in order. Use for ordered actions or procedures.
7. "timeline" — dated events in order. { "kind": "timeline", "heading": optional, "intro": [], "events": [{ "date": "<text, e.g. '2010' or 'May 3'>", "title": "<plain>", "body": "<p>…</p>" (HTML, may be "") }, …] }. Only for genuinely dated/sequenced events from the source.
8. "sorting" — drag cards into category piles. { "kind": "sorting", "heading": optional, "intro": [], "piles": ["<pile title>", …], "cards": [{ "title": "<card text>", "pile": <1-based index into piles> }, …] }. Use when the source presents a classification exercise.
9. "knowledge-check" — quiz questions. { "kind": "knowledge-check", "heading": optional, "intro": [], "questions": [{ "stem": "<p>…</p>" (HTML), "options": [{ "text": "<plain>", "correct": true|false, "feedback": "<plain, optional>" }, …], "feedback": "<p>…</p>" (HTML, optional question-level feedback) }] }. At least 2 options; at least 1 correct (several correct = multiple-response). Correctness MUST be evidenced by the source.
10. "note" — a highlighted callout. { "kind": "note", "paragraphs": ["<p>…</p>", …] (HTML) }. For warnings, key takeaways, "remember" boxes.
11. "links" — a stack of link buttons. { "kind": "links", "heading": optional, "intro": [], "buttons": [{ "label": "<plain>", "destination": "<https URL>", "description": "<plain, may be "">" }, …], "trailing": optional HTML array }.
12. "video-placeholder" — where the source has/needs a video. { "kind": "video-placeholder", "label": "<what belongs here, e.g. 'Video: intro interview (~3 min)'>" }.
13. "storyline-placeholder" — where an interactive activity beyond this vocabulary is required. { "kind": "storyline-placeholder", "label": "<what belongs here>" }.
14. "attachment-placeholder" — where a downloadable file belongs. { "kind": "attachment-placeholder", "label": "<file and purpose>" }.
15. "continue" — a "continue" gate button between sections. { "kind": "continue", "label": "<button text>" }.

## Shaping heuristics

- Reason from MEANING and visual grouping, not from slide mechanics. A slide is NOT automatically one block, and NOT automatically one lesson.
- Section dividers / agenda slides usually mark lesson boundaries. Aim for lessons a learner finishes in a few minutes.
- heading + prose → text; parallel explanatory concepts → tabs or accordion; short recall pairs → flashcards; ordered actions → process; dated events → timeline; classification exercise → sorting; explicit evidenced question/answer → knowledge-check; key warning/takeaway → note; external references → links.
- Decorative elements (logos, page numbers, backgrounds) are ignored — do not report them.
- Prefer fewer, well-chosen blocks over exhaustive slide-by-slide transcription of layout junk.

Before answering, verify: every block has a sourceRef with a real slide/page reference; every invented or rephrased text is marked "origin": "suggested"; "assets" is []; nothing from the source is silently missing (used, in unresolved, or in production).${
    extra
      ? `

## Operator instructions for this document

${extra}`
      : ''
  }`;
}
