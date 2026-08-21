// SBDOC — render an archived Rise course document into the storyboard model.
//
// Pure and auth-free: input is the archive's raw `{course, lessons}` JSON
// (immutable source of truth — never mutated), output is `SbCourse` for the
// docx writer. Fidelity is the honest line from the format spec: `edit` only
// for families the storyboard pipeline can rebuild; EVERYTHING else renders
// `ro` (shaded, best-effort text extraction) — including unexpected shapes of
// known families (defensive demotion with a note, never a throw: a storyboard
// export is a read-only view and must not fail on content that copy-faithful
// migration handles).

import { collectAssetKeys } from '@/core/assets/keys';
import { orderLessons } from '@/core/import/plan-helpers';
import { isLocalizedStack, materializeLocale, resolveStackTitle } from '@/core/l10n';
import type { Block, GetCourseDocument, Lesson } from '@/shared/types/rise';
import { htmlToParas, htmlToText } from './html';
import { fnv1a8, type SbCard, type SbCourse, type SbImage, type SbLesson, type SbPara, type SbRow, type SbRun } from './model';

export interface RenderModelOptions {
  /** ISO timestamp stamped into the meta table (injectable for tests). */
  generatedAt: string;
  toolVersion: string;
}

const GREEN_CORRECT = '00B050';

// ---------------------------------------------------------------- helpers ---

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : [];
}

function boldPara(text: string): SbPara {
  return { runs: [{ text, bold: true }] };
}

function italicPara(text: string): SbPara {
  return { runs: [{ text, italic: true }] };
}

/** Inline-HTML value (heading/title fields) → one bold paragraph. */
function boldFromHtml(html: string): SbPara[] {
  return htmlToParas(html).map((p) => ({
    ...p,
    runs: p.runs.map((r) => ({ ...r, bold: true })),
  }));
}

// ---------------------------------------------------- per-family renderers ---

/** An edit renderer returns null when the block's shape is not what it
 *  expects — the caller demotes to `ro` with a note (never a throw). */
type EditRenderer = (b: Block) => SbPara[] | null;

function renderText(b: Block): SbPara[] | null {
  const out: SbPara[] = [];
  for (const it of arr(b.items)) {
    out.push(...hid(it, [...boldFromHtml(str(it.heading)), ...htmlToParas(str(it.paragraph))]));
  }
  return out.length > 0 ? out : null;
}

function renderList(b: Block): SbPara[] | null {
  const kind = b.variant === 'numbered' ? 'number' : 'bullet';
  const out: SbPara[] = [];
  for (const it of arr(b.items)) {
    out.push(
      ...hid(it, htmlToParas(str(it.paragraph)).map((p) => ({ ...p, list: p.list ?? kind }))),
    );
  }
  return out.length > 0 ? out : null;
}

/** Item CONTENT is indented one level under its (bold, flush-left) item title
 *  so accordion-style blocks read title-vs-content at a glance. */
function indented(paras: SbPara[]): SbPara[] {
  return paras.map((p) => ({ ...p, indent: (p.indent ?? 0) + 1 }));
}

/** Mark an item's paras when the item is authored but HIDDEN from learners
 *  (`isHidden: true`, e.g. a Process summary toggled off). The text is still
 *  exposed in the doc — it can be un-hidden in Rise at any time — but shaded
 *  light red by the prose writer so a reviewer knows learners don't see it. */
function hid(it: Record<string, unknown>, paras: SbPara[]): SbPara[] {
  return it.isHidden === true ? paras.map((p) => ({ ...p, hidden: true })) : paras;
}

function renderItemsTitled(b: Block): SbPara[] | null {
  const out: SbPara[] = [];
  for (const it of arr(b.items)) {
    const title = htmlToText(str(it.title));
    const paras: SbPara[] = [];
    if (title) paras.push(boldPara(title));
    paras.push(...indented(htmlToParas(str(it.description))));
    out.push(...hid(it, paras));
  }
  return out.length > 0 ? out : null;
}

function flashcardSide(v: unknown): { html: string; media: boolean } {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  return { html: str(o.description), media: !!o.media };
}

