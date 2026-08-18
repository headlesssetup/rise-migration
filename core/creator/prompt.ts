// The Creator prompt pack: fixed instructions the operator copies into an
// external AI chat together with the source deck (PPTX/DOCX/PDF). The AI
// returns Course Blueprint JSON, which the Creator page validates strictly
// (blueprint/validate.ts) and compiles deterministically (compiler.ts).
// docs/creator-ai-design.md is the design contract.
//
// KEEP IN SYNC with blueprint/types.ts — prompt.test.ts asserts every
// BlockIntentKind and the key contract literals appear below, and that
// PROMPT_EXAMPLE_BLUEPRINT passes validateBlueprint.
//
// Field-tested 2026-08-16 (external model run on a real client deck): the
// worked examples, the directive alias table, and the explicit rules for
// speaker notes / comments / contradictions all exist because their absence
// cost accuracy on that run.

import { COURSE_BLUEPRINT_FORMAT, COURSE_BLUEPRINT_VERSION } from './blueprint/types';

/** Complete minimal blueprint embedded in the prompt as the worked example.
 *  prompt.test.ts asserts it validates — the example can never drift from the
 *  schema. */
export const PROMPT_EXAMPLE_BLUEPRINT = `{
  "format": "${COURSE_BLUEPRINT_FORMAT}",
  "formatVersion": ${COURSE_BLUEPRINT_VERSION},
  "source": { "kind": "ai-provider", "originalFileName": "deck.pptx", "provider": "<your product>", "model": "<your model>" },
  "title": "Course title from the title slide",
  "lessons": [
    {
      "title": "1. First section title",
      "blocks": [
        {
          "intent": { "kind": "text", "heading": "Welcome", "paragraphs": ["<p>Exact text from the slide.</p>"] },
          "sourceRef": { "label": "Slide 2", "slideNo": 2, "excerpt": "Exact text from the slide." },
          "notes": []
        },
        {
          "intent": { "kind": "knowledge-check", "intro": [], "questions": [ {
            "stem": "<p>Question exactly as slide 4 asks it?</p>",
            "options": [
              { "text": "Answer the slide marks correct", "correct": true },
              { "text": "Distractor from the slide", "correct": false }
            ] } ] },
          "sourceRef": { "label": "Slide 4", "slideNo": 4, "excerpt": "Question exactly as slide 4 asks it?" },
          "notes": []
        }
      ]
    }
  ],
  "assets": [],
  "unresolved": [
    {
      "sourceRef": { "label": "Slide 5 (architecture diagram)", "slideNo": 5, "excerpt": "diagram with 6 labeled parts" },
      "reason": "Diagram cannot be represented in the supported blocks; needs manual authoring."
    }
  ],
  "production": [
    {
      "kind": "narration",
      "lesson": "1. First section title",
      "sourceRef": { "label": "Slide 3 speaker notes", "slideNo": 3, "excerpt": "VO: welcome the learner" },
      "text": "Voice-over script taken from the speaker notes."
    }
  ]
}`;

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
- What counts as rephrasing: CHANGING, adding, or paraphrasing words is "suggested". Recombining source strings without changing their wording — merging sibling text boxes into one paragraph, bolding a lead-in, joining a label with its caption — is formatting, NOT "suggested".
- NEVER invent facts, quiz answers, dates, captions, alt text, or attributions.
- A quiz question is only valid if the source clearly evidences which answer is correct. If it does not, put the question into "unresolved" instead of guessing. If the source evidences NO quiz at all, emit ZERO "knowledge-check" blocks — do not add practice questions on your own.
- Author DIRECTIVES may appear ANYWHERE in the source: small on-slide label boxes naming a block type (e.g. a colored box saying "Tabs" or "Flipcards"), speaker notes, or comments. A directive is a BINDING instruction naming the block to use; the label box itself is an instruction, never content to place. Map directive wording through the alias table below.
- SPEAKER NOTES have NO fixed role — never assume they are guidance. Classify each note by what it actually contains: a block directive (binding, see above); narration / voice-over / filming script (goes to "production", never into course content); substantive content that the slide itself lacks (treat as source content and cite the note in sourceRef); or irrelevant working remarks (ignore).
- COMMENTS: an open/unaddressed comment is never content — record it in "unresolved" (include the author in sourceRef.label). A resolved comment is ignored, UNLESS its content never made it onto the slide — then treat it as source content and cite the comment in sourceRef.
- CONTRADICTIONS: when slide text, speaker notes, and comments disagree (different counts, different dates, a heading that says "four" above a list of five), use the slide text for the block and record the discrepancy in "unresolved". Never silently pick one version or reconcile them yourself.
- Material you cannot place (unsupported media, illegible diagrams, ambiguous fragments) goes into "unresolved" with the reason. Nothing may be silently dropped.
- Images and binary media cannot travel through this chat: "assets" must stay []. Where an image or video is essential, use a placeholder block and add an "unresolved" entry describing it.
- TITLES: the course title comes from the title slide (or the file name if there is none). Lesson titles come from section-divider / agenda text. When you must derive a title because the source names none, keep it short, in the source language, and add the note "title derived — no title in source" to that lesson's first block (titles have no origin field).

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

