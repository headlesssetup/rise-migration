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
  "production": []
}`;

export interface PromptOptions {
  /** File names in the operator's connected asset folder (images, PDFs). When
   *  given, the AI may reference them by exact name (`image` / `file`). */
  imageNames?: readonly string[];
}

/** Build the copyable prompt; `deckInstructions` is the operator's per-deck note. */
export function creatorPrompt(deckInstructions?: string, options: PromptOptions = {}): string {
  const extra = deckInstructions?.trim();
  const images = (options.imageNames ?? []).filter((n) => n.trim() !== '');
  return `You convert ONE attached source document (a slide deck or text document) into ONE e-learning course, expressed as a "Course Blueprint" JSON object. The blueprint is compiled by a deterministic tool — your output must match the schema below EXACTLY.

## Output contract

- Return EXACTLY ONE fenced \`\`\`json code block containing the blueprint, and nothing else. No prose before or after, no comments inside the JSON.
- Emit COMPACT JSON: no indentation, no line breaks between fields (one long line, or one line per block at most). Pretty-printing wastes a third of the message budget and long courses get cut off.
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
- SPEAKER NOTES have NO fixed role — never assume they are guidance. Classify each note by what it actually contains: a block directive (binding, see above); narration / voice-over / filming script (NOT copied anywhere — see the narration rule below); substantive content that the slide itself lacks (treat as source content and cite the note in sourceRef); or irrelevant working remarks (ignore).
- COMMENTS: an open/unaddressed comment is never content — record it in "unresolved" (include the author in sourceRef.label). A resolved comment is ignored, UNLESS its content never made it onto the slide — then treat it as source content and cite the comment in sourceRef.
- CONTRADICTIONS: when slide text, speaker notes, and comments disagree (different counts, different dates, a heading that says "four" above a list of five), use the slide text for the block and record the discrepancy in "unresolved". Never silently pick one version or reconcile them yourself.
- Material you cannot place (unsupported media, illegible diagrams, ambiguous fragments) goes into "unresolved" with the reason. Nothing may be silently dropped.
- Images and binary media cannot travel through this chat: "assets" must stay []. Where an image or video is essential, use a placeholder block and add an "unresolved" entry describing it — UNLESS an "Available files" list is given below: then name the matching file in the block's "image" (or the attachment's "file") field, by its EXACT name, and add no unresolved entry for it. Never invent a file name; a picture with no matching file goes to "unresolved" as before. EXCEPTION — a "labeled-graphic" needs no unresolved entry for its picture: it is built on Rise's built-in placeholder image; describe the intended image (from the source) in that block's "notes" instead.
- NARRATION / voice-over / audio scripts are NEVER copied into the blueprint. The source document stays the producers' script; Rise only needs to know WHERE the video goes. Emit a "video-placeholder" whose label identifies the video (type, speaker, duration — e.g. "Video: Eksperta video lekcija (~3 min), Viktorija"), and leave "production" as [] — do not paste the script into it. Copying scripts makes the JSON many times larger for no benefit.
- TITLES: the course title comes from the title slide (or the file name if there is none). Lesson titles come from section-divider / agenda text. When you must derive a title because the source names none, keep it short, in the source language, and add the note "title derived — no title in source" to that lesson's first block (titles have no origin field).
- LESSON TITLE FORM: a lesson title is what the learner sees in the course navigation — NEVER the storyboard's row label. Drop labels such as "Tēma", "Topic", "Nodarbība", and number the lesson the way the document's own course-structure table numbers chapters/topics: a row "Tēma 1.3.1. ES tiesību sistēmas pamati" in module 1, chapter 3 becomes "3.1. ES tiesību sistēmas pamati" when the structure table lists chapters as "3.1.", "3.2.", …; keep the exact wording after the number.
- MODULE DIVIDER: when the document names its module and chapter (a course-structure table such as "M1 – …" with chapters "1.1., 1.2., 1.3., 1.4."), the FIRST lesson of the course is a divider — { "title": "<module no>. modulis | Nodaļa <chapter no>/<chapters in the module>", "type": "section", "blocks": [] } — e.g. "1. modulis | Nodaļa 3/4" for chapter 3 of a four-chapter module 1. Use the document's language for the words.

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
  "production": []
}

"production" is kept for schema compatibility and is ALWAYS []. (If an operator instruction ever asks for it, an entry is { "kind": "narration", "lesson": "<lesson title>", "sourceRef": <sourceRef>, "text": "<text>" } — "kind" is ALWAYS the literal "narration".)

Every block is an object whose block-type fields live INSIDE the "intent" OBJECT — "intent" is never a string label. Worked example of one complete block:

{
  "intent": { "kind": "text", "heading": "Welcome", "paragraphs": ["<p>Exact source text.</p>"] },
  "sourceRef": { "label": "Slide 7", "slideNo": 7, "excerpt": "Exact source" },
  "notes": [],
  "origin": "source"
}

Every sourceRef (provenance — required on every block, unresolved item, and production item):
{ "label": "<human-readable location, e.g. 'Slide 7', 'Row 12' or 'Slide 7, comment by J. Doe'>", "slideNo": <the slide number for a deck; null for a table-based storyboard unless it has a real slide/screen-number column — NEVER put a table row number here>, "row": <table row number — TABLE-BASED STORYBOARDS ONLY, omit for decks>, "excerpt": "<OPTIONAL — omit it on table-based storyboards ("row" is exact provenance); for decks, a verbatim snippet of at most ~60 characters>" }

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
10. "fill-in-the-blank" — the learner TYPES the answer. { "kind": "fill-in-the-blank", "heading": optional, "intro": [], "questions": [{ "stem": "<p>…</p>" (HTML; write the gap as _____ if the source shows one), "answers": ["<accepted answer>", …] (plain text; any one counts as correct), "feedback": "<p>…</p>" (HTML, optional) }] }. Use ONLY when the source gives the exact expected word(s); otherwise it belongs in "unresolved". One Rise block per question.
11. "matching" — drag items onto their matches. { "kind": "matching", "heading": optional, "intro": [], "stem": "<p>…</p>" (HTML instruction), "pairs": [{ "left": "<plain>", "right": "<plain>" }, …] (at least 2), "feedback": "<p>…</p>" (HTML, optional) }. "left" is the draggable, "right" its correct match; every pair must be evidenced by the source.
12. "table" — a data/comparison table. { "kind": "table", "heading": optional, "intro": [], "columns": ["<header cell>", …] (inline HTML allowed), "rows": [["<cell>", …], …] } — EVERY row has exactly columns.length cells; use "" for an empty cell. Use for genuinely tabular source content (comparisons, specifications), never as a layout trick.
13. "labeled-graphic" — an image with clickable markers that pop up text. { "kind": "labeled-graphic", "heading": optional, "intro": [], "items": [{ "title": "<marker label, short>", "body": "<p>…</p>" (HTML popup text) }, …] }. The picture itself is a built-in placeholder and marker positions are generated — describe the intended image in the block's "notes" (see the image rule above). Use when the source presents labelled parts/areas of one picture or scheme.
14. "note" — a highlighted callout. { "kind": "note", "paragraphs": ["<p>…</p>", …] (HTML) }. For warnings, key takeaways, "remember" boxes.
15. "links" — a stack of link buttons. { "kind": "links", "heading": optional, "intro": [], "buttons": [{ "label": "<plain>", "destination": "<https URL>", "description": "<plain, may be "">" }, …], "trailing": optional HTML array }.
16. "video-placeholder" — where the source has/needs a video. { "kind": "video-placeholder", "label": "<what belongs here, e.g. 'Video: intro interview (~3 min)'>", "url": "<optional — the YouTube URL ONLY if the source states it>" }.
17. "storyline-placeholder" — where an interactive activity beyond this vocabulary is required. { "kind": "storyline-placeholder", "label": "<what belongs here>" }.
18. "attachment-placeholder" — where a downloadable file belongs. { "kind": "attachment-placeholder", "label": "<file and purpose>", "file": "<optional — an exact file name from "Available files" below>" }.
19. "continue" — a "continue" gate button between sections. { "kind": "continue", "label": "<button text, sentence case — never ALL CAPS>" }.
20. "quote" — a highlighted deep-dive / expert card (the house "Tēmas padziļināšanai" element). { "kind": "quote", "heading": "<plain, optional — e.g. 'Tēmas padziļināšanai'>", "text": "<p>…</p>" (HTML), "attribution": "<plain, optional>" }. Use for "to learn more" lead-ins, expert asides, and real quotations; a following "links" block carries the resources.
21. "banner" — a full-width titled section banner. { "kind": "banner", "label": "<short title — e.g. 'Kopsavilkums', 'Pārbaudi savas zināšanas!', 'Uzdevums'>", "subtitle": "<plain, optional second line>" }. Use where the source marks a section start with a standalone title line such as a summary ("Kopsavilkums") or a self-check ("Pārbaudi savas zināšanas"); the content that follows stays in its own blocks.

## Design hints (optional fields — never required)

- Every block may carry "band": "white" | "light" | "accent" — the background band the block should sit on. The house rhythm alternates white and light-blue bands between TOPIC GROUPS; blocks that belong to one idea (a heading and its two paragraphs) share a band. Suggest a band only where grouping is clear; omit it otherwise and the compiler alternates for you. Video blocks are always "accent" (set automatically).
- A "text" block may carry "image": "<exact file name from Available files>" — it becomes an image + text block with the picture beside the prose. A "banner" may carry "image" for its picture. Never put "image" on other kinds.
- PLACEMENT: "band" and "image" are BLOCK-level fields, siblings of "intent" — NEVER inside the "intent" object. Correct:
  { "intent": { "kind": "text", "heading": "Līmeņi", "paragraphs": ["<p>…</p>"] }, "image": "1.4.1.4.png", "band": "light", "sourceRef": { "label": "Row 6", "slideNo": null, "row": 6 }, "notes": [] }
- A lesson may carry "icon": "Article" | "Quiz" | "Video" | "Interaction" (Rise's lesson icon; default Article for a content lesson, Quiz for a test lesson), "image": "<exact file name>" (the topic illustration shown in the lesson opener), and "type": "section" for a module divider row — a section lesson has "blocks": [] and only a title (e.g. "1. modulis | Nodaļa 4/4").
- LESSON OPENER: the FIRST block of every content lesson should be a plain "text" block WITHOUT a heading holding the topic's introductory paragraph(s) (a storyboard row marked as the topic intro, e.g. "Tēmas ievads", "paragraph with heading" whose heading repeats the lesson title). The compiler turns the lesson title + this intro into the house opener (title, illustrated intro, Continue); do not repeat the lesson title as a heading.
- A summary row ("Kopsavilkums") → a "banner" with that label followed by the summary text as its own "text"/"list" block(s). A self-check lead-in ("Pārbaudi savas zināšanas!") → a "banner", then the knowledge-check block(s). A "Tēmas padziļināšanai" lead-in → a "quote" (heading = that phrase, text = the lead-in sentence), then the "links" block with the resources.

## Directive alias table (authors write Rise's UI names — map them)

- paragraph / heading / heading and paragraph / subheading / text on image → "text"
- statement (A/B/C/D) / note / callout → "note"
- bulleted list / checkbox list → "list" with "ordered": false; numbered list → "list" with "ordered": true
- accordion → "accordion" · tabs → "tabs"
- flipcards / flip cards / flashcard grid / flashcard stack → "flashcards"
- process → "process" · timeline → "timeline" · sorting activity → "sorting"
- quote / quote carousel / expert quote / tēmas padziļināšanai → "quote"
- image & text / image and text / text with image / picture → "text" (plus "image" naming a file from "Available files" when one clearly matches; otherwise add an "unresolved" entry for the picture)
- summary banner / section title banner / Kopsavilkums / Pārbaudi savas zināšanas → "banner"
- button / button stack / links / resources → "links"
- continue / divider → "continue"
- multiple choice / multiple response / quiz / knowledge check → "knowledge-check" (only with evidenced answers)
- fill in the blank / fill-in / type the answer → "fill-in-the-blank" · matching / match the pairs / drag to match → "matching"
- labeled graphic / labelled graphic / hotspots / markers / clickable image / image with pop-ups → "labeled-graphic"
- table / comparison table / matrix → "table"
- video / embed → "video-placeholder" · attachment / download → "attachment-placeholder"
- storyline / mighty / horizontal accordion / scenario / any interactive not listed above → "storyline-placeholder"
- image centered / gallery / images with notes → "text" carrying the text content, plus an "unresolved" entry for the visual part

A directive naming TWO blocks ("Knowledge check + table", "Text + links", "Labeled graphic, Flipcards") means BOTH: emit each block in the order named, splitting the row's text between them by content. A directive NOT in this table: use the nearest listed block that can carry the TEXT, add a block note naming the original directive verbatim, and add an "unresolved" entry if any part (visuals, interaction) cannot be represented. Never bury source text inside a placeholder label — placeholders are only for video, attachments, and interactives.

## Table-based storyboards (Word documents)

Many source documents are not decks but a storyboard TABLE: one row per screen/block, with columns such as screen number, block/experience type, narration, on-screen text, and comments.

- The ROW is the unit of conversion. Each row usually yields one block (or the two a combined directive names); adjacent rows may still be merged or split by meaning.
- A "block type" / "learning experience" column IS the directive column: its value is BINDING for that row — map it through the alias table.
- Provenance: put the table row number in "sourceRef.row" (1-based, counting the header row as row 1) on EVERY block and unresolved item, and OMIT "excerpt" — the row number locates the source exactly, and 60+ excerpts of 200 characters are what pushes a course past the message limit. "slideNo" is null UNLESS the document has a filled-in slide/screen-number column — a row number is NEVER a slideNo. "label" reads like "Row 12".
- A NARRATION / audio / voice-over column is never content and is never copied (see the narration rule). A row whose directive is a video lecture / interview becomes ONE "video-placeholder" whose label names the video (type, speaker, duration); its script stays in the source document.
- Storyboards often OPEN WITH A LEGEND explaining their own conventions (e.g. "italic text is not shown on screen", "text in [square brackets] is a button or clickable element", "the comments column is internal"). READ the legend and OBEY it: text the legend marks as not-on-screen (designer notes, feedback labels like "Feedback:") never becomes course content — feedback text goes into the block's "feedback" fields, notes into "notes". A bracketed button such as [NEXT] / [CONTINUE] / [TĀLĀK] at the end of a row is a "continue" block, not text. Internal-comment columns are never content; treat them like comments (see above).
- Rows explicitly marked as "to be completed later" / placeholder text are recorded in "unresolved", not emitted as blocks.

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

${
    images.length > 0
      ? `## Available files (the operator's asset folder — reference by EXACT name)

${images.map((n) => `- ${n}`).join('\n')}

Match files to content by their names (designers number them by module/chapter/slide, e.g. "1.3.2.19.png" = course 1.3, chapter 2, slide 19; "2-5-0.png" = chapter 2.5, opener). Use each file where the source places that picture; when unsure, leave the field out rather than guess.

`
      : ''
  }Before answering, verify: every block has a sourceRef with a real slide/page reference (or "row" for a table-based storyboard); every invented or rephrased text is marked "origin": "suggested"; every directive was mapped through the alias table; open comments and contradictions are in "unresolved"; there are no knowledge checks the source does not evidence; "assets" is [] and "production" is []; no narration script was copied; nothing else from the source is silently missing (used or in unresolved); table-storyboard refs carry "row", never a row number in "slideNo"; every "image"/"file" value is an exact name from "Available files"; button labels are sentence case.${
    extra
      ? `

## Operator instructions for this document

${extra}`
      : ''
  }`;
}
