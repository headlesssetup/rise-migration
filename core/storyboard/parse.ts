// Storyboard phase 1 — the INTEA SD conventions engine.
//
// Input: the formatting-aware docx model. Output: a PlannedCourse of block
// INTENTS + unparsed rows + the production report entries. The conventions
// (spec: docs/rise-storyboard-plan.md) as they appear in the document:
//
//   - First `Heading1` body paragraph        → the course title (whole doc = 1 course)
//   - The table whose header starts `Slaida` → the storyboard; single-cell rows
//     (`Tēma x.y.z: …`) are lesson dividers, 5-cell rows are slides
//   - `Slaida nr.` is Word AUTO-numbering    → computed by counting numbered
//     paragraphs in document order (never by row index)
//   - `Mācību pieredze` (+ `Komentāri`)      → block kind, by FIRST keyword position
//   - In `Teksts uz ekrāna`: bold paragraphs delimit headings/items/questions;
//     list paragraphs are options/entries; green `00B050` marks the correct
//     answer (official); italic paragraphs are designer notes / feedback and
//     never screen text; `[BRACKET]`-only paragraphs are buttons/navigation
//     (dropped + noted) — except in a timeline, where they are the events
//   - `Audio teksts`                         → the filming script (production report)
//
// Anything unclassifiable lands in `unparsed[]` with the slide number — the
// review UI surfaces it loudly; nothing passes silently.

import { cellText, paraText, type SdCell, type SdDoc, type SdPara } from './docx';
import {
  StoryboardError,
  type BlockIntent,
  type IntentItem,
  type KcQuestion,
  type PlannedBlock,
  type PlannedCourse,
  type PlannedLesson,
  type ProductionItem,
  type Provenance,
  type UnparsedRow,
} from './types';

export const GREEN_CORRECT = '00B050';

// ---------------------------------------------------------------------------
// Paragraph predicates + HTML rendering

function nonWsRuns(p: SdPara) {
  return p.runs.filter((r) => r.text.trim() !== '');
}

function isEmptyPara(p: SdPara): boolean {
  return paraText(p).trim() === '';
}

/** Every non-whitespace run bold (and at least one). */
function isBoldPara(p: SdPara): boolean {
  const runs = nonWsRuns(p);
  return runs.length > 0 && runs.every((r) => r.bold);
}

/** Every non-whitespace run italic (and at least one). */
function isItalicPara(p: SdPara): boolean {
  const runs = nonWsRuns(p);
  return runs.length > 0 && runs.every((r) => r.italic);
}

function isListPara(p: SdPara): boolean {
  return p.numId !== undefined;
}

function hasGreenRun(p: SdPara): boolean {
  return p.runs.some((r) => r.color === GREEN_CORRECT && r.text.trim() !== '');
}