"production[].kind" is ALWAYS the literal "narration" — no other value exists.

Every block is an object whose block-type fields live INSIDE the "intent" OBJECT — "intent" is never a string label. Worked example of one complete block:

{
  "intent": { "kind": "text", "heading": "Welcome", "paragraphs": ["<p>Exact source text.</p>"] },
  "sourceRef": { "label": "Slide 7", "slideNo": 7, "excerpt": "Exact source text." },
  "notes": [],
  "origin": "source"
}

Every sourceRef (provenance — required on every block, unresolved item, and production item):
{ "label": "<human-readable location, e.g. 'Slide 7' or 'Slide 7, comment by J. Doe'>", "slideNo": <number or null>, "excerpt": "<short verbatim snippet of the source element, at most ~200 characters>" }

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

## Directive alias table (authors write Rise's UI names — map them)

- paragraph / heading / heading and paragraph / subheading / text on image → "text"
- statement (A/B/C/D) / note / callout → "note"
- bulleted list / checkbox list → "list" with "ordered": false; numbered list → "list" with "ordered": true
- accordion → "accordion" · tabs → "tabs"
- flipcards / flip cards / flashcard grid / flashcard stack → "flashcards"
- process → "process" · timeline → "timeline" · sorting activity → "sorting"
- quote / quote carousel → "text" (attribution stays in the paragraph text)
- button / button stack / links / resources → "links"
- continue / divider → "continue"
- multiple choice / multiple response / quiz / knowledge check → "knowledge-check" (only with evidenced answers)
- video / embed → "video-placeholder" · attachment / download → "attachment-placeholder"
- storyline / mighty / scenario / labeled graphic / matching / fill-in-the-blank / any interactive not listed above → "storyline-placeholder"
- image / image and text / image centered / gallery / images with notes → "text" carrying the text content, plus an "unresolved" entry for the visual part

A directive NOT in this table: use the nearest listed block that can carry the TEXT, add a block note naming the original directive verbatim, and add an "unresolved" entry if any part (visuals, interaction) cannot be represented. Never bury source text inside a placeholder label — placeholders are only for video, attachments, and interactives.

## Shaping heuristics

- Reason from MEANING and visual grouping, not from slide mechanics. A slide is NOT automatically one block, and NOT automatically one lesson.
- Section dividers / agenda slides usually mark lesson boundaries. Aim for roughly 3–10 blocks per lesson; split or merge slides freely to get there.
- heading + prose → text; parallel explanatory concepts → tabs or accordion; short recall pairs → flashcards; ordered actions → process; dated events → timeline; classification exercise → sorting; explicit evidenced question/answer → knowledge-check; key warning/takeaway → note; external references → links.
- Decorative elements (logos, page numbers, backgrounds) are ignored — do not report them.
- Prefer fewer, well-chosen blocks over exhaustive slide-by-slide transcription of layout junk.

## Complete worked example (one lesson — yours will have more)

\`\`\`json
${PROMPT_EXAMPLE_BLUEPRINT}
\`\`\`

Before answering, verify: every block has a sourceRef with a real slide/page reference; every invented or rephrased text is marked "origin": "suggested"; every directive was mapped through the alias table; open comments and contradictions are in "unresolved"; there are no knowledge checks the source does not evidence; "assets" is []; nothing from the source is silently missing (used, in unresolved, or in production).${
    extra
      ? `

## Operator instructions for this document

${extra}`
      : ''
  }`;
}
