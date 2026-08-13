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
import { isLocalizedStack, materializeLocale, resolveStackTitle } from '@/core/l10n';
import type { Block, GetCourseDocument, Lesson } from '@/shared/types/rise';
import { htmlToParas, htmlToText } from './html';
import { fnv1a8, type SbCourse, type SbLesson, type SbPara, type SbRow, type SbRun } from './model';

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
    out.push(...boldFromHtml(str(it.heading)));
    out.push(...htmlToParas(str(it.paragraph)));
  }
  return out.length > 0 ? out : null;
}

function renderList(b: Block): SbPara[] | null {
  const kind = b.variant === 'numbered' ? 'number' : 'bullet';
  const out: SbPara[] = [];
  for (const it of arr(b.items)) {
    for (const p of htmlToParas(str(it.paragraph))) {
      out.push({ ...p, list: p.list ?? kind });
    }
  }
  return out.length > 0 ? out : null;
}

function renderItemsTitled(b: Block): SbPara[] | null {
  const out: SbPara[] = [];
  for (const it of arr(b.items)) {
    const title = htmlToText(str(it.title));
    if (title) out.push(boldPara(title));
    out.push(...htmlToParas(str(it.description)));
  }
  return out.length > 0 ? out : null;
}

function renderFlashcards(b: Block): SbPara[] | null {
  const side = (v: unknown): { html: string; media: boolean } => {
    const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    return { html: str(o.description), media: !!o.media };
  };
  const out: SbPara[] = [];
  for (const it of arr(b.items)) {
    const front = side(it.front);
    const back = side(it.back);
    const frontText = htmlToText(front.html);
    out.push(boldPara(frontText || (front.media ? '(media)' : '')));
    const backParas = htmlToParas(back.html);
    if (backParas.length > 0) out.push(...backParas);
    else if (back.media) out.push({ runs: [{ text: '(media)' }] });
  }
  return out.some((p) => p.runs.some((r) => r.text.trim() !== '')) ? out : null;
}

function renderProcess(b: Block): SbPara[] | null {
  const out: SbPara[] = [];
  for (const it of arr(b.items)) {
    const title = htmlToText(str(it.title));
    if (it.type === 'intro') {
      if (title) out.push(boldPara(title));
      out.push(...htmlToParas(str(it.description)));
    } else {
      out.push(boldPara(title || '(no title)'));
      out.push(...htmlToParas(str(it.description)));
    }
  }
  return out.length > 0 ? out : null;
}

function renderTimeline(b: Block): SbPara[] | null {
  const out: SbPara[] = [];
  for (const it of arr(b.items)) {
    const date = htmlToText(str(it.date));
    const title = htmlToText(str(it.title));
    out.push(boldPara(`${date}: ${title}`));
    out.push(...htmlToParas(str(it.description)));
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
        out.push({ runs: [{ text: htmlToText(str(card.title)) }], list: 'bullet' });
      }
    }
  }
  return out;
}

function renderKc(b: Block): SbPara[] | null {
  const out: SbPara[] = [];
  for (const q of arr(b.items)) {
    out.push(...boldFromHtml(str(q.title) || '(no question)'));
    for (const a of arr(q.answers)) {
      const runs: SbRun[] = htmlToParas(str(a.title)).flatMap((p) => p.runs);
      const text = runs.map((r) => r.text).join('') || '(empty answer)';
      out.push({
        runs: [{ text, ...(a.correct === true ? { color: GREEN_CORRECT } : {}) }],
        list: 'bullet',
      });
      const perAnswer = htmlToText(str(a.feedback));
      if (perAnswer) out.push(italicPara(`↳ ${perAnswer}`));
    }
    const feedback = htmlToText(str(q.feedback));
    if (feedback) out.push(italicPara(`Feedback: ${feedback}`));
  }
  return out.length > 0 ? out : null;
}

function renderMatching(b: Block): SbPara[] | null {
  const out: SbPara[] = [];
  for (const q of arr(b.items)) {
    const stem = htmlToText(str(q.title));
    if (stem) out.push(boldPara(stem));
    for (const a of arr(q.answers)) {
      out.push({
        runs: [{ text: `${htmlToText(str(a.title))} ⇄ ${htmlToText(str(a.matchTitle))}` }],
        list: 'bullet',
      });
    }
  }
  return out.length > 0 ? out : null;
}

function renderButtons(b: Block): SbPara[] | null {
  const out: SbPara[] = [];
  for (const it of arr(b.items)) {
    const label = htmlToText(str(it.label)) || htmlToText(str(it.title));
    const destination = str(it.destination) || str(it.url);
    if (!label) continue;
    out.push({
      runs: [{ text: `[${label}]`, ...(destination ? { link: destination } : {}) }],
    });
    const description = htmlToText(str(it.description));
    if (description) out.push({ runs: [{ text: description }] });
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

  const lessons: SbLesson[] = [];
  let blockCount = 0;
  const source = Array.isArray(doc.lessons) ? doc.lessons : [];
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
    generatedAt: opts.generatedAt,
    toolVersion: opts.toolVersion,
    locale,
    lessons,
    flags,
    blockCount,
  };
}