/** Whole paragraph is a single `[…]` group (button / navigation). */
function isBracketOnly(p: SdPara): boolean {
  return /^\s*\[[^\[\]]*\]\s*$/.test(paraText(p));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Runs → inline HTML (bold/italic/links preserved; newlines → <br>). */
function runsToHtml(p: SdPara): string {
  let out = '';
  for (const r of p.runs) {
    let t = escapeHtml(r.text).replace(/\n/g, '<br>');
    if (r.bold) t = `<strong>${t}</strong>`;
    if (r.italic) t = `<em>${t}</em>`;
    if (r.link) t = `<a href="${escapeHtml(r.link)}">${t}</a>`;
    out += t;
  }
  return out;
}

function paraToHtml(p: SdPara): string {
  return `<p>${runsToHtml(p)}</p>`;
}

function parasToHtml(paras: SdPara[]): string {
  return paras.map(paraToHtml).join('');
}

// ---------------------------------------------------------------------------
// Row classification — first keyword position wins (`experience` scanned
// before `comments`, so the designer's own column takes precedence).

type RowKind =
  | 'storyline'
  | 'video'
  | BlockIntent['kind']
  | 'interactive-unknown'
  | 'kc-attempt';

interface KeywordRule {
  re: RegExp;
  kind: RowKind;
  note?: string;
}

// Order inside the array only breaks ties at the SAME text position.
const WIDGET_RULES: KeywordRule[] = [
  { re: /mighty|storyline/i, kind: 'storyline' },
  { re: /video/i, kind: 'video' },
  { re: /accordion/i, kind: 'accordion' },
  { re: /tabs/i, kind: 'tabs' },
  { re: /flip\s?cards?|flashcards?/i, kind: 'flashcards' },
  { re: /timeline/i, kind: 'timeline' },
  { re: /process/i, kind: 'process' },
  { re: /sorting|kārtošana/i, kind: 'sorting' },
  {
    re: /labeled\s?graphic/i,
    kind: 'flashcards',
    note: 'Labeled Graphic pārvērsts par Flipcards (teksta kurss bez attēliem — operatora lēmums 2026-08-10)',
  },
  { re: /\bnote\b/i, kind: 'note' },
];

const KC_RE = /zināšanu pārbaude|knowledge check|pārbaudi sevi|uzdevums|jautājum/i;

function classifyRow(
  experience: string,
  comments: string,
): { kind: RowKind; notes: string[] } {
  const notes: string[] = [];
  const texts = [experience, comments];
  let best: { pos: number; textIdx: number; rule: KeywordRule } | null = null;
  const matched: string[] = [];
  for (let ti = 0; ti < texts.length; ti++) {
    const text = texts[ti] ?? '';
    for (const rule of WIDGET_RULES) {
      const m = rule.re.exec(text);
      if (!m) continue;
      matched.push(m[0]);
      if (!best || ti < best.textIdx || (ti === best.textIdx && m.index < best.pos)) {
        best = { pos: m.index, textIdx: ti, rule };
      }
    }
  }
  if (best) {
    if (matched.length > 1) {
      notes.push(`Scenārijā minēti vairāki elementi (${matched.join(', ')}) — izvēlēts pirmais atbalstītais`);
    }
    if (best.rule.note) notes.push(best.rule.note);
    return { kind: best.rule.kind, notes };
  }
  if (KC_RE.test(experience) || KC_RE.test(comments)) return { kind: 'kc-attempt', notes };
  if (/saite|resurs|button/i.test(experience)) return { kind: 'links', notes };
  if (/interakt/i.test(experience)) return { kind: 'interactive-unknown', notes };
  return { kind: 'text', notes };
}

// ---------------------------------------------------------------------------
// Per-kind cell parsers. Each returns an intent or a string (unparsed reason).

interface CellParse {
  intent?: BlockIntent;
  reason?: string;
  notes: string[];
}

/** Common preprocessing: drop empties; peel off bracket-only (button) and
 *  standalone-italic (designer note) paragraphs, recording each. */
function prepare(
  paras: SdPara[],
  opts: { keepBrackets?: boolean; keepItalic?: boolean } = {},
): { paras: SdPara[]; notes: string[] } {
  const notes: string[] = [];
  const kept: SdPara[] = [];
  for (const p of paras) {
    if (p.hidden) {
      const t = paraText(p).trim();
      if (t) notes.push(`Slēpts teksts (vanish, Word to nerāda) izlaists: ${t.slice(0, 100)}`);
      continue;
    }
    if (isEmptyPara(p)) continue;
    if (!opts.keepBrackets && isBracketOnly(p)) {
      notes.push(`Poga/navigācija izlaista: ${paraText(p).trim()}`);
      continue;
    }
    if (!opts.keepItalic && isItalicPara(p) && !isListPara(p) && !isBoldPara(p)) {
      notes.push(`Dizainera piezīme (kursīvs, nerāda uz ekrāna): ${paraText(p).trim().slice(0, 120)}`);
      continue;
    }
    kept.push(p);
  }
  return { paras: kept, notes };
}

function parseTextCell(paras: SdPara[], sd: SdDoc): CellParse {
  const { paras: ps, notes } = prepare(paras);
  if (ps.length === 0) return { reason: 'tukša ekrāna teksta šūna', notes };

  const first = ps[0]!;
  const heading = isBoldPara(first) ? paraText(first).trim() : undefined;
  const rest = heading ? ps.slice(1) : ps;

  const firstList = rest.findIndex(isListPara);
  if (firstList !== -1) {
    const intro = rest.slice(0, firstList).map(paraToHtml);
    const items: string[] = [];
    let i = firstList;
    for (; i < rest.length && isListPara(rest[i]!); i++) items.push(paraToHtml(rest[i]!));
    const outro = rest.slice(i).map(paraToHtml);
    const numId = rest[firstList]!.numId!;
    const ordered = sd.numFmt[numId] === 'decimal';
    return {
      intent: { kind: 'list', ordered, heading, intro, items, ...(outro.length ? { outro } : {}) },
      notes,
    };
  }
  return {
    intent: { kind: 'text', heading, paragraphs: rest.map(paraToHtml) },
    notes,
  };
}

function parseItemsCell(
  paras: SdPara[],
  kind: 'accordion' | 'tabs' | 'flashcards' | 'process',
): CellParse {
  // Brackets stay: a BOLD `[…]` paragraph is a clickable ITEM TITLE (the SD's
  // convention for accordion panels / tabs / cards); only a NON-bold `[…]`
  // paragraph is a button/navigation.
  const { paras: ps, notes } = prepare(paras, { keepBrackets: true });
  if (ps.length === 0) return { reason: 'tukša ekrāna teksta šūna', notes };

  const isItemBracket = (p: SdPara) => isBracketOnly(p) && isBoldPara(p);
  const bracketMode = ps.some(isItemBracket);

  const first = ps[0]!;
  const heading =
    isBoldPara(first) && !isBracketOnly(first) ? paraText(first).trim() : undefined;
  const rest = heading ? ps.slice(1) : ps;

  const intro: string[] = [];
  const items: IntentItem[] = [];
  let current: { title: string; body: SdPara[] } | null = null;
  const startsItem = (p: SdPara) => (bracketMode ? isItemBracket(p) : isBoldPara(p));
  for (const p of rest) {
    if (isBracketOnly(p) && !isItemBracket(p)) {
      notes.push(`Poga/navigācija izlaista: ${paraText(p).trim()}`);
      continue;
    }
    if (startsItem(p)) {
      if (current) items.push({ title: current.title, body: parasToHtml(current.body) });
      const raw = paraText(p).trim();
      const title = bracketMode ? raw.replace(/^\[|\]$/g, '').trim() : raw;
      current = { title, body: [] };
    } else if (current) {
      current.body.push(p);
    } else {
      intro.push(paraToHtml(p));
    }
  }
  if (current) items.push({ title: current.title, body: parasToHtml(current.body) });

  if (items.length === 0) {
    // Fallback: list paragraphs as title-only items (e.g. a structure overview).
    const listOnly = rest.filter(isListPara);
    if (listOnly.length > 0) {
      notes.push('Vienumi atvasināti no saraksta rindkopām (bez treknraksta virsrakstiem)');
      return {
        intent: {
          kind,
          heading,
          intro,
          items: listOnly.map((p) => ({ title: paraText(p).trim(), body: '' })),
        },
        notes,
      };
    }
    return { reason: `interaktīvajam blokam (${kind}) neizdevās atpazīt vienumus`, notes };
  }
  return { intent: { kind, heading, intro, items }, notes };
}

function parseTimelineCell(paras: SdPara[]): CellParse {
  // Bracket paragraphs ARE the events here — keep them.
  const { paras: ps, notes } = prepare(paras, { keepBrackets: true });
  if (ps.length === 0) return { reason: 'tukša ekrāna teksta šūna', notes };

  const tlFirst = ps[0]!;
  const heading = isBoldPara(tlFirst) ? paraText(tlFirst).trim() : undefined;
  const rest = heading ? ps.slice(1) : ps;

  const intro: string[] = [];
  const events: { date: string; title: string; body: string }[] = [];
  for (const p of rest) {
    const text = paraText(p).trim();
    const m = /^\[([^\[\]]+)\]$/.exec(text);
    if (m) {
      const inner = m[1]!;
      const colon = inner.indexOf(':');
      if (colon === -1) {
        // No `date:` part — a button/navigation bracket, not an event.
        notes.push(`Poga/navigācija izlaista: ${text}`);
        continue;
      }
      events.push({
        date: inner.slice(0, colon).trim(),
        title: '',
        body: `<p>${escapeHtml(inner.slice(colon + 1).trim())}</p>`,
      });
    } else if (events.length === 0) {
      intro.push(paraToHtml(p));
    } else {
      notes.push(`Teksts pēc laika joslas notikumiem izlaists: ${text.slice(0, 80)}`);
    }
  }
  if (events.length === 0) {
    return { reason: 'laika joslai (timeline) neizdevās atpazīt notikumus [datums: apraksts]', notes };
  }
  return { intent: { kind: 'timeline', heading, intro, events }, notes };
}

function parseSortingCell(paras: SdPara[]): CellParse {
  // Piles/cards are often italic in the SD (shuffled on screen) — italic is
  // NOT a designer-note marker inside a sorting cell.
  const { paras: ps, notes } = prepare(paras, { keepItalic: true });
  if (ps.length === 0) return { reason: 'tukša ekrāna teksta šūna', notes };

  const soFirst = ps[0]!;
  const heading = isBoldPara(soFirst) && !isListPara(soFirst) ? paraText(soFirst).trim() : undefined;
  const rest = heading ? ps.slice(1) : ps;

  const intro: string[] = [];
  const piles: string[] = [];
  const cards: { title: string; pile: number }[] = [];
  for (const p of rest) {
    if (isListPara(p)) {
      if (piles.length === 0) {
        return { reason: 'kārtošanas uzdevumā kartīte parādās pirms kategorijas', notes };
      }
      cards.push({ title: paraText(p).trim(), pile: piles.length });
    } else if (isBoldPara(p)) {
      piles.push(paraText(p).trim());
    } else if (isItalicPara(p) && piles.length === 0) {
      notes.push(`Dizainera piezīme (kursīvs): ${paraText(p).trim().slice(0, 120)}`);
    } else if (piles.length === 0) {
      intro.push(paraToHtml(p));
    } else {
      notes.push(`Teksts starp kategorijām izlaists: ${paraText(p).trim().slice(0, 80)}`);
    }
  }
  if (piles.length === 0 || cards.length === 0) {
    return { reason: 'kārtošanas uzdevumam neizdevās atpazīt kategorijas/kartītes', notes };
  }
  return { intent: { kind: 'sorting', heading, intro, piles, cards }, notes };
}

const FEEDBACK_RE = /^atgriezenisk/i;
const QUESTION_MARKER_RE = /jautājums\s*$|^\s*\d+[.)]?\s*jautājums/i;