function renderFlashcards(b: Block): SbPara[] | null {
  const out: SbPara[] = [];
  for (const it of arr(b.items)) {
    const front = flashcardSide(it.front);
    const back = flashcardSide(it.back);
    const frontText = htmlToText(front.html);
    const paras: SbPara[] = [boldPara(frontText || (front.media ? '(media)' : ''))];
    const backParas = indented(htmlToParas(back.html));
    if (backParas.length > 0) paras.push(...backParas);
    else if (back.media) paras.push({ runs: [{ text: '(media)' }], indent: 1 });
    out.push(...hid(it, paras));
  }
  return out.some((p) => p.runs.some((r) => r.text.trim() !== '')) ? out : null;
}

/** Flashcards as front/back PAIRS — the prose writer renders one card per
 *  table row (front cell | back cell). Cell paras are unindented; a media-only
 *  side keeps its `(media)` placeholder. */
function extractFlashcards(b: Block): SbCard[] | undefined {
  const cards: SbCard[] = [];
  for (const it of arr(b.items)) {
    const front = flashcardSide(it.front);
    const back = flashcardSide(it.back);
    const frontParas: SbPara[] = htmlToParas(front.html).map((p) => ({
      ...p,
      runs: p.runs.map((r) => ({ ...r, bold: true })),
    }));
    if (frontParas.length === 0 && front.media) frontParas.push(boldPara('(media)'));
    const backParas: SbPara[] = htmlToParas(back.html);
    if (backParas.length === 0 && back.media) backParas.push({ runs: [{ text: '(media)' }] });
    if (frontParas.length === 0 && backParas.length === 0) continue;
    cards.push({ front: hid(it, frontParas), back: hid(it, backParas) });
  }
  return cards.length > 0 ? cards : undefined;
}

function renderProcess(b: Block): SbPara[] | null {
  const out: SbPara[] = [];
  for (const it of arr(b.items)) {
    const title = htmlToText(str(it.title));
    if (it.type === 'intro') {
      const paras: SbPara[] = [];
      if (title) paras.push(boldPara(title));
      paras.push(...htmlToParas(str(it.description)));
      out.push(...hid(it, paras));
    } else {
      out.push(
        ...hid(it, [boldPara(title || '(no title)'), ...indented(htmlToParas(str(it.description)))]),
      );
    }
  }
  return out.length > 0 ? out : null;
}

function renderTimeline(b: Block): SbPara[] | null {
  const out: SbPara[] = [];
  for (const it of arr(b.items)) {
    const date = htmlToText(str(it.date));
    const title = htmlToText(str(it.title));
    out.push(
      ...hid(it, [boldPara(`${date}: ${title}`), ...indented(htmlToParas(str(it.description)))]),
    );
  }
  return out.length > 0 ? out : null;
}

function renderSorting(b: Block): SbPara[] | null {
  const piles = arr((b as Record<string, unknown>).piles);
  if (piles.length === 0) return null;
  const out: SbPara[] = [];
  for (const pile of piles) {
    out.push(boldPara(htmlToText(str(pile.title)) || '(untitled)'));
    for (const card of arr(b.items)) {
      if (card.pileId === pile.id) {
        out.push(...hid(card, [{ runs: [{ text: htmlToText(str(card.title)) }], list: 'bullet' }]));
      }
    }
  }
  return out;
}

function renderKc(b: Block): SbPara[] | null {
  const out: SbPara[] = [];
  for (const q of arr(b.items)) {
    const paras: SbPara[] = [];
    paras.push(...boldFromHtml(str(q.title) || '(no question)'));
    for (const a of arr(q.answers)) {
      const runs: SbRun[] = htmlToParas(str(a.title)).flatMap((p) => p.runs);
      const text = runs.map((r) => r.text).join('') || '(empty answer)';
      paras.push({
        runs: [{ text, ...(a.correct === true ? { color: GREEN_CORRECT } : {}) }],
        list: 'bullet',
      });
      const perAnswer = htmlToText(str(a.feedback));
      if (perAnswer) paras.push(italicPara(`↳ ${perAnswer}`));
    }
    const feedback = htmlToText(str(q.feedback));
    if (feedback) paras.push(italicPara(`Feedback: ${feedback}`));
    out.push(...hid(q, paras));
  }
  return out.length > 0 ? out : null;
}

function renderMatching(b: Block): SbPara[] | null {
  const out: SbPara[] = [];
  for (const q of arr(b.items)) {
    const paras: SbPara[] = [];
    const stem = htmlToText(str(q.title));
    if (stem) paras.push(boldPara(stem));
    for (const a of arr(q.answers)) {
      paras.push({
        runs: [{ text: `${htmlToText(str(a.title))} ⇄ ${htmlToText(str(a.matchTitle))}` }],
        list: 'bullet',
      });
    }
    out.push(...hid(q, paras));
  }
  return out.length > 0 ? out : null;
}