function parseKcCell(paras: SdPara[]): CellParse {
  // Feedback is italic — must NOT be dropped as a designer note here.
  const { paras: ps, notes } = prepare(paras, { keepItalic: true });
  if (ps.length === 0) return { reason: 'tukša ekrāna teksta šūna', notes };

  const markerIdx = ps
    .map((p, i) => (isBoldPara(p) && QUESTION_MARKER_RE.test(paraText(p).trim()) ? i : -1))
    .filter((i) => i !== -1);

  let heading: string | undefined;
  const intro: string[] = [];
  const questions: KcQuestion[] = [];

  const parseOne = (qParas: SdPara[]): KcQuestion | string => {
    const stem: string[] = [];
    const options: { text: string; correct: boolean }[] = [];
    const feedback: string[] = [];
    let mode: 'stem' | 'options' | 'feedback' = 'stem';
    for (const p of qParas) {
      if (isListPara(p)) {
        mode = 'options';
        options.push({ text: paraText(p).trim(), correct: hasGreenRun(p) });
      } else if (isItalicPara(p) && FEEDBACK_RE.test(paraText(p).trim())) {
        mode = 'feedback';
        const after = paraText(p).trim().replace(/^atgriezenisk[^:]*:\s*/i, '');
        if (after) feedback.push(`<p>${escapeHtml(after)}</p>`);
      } else if (mode === 'stem') {
        stem.push(paraToHtml(p));
      } else if (mode === 'feedback') {
        feedback.push(paraToHtml(p));
      } else {
        // prose after options but before a feedback marker — treat as feedback
        feedback.push(paraToHtml(p));
      }
    }
    if (options.length === 0) return 'jautājumam nav atbilžu variantu';
    if (!options.some((o) => o.correct)) {
      return 'nevienam atbilžu variantam nav zaļā (pareizās atbildes) marķējuma';
    }
    return {
      stem: stem.join(''),
      options,
      ...(feedback.length ? { feedback: feedback.join('') } : {}),
    };
  };

  if (markerIdx.length > 0) {
    // Header zone before the first question marker.
    const head = ps.slice(0, markerIdx[0]!);
    if (head.length > 0 && isBoldPara(head[0]!)) {
      heading = paraText(head[0]!).trim();
      intro.push(...head.slice(1).map(paraToHtml));
    } else {
      intro.push(...head.map(paraToHtml));
    }
    for (let i = 0; i < markerIdx.length; i++) {
      const from = markerIdx[i]! + 1; // the marker itself ("1. jautājums") is scaffolding
      const to = i + 1 < markerIdx.length ? markerIdx[i + 1] : ps.length;
      const q = parseOne(ps.slice(from, to));
      if (typeof q === 'string') {
        return { reason: `${i + 1}. jautājums: ${q}`, notes };
      }
      questions.push(q);
    }
  } else {
    // Single unmarked question: bold first paragraph is the block heading.
    let rest = ps;
    const kcFirst = ps[0]!;
    if (isBoldPara(kcFirst) && !isListPara(kcFirst)) {
      heading = paraText(kcFirst).trim();
      rest = ps.slice(1);
    }
    const q = parseOne(rest);
    if (typeof q === 'string') return { reason: q, notes };
    if (q.stem.trim() === '' && heading) {
      q.stem = `<p>${escapeHtml(heading)}</p>`;
      heading = undefined;
    }
    questions.push(q);
  }
  return { intent: { kind: 'knowledge-check', heading, intro, questions }, notes };
}

/** A links/resources cell → button-stack intent. Groups start at a bold title
 *  (optional) and close at the paragraph carrying the hyperlink: the linked
 *  text is the button label, the group's other paragraphs its description.
 *  A cell with no hyperlinks at all falls back to a plain text block. */
function parseLinksCell(paras: SdPara[], sd: SdDoc): CellParse {
  // Brackets stay: the SD writes each button as `[Atvērt LES]` with the
  // hyperlink INSIDE the brackets — exactly the buttons we're building.
  // A bracket-only paragraph without a hyperlink is still navigation.
  const { paras: ps, notes } = prepare(paras, { keepBrackets: true });
  if (ps.length === 0) return { reason: 'tukša ekrāna teksta šūna', notes };

  const linkOf = (p: SdPara) => p.runs.find((r) => r.link && r.text.trim() !== '');
  if (!ps.some((p) => linkOf(p))) {
    const fallback = parseTextCell(paras, sd);
    fallback.notes.push('Saišu rindā nav nevienas hipersaites — pārnests kā teksts');
    return fallback;
  }

  const first = ps[0]!;
  const heading = isBoldPara(first) && !linkOf(first) ? paraText(first).trim() : undefined;
  const rest = heading ? ps.slice(1) : ps;

  const intro: string[] = [];
  const buttons: { label: string; destination: string; description: string }[] = [];
  const trailing: string[] = [];
  let group: SdPara[] = [];
  let sawGroupStart = false;
  for (const p of rest) {
    const link = linkOf(p);
    if (link) {
      const label = p.runs
        .filter((r) => r.link)
        .map((r) => r.text)
        .join('')
        .trim()
        .replace(/^\[|\]$/g, '')
        .trim();
      buttons.push({
        label,
        destination: link.link!,
        description: parasToHtml(group),
      });
      group = [];
      sawGroupStart = false;
    } else if (isBracketOnly(p)) {
      notes.push(`Poga/navigācija izlaista: ${paraText(p).trim()}`);
    } else if (isBoldPara(p)) {
      // A bold title starts a new button group; whatever preceded the first
      // group (and follows the last link) is intro/trailing prose.
      if (!sawGroupStart && buttons.length === 0) intro.push(...group.map(paraToHtml));
      else trailing.push(...group.map(paraToHtml));
      group = [p];
      sawGroupStart = true;
    } else {
      group.push(p);
    }
  }
  if (group.length > 0) trailing.push(...group.map(paraToHtml));

  return {
    intent: {
      kind: 'links',
      heading,
      intro,
      buttons,
      ...(trailing.length ? { trailing } : {}),
    },
    notes,
  };
}