function renderButtons(b: Block): SbPara[] | null {
  const out: SbPara[] = [];
  for (const it of arr(b.items)) {
    const label = htmlToText(str(it.label)) || htmlToText(str(it.title));
    const destination = str(it.destination) || str(it.url);
    if (!label) continue;
    const paras: SbPara[] = [
      { runs: [{ text: `[${label}]`, ...(destination ? { link: destination } : {}) }] },
    ];
    const description = htmlToText(str(it.description));
    if (description) paras.push({ runs: [{ text: description }] });
    out.push(...hid(it, paras));
  }
  return out.length > 0 ? out : null;
}

function renderContinue(b: Block): SbPara[] | null {
  const label = htmlToText(str(arr(b.items)[0]?.title));
  return label ? [{ runs: [{ text: `[${label}]` }] }] : null;
}

/** family (or family/variant) → edit renderer. The set mirrors the SD→Rise
 *  mapper (format spec: `edit` = rebuildable). */
const EDIT: Record<string, EditRenderer> = {
  'text': renderText,
  'impact/note': renderText,
  'list': renderList,
  'interactive/accordion': renderItemsTitled,
  'interactive/tabs': renderItemsTitled,
  'flashcard/flashcard': renderFlashcards,
  'interactive-fullscreen/process': renderProcess,
  'interactive-fullscreen/timeline': renderTimeline,
  'interactive-fullscreen/sorting': renderSorting,
  'knowledgeCheck/multiple choice': renderKc,
  'knowledgeCheck/multiple response': renderKc,
  'knowledgeCheck/matching': renderMatching,
  'buttons': renderButtons,
  'continue': renderContinue,
};

// ------------------------------------------------------ ro text extraction ---

/** Keys whose string values are worth showing on a read-only row. */
const RO_TEXT_KEYS = new Set([
  'title', 'heading', 'paragraph', 'description', 'caption', 'altText',
  'label', 'text', 'url', 'date', 'matchTitle', 'completeHint', 'author',
  'name', 'quote',
]);
const RO_MAX_PARAS = 12;

/** Best-effort readable extraction for `ro` rows: walk the block (settings
 *  excluded), collect known text fields, strip HTML, dedupe. */
function roExtract(b: Block): SbPara[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  const walk = (node: unknown, key: string | null): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      if (!key || !RO_TEXT_KEYS.has(key)) return;
      const text = htmlToText(node);
      if (text && !seen.has(text)) {
        seen.add(text);
        texts.push(text);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v, key);
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === 'settings') continue;
        walk(v, k);
      }
    }
  };
  walk({ ...b, settings: undefined }, null);
  const paras = texts.slice(0, RO_MAX_PARAS).map((t) => ({ runs: [{ text: t }] }));
  if (texts.length > RO_MAX_PARAS) {
    paras.push(italicPara(`… (+${texts.length - RO_MAX_PARAS} text fields omitted)`));
  }
  return paras;
}

// ------------------------------------------------------------------ labels ---

const LABELS: Record<string, string> = {
  'text': 'Text',
  'impact/note': 'Note',
  'impact': 'Impact',
  'list': 'List',
  'interactive/accordion': 'Accordion',
  'interactive/tabs': 'Tabs',
  'flashcard': 'Flashcards',
  'interactive-fullscreen/process': 'Process',
  'interactive-fullscreen/timeline': 'Timeline',
  'interactive-fullscreen/sorting': 'Sorting',
  'interactive-fullscreen/scenario': 'Scenario',
  'interactive-fullscreen/labeledgraphic': 'Labeled graphic',
  'knowledgeCheck/multiple choice': 'Knowledge check (single answer)',
  'knowledgeCheck/multiple response': 'Knowledge check (multiple answers)',
  'knowledgeCheck/matching': 'Knowledge check (matching)',
  'knowledgeCheck/fillin': 'Knowledge check (fill in)',
  'knowledgeCheck/draw from question bank': 'Draw from question bank',
  'knowledgeCheck': 'Knowledge check',
  'buttons': 'Buttons',
  'continue': 'Continue button',
  'divider': 'Divider',
  'image': 'Image',
  'gallery': 'Gallery',
  'mondrian': 'Collage',
  'multimedia/video': 'Video',
  'multimedia/audio': 'Audio',
  'multimedia/attachment': 'Attachment',
  'multimedia/embed': 'Embed',
  'multimedia/code': 'Code',
  'multimedia': 'Multimedia',
  'chart': 'Chart',
  'html': 'HTML block',
  '360': 'Storyline',
  'quote': 'Quote',
  'knowledge': 'Knowledge',
};