function parseNoteCell(paras: SdPara[]): CellParse {
  const { paras: ps, notes } = prepare(paras);
  if (ps.length === 0) return { reason: 'tukša ekrāna teksta šūna', notes };
  return { intent: { kind: 'note', paragraphs: ps.map(paraToHtml) }, notes };
}

// ---------------------------------------------------------------------------
// The storyboard table walk

const SLIDE_HEADER_RE = /^\s*slaida/i;

function findStoryboardTable(sd: SdDoc): { rows: SdCell[][] } {
  for (const item of sd.body) {
    if (item.kind !== 'table') continue;
    const first = item.rows[0]?.[0];
    if (first && SLIDE_HEADER_RE.test(cellText(first))) return item;
  }
  throw new StoryboardError(
    'Scenārija tabula nav atrasta (neviena tabula nesākas ar "Slaida nr." galveni).',
  );
}

function findCourseTitle(sd: SdDoc): string {
  for (const item of sd.body) {
    if (item.kind === 'para' && item.style?.startsWith('Heading1')) {
      const t = paraText(item).trim();
      if (t) return t;
    }
  }
  throw new StoryboardError('Kursa nosaukums nav atrasts (nav Heading1 rindkopas).');
}

/** Rendered `Slaida nr.` values per row: count auto-numbered paragraphs of the
 *  slide-number list in document order. Returns the FIRST number in each row's
 *  first cell (null when the row has none). */