function labelFor(family: string, variant: string): string {
  return LABELS[`${family}/${variant}`] ?? LABELS[family] ?? `${family}/${variant}`;
}

const CHIP_KIND: Record<string, string> = {
  'media-image': 'image',
  'media-video': 'video',
  'media-audio': 'audio',
  'media-other': 'other',
};

/** `⟦…⟧` is reserved for machine tokens — escape it out of content. */
function escapeTokens(paras: SbPara[], flags: string[], where: string): void {
  for (const p of paras) {
    for (const r of p.runs) {
      if (r.text.includes('⟦') || r.text.includes('⟧')) {
        r.text = r.text.replace(/⟦/g, '〔').replace(/⟧/g, '〕');
        flags.push(`Reserved token brackets ⟦⟧ found in content (replaced with 〔〕): ${where}`);
      }
    }
  }
}

// ---------------------------------------------------------- image + prose ---

function extractPrimaryImage(b: Block): SbImage | undefined {
  const items = arr(b.items);
  for (const it of items) {
    const media = it.media as Record<string, unknown> | undefined;
    if (!media) continue;
    const img = media.image as Record<string, unknown> | undefined;
    if (!img) continue;
    const key = str(img.key);
    if (!key || key.startsWith('assets/rise/')) continue;
    const dims = img.dimensions as Record<string, unknown> | undefined;
    return {
      key,
      width: typeof dims?.originalWidth === 'number' ? dims.originalWidth : undefined,
      height: typeof dims?.originalHeight === 'number' ? dims.originalHeight : undefined,
    };
  }
  // Flashcard: check front/back
  for (const it of items) {
    for (const side of ['front', 'back'] as const) {
      const s = it[side] as Record<string, unknown> | undefined;
      if (!s) continue;
      const media = s.media as Record<string, unknown> | undefined;
      const img = media?.image as Record<string, unknown> | undefined;
      if (!img) continue;
      const key = str(img.key);
      if (!key || key.startsWith('assets/rise/')) continue;
      const dims = img.dimensions as Record<string, unknown> | undefined;
      return {
        key,
        width: typeof dims?.originalWidth === 'number' ? dims.originalWidth : undefined,
        height: typeof dims?.originalHeight === 'number' ? dims.originalHeight : undefined,
      };
    }
  }
  return undefined;
}

type ProseHint = 'impact' | 'continue' | 'divider';

function proseHintFor(family: string, _variant: string): ProseHint | undefined {
  if (family === 'impact') return 'impact';
  if (family === 'continue') return 'continue';
  if (family === 'divider') return 'divider';
  return undefined;
}

// ------------------------------------------------------------------ render ---

function renderBlock(b: Block, no: number, roOnly: boolean, flags: string[]): SbRow {
  const family = str(b.family) || '(no family)';
  const variant = str(b.variant) || '(no variant)';
  const blockId = str(b.id) || '(no id)';
  const notes: string[] = [];

  const renderer = roOnly ? undefined : (EDIT[`${family}/${variant}`] ?? EDIT[family]);
  let fidelity: 'edit' | 'ro' = renderer ? 'edit' : 'ro';
  let content: SbPara[] | null = null;

  if (renderer) {
    content = renderer(b);
    if (content === null) {
      fidelity = 'ro';
      notes.push('Unexpected block shape — rendered read-only.');
    }
  }
  if (content === null) content = roExtract(b);
  if (fidelity === 'ro' && !roOnly && !renderer && !(family in LABELS) && !(`${family}/${variant}` in LABELS)) {
    notes.push('Unknown block family — rendered read-only.');
  }

  // Media chips: every uploaded key referenced by this block, fingerprinted.
  for (const asset of collectAssetKeys(b)) {
    const kind = CHIP_KIND[asset.kind] ?? asset.kind;
    notes.push(`⟦media:${kind} #${fnv1a8(asset.key).slice(0, 6)}⟧`);
  }

  // The block id itself would collide with the reserved token brackets only
  // via content text — never via ids — but content can say anything.
  escapeTokens(content, flags, `block ${blockId}`);

  const image = extractPrimaryImage(b);
  const prose = proseHintFor(family, variant);
  // Flashcards additionally carry structured front/back pairs — the prose
  // writer renders one card per 2-column table row instead of `content`.
  const cards =
    fidelity === 'edit' && `${family}/${variant}` === 'flashcard/flashcard'
      ? extractFlashcards(b)
      : undefined;
  if (cards) {
    for (const card of cards) {
      escapeTokens(card.front, flags, `block ${blockId}`);
      escapeTokens(card.back, flags, `block ${blockId}`);
    }
  }

  return {
    no,
    blockId,
    family,
    variant,
    label: labelFor(family, variant),
    fidelity,
    content,
    notes,
    rev: fnv1a8(JSON.stringify(b)),
    ...(image ? { image } : {}),
    ...(prose ? { prose } : {}),
    ...(cards ? { cards } : {}),
  };
}

function lessonTitle(l: Lesson): string {
  return typeof l.title === 'string' && l.title !== '' ? l.title : '(untitled)';
}

/**
 * Render an archived course document into the SBDOC model.
 * A multi-language stack is materialized in its DEFAULT locale (fallback
 * locale→default→any) and flagged — an SBDOC carries one language.
 */
export function renderCourseModel(
  raw: GetCourseDocument,
  opts: RenderModelOptions,
): SbCourse {
  const flags: string[] = [];
  let doc = raw;
  let locale: string | null = null;

  if (isLocalizedStack(raw)) {
    const m = materializeLocale(raw);
    doc = m.doc;
    locale = m.locale || '(unknown)';
    flags.push(
      `Multi-language course — only the default language (${locale}) is shown; ` +
        `other languages are NOT visible here and will not be affected.`,
    );
    if (m.unresolved.length > 0) {
      flags.push(`${m.unresolved.length} translation cell(s) could not be resolved in any language.`);
    }
  }

  const title =
    typeof doc.course?.title === 'string' && doc.course.title !== ''
      ? doc.course.title
      : resolveStackTitle(raw) || '(untitled)';
  const courseId = str(doc.course?.id) || '(no id)';
  // The cover "intro" text — author-entered rich HTML on the course object
  // (a stack's ref is already materialized into `doc`).
  const description = htmlToParas(str(doc.course?.description));
  escapeTokens(description, flags, 'course description');

  const lessons: SbLesson[] = [];
  let blockCount = 0;
  // Display order = the course object's ordered lesson-id list, NOT the raw
  // lessons array (roughly creation order) and NOT `position` (capture-proven
  // to scramble a real course) — same rule as the import plan / parity verifier.
  const source = orderLessons(
    Array.isArray(doc.lessons) ? doc.lessons : [],
    (doc.course as Record<string, unknown> | undefined)?.lessons,
  );
  for (let i = 0; i < source.length; i++) {
    const l = source[i]!;
    const type = str(l.type) || '(no type)';
    const base: SbLesson = {
      id: str(l.id) || `(no id #${i})`,
      no: i + 1,
      title: lessonTitle(l),
      type,
      rows: [],
    };
    // Author-entered lesson description (rich HTML; captured on quiz lessons
    // too) — rendered under the lesson heading.
    const lessonDesc = htmlToParas(str(l.description));
    if (lessonDesc.length > 0) {
      escapeTokens(lessonDesc, flags, `lesson ${base.id} description`);
      base.description = lessonDesc;
    }
    if (type === 'section') {
      lessons.push({ ...base, note: 'Section header — no content.' });
      continue;
    }
    const roOnly = type !== 'blocks';
    if (roOnly) {
      base.note = `Lesson type “${type}” — rendered read-only.`;
    }
    const items = Array.isArray(l.items) ? (l.items as Block[]) : [];
    base.rows = items.map((b, j) => renderBlock(b, j + 1, roOnly, flags));
    blockCount += base.rows.length;
    lessons.push(base);
  }

  return {
    courseId,
    title,
    ...(description.length > 0 ? { description } : {}),
    generatedAt: opts.generatedAt,
    toolVersion: opts.toolVersion,
    locale,
    lessons,
    flags,
    blockCount,
  };
}