function computeSlideNumbers(rows: SdCell[][]): (number | null)[] {
  // The slide list's numId = the first VISIBLE numbered paragraph in column 0.
  // Hidden (`w:vanish`) paragraphs neither render nor consume a number in Word
  // — counting one shifted every following slide by +1 (found on the VAS SD).
  let slideNumId: string | undefined;
  for (const row of rows.slice(1)) {
    for (const p of row[0]?.paras ?? []) {
      if (p.numId !== undefined && !p.hidden) {
        slideNumId = p.numId;
        break;
      }
    }
    if (slideNumId) break;
  }
  let counter = 0;
  return rows.map((row, i) => {
    if (i === 0) return null;
    let first: number | null = null;
    for (const p of row[0]?.paras ?? []) {
      if (slideNumId !== undefined && p.numId === slideNumId && !p.hidden) {
        counter++;
        if (first === null) first = counter;
      }
    }
    return first;
  });
}

const EMPTY_AUDIO_RE = /^[\s\-–—]*$/;

/** Parse a whole SD document model into the PlannedCourse. */
export function parseStoryboard(sd: SdDoc): PlannedCourse {
  const title = findCourseTitle(sd);
  const table = findStoryboardTable(sd);
  const slideNos = computeSlideNumbers(table.rows);

  const lessons: PlannedLesson[] = [];
  const unparsed: UnparsedRow[] = [];
  const production: ProductionItem[] = [];
  let current: PlannedLesson | null = null;

  for (let i = 1; i < table.rows.length; i++) {
    const row = table.rows[i];
    if (!row) continue;
    // Lesson divider: a single merged cell with text.
    if (row.length === 1 && row[0]) {
      const t = cellText(row[0]).trim();
      if (t) {
        current = { title: t, blocks: [] };
        lessons.push(current);
      }
      continue;
    }
    if (row.every((c) => cellText(c).trim() === '')) continue; // blank spacer row

    const cellAt = (n: number): SdCell => row[n] ?? { paras: [] };
    const experience = cellText(cellAt(1)).trim();
    const audio = cellText(cellAt(2)).trim();
    const screen = cellAt(3).paras;
    const comments = cellText(cellAt(4)).trim();
    const provenance: Provenance = {
      slideNo: slideNos[i] ?? null,
      tableRow: i,
      experience,
      comments,
      rawScreenText: cellText(cellAt(3)),
    };

    if (!current) {
      current = { title, blocks: [] };
      lessons.push(current);
    }

    if (row.length < 5) {
      unparsed.push({
        provenance,
        reason: `rindā ir ${row.length} šūnas (gaidītas 5) — nevar droši nolasīt kolonnas`,
      });
      continue;
    }

    if (!EMPTY_AUDIO_RE.test(audio)) {
      production.push({
        lesson: current.title,
        slideNo: provenance.slideNo,
        experience,
        audioText: audio,
      });
    }

    const { kind, notes: classNotes } = classifyRow(experience, comments);

    if (kind === 'storyline') {
      const slide = provenance.slideNo != null ? `slaidu nr. ${provenance.slideNo}` : `scenārija rindu ${i}`;
      current.blocks.push({
        intent: {
          kind: 'storyline-placeholder',
          label: `Aizvietot ar Storyline/Mighty aktivitāti — skat. ${slide}`,
        },
        provenance,
        notes: classNotes,
      });
      continue;
    }
    if (kind === 'video') {
      current.blocks.push({
        intent: { kind: 'video-placeholder', label: experience.replace(/\s+/g, ' ').trim() },
        provenance,
        notes: classNotes,
      });
      continue;
    }
    if (kind === 'interactive-unknown') {
      unparsed.push({
        provenance,
        reason: 'interaktīvs elements bez atpazīstama Rise bloka nosaukuma — operatora lēmums',
      });
      continue;
    }

    let parsed: CellParse;
    switch (kind) {
      case 'accordion':
      case 'tabs':
      case 'flashcards':
      case 'process':
        parsed = parseItemsCell(screen, kind);
        break;
      case 'timeline':
        parsed = parseTimelineCell(screen);
        break;
      case 'sorting':
        parsed = parseSortingCell(screen);
        break;
      case 'note':
        parsed = parseNoteCell(screen);
        break;
      case 'kc-attempt': {
        parsed = parseKcCell(screen);
        if (parsed.reason === 'jautājumam nav atbilžu variantu') {
          // Prose task with no options at all — keep the text, flag for review.
          parsed = parseTextCell(screen, sd);
          parsed.notes.push(
            'Scenārijā minēts uzdevums, bet šūnā nav atbilžu variantu — pārnests kā teksts, pārbaudi',
          );
        }
        break;
      }
      case 'knowledge-check':
        parsed = parseKcCell(screen);
        break;
      case 'links':
        parsed = parseLinksCell(screen, sd);
        break;
      default:
        parsed = parseTextCell(screen, sd);
    }

    if (parsed.intent) {
      current.blocks.push({
        intent: parsed.intent,
        provenance,
        notes: [...classNotes, ...parsed.notes],
      });
    } else {
      unparsed.push({ provenance, reason: parsed.reason ?? 'neatpazīta rinda' });
    }
  }

  return { title, lessons, unparsed, production };
}
