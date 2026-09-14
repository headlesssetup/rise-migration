// Per-intent + shared field checks of the Course Blueprint validator (split
// out of validate.ts at v0.9.12 — validate.ts stays the public door and the
// only importer of this module). Closed-schema posture throughout: unknown
// fields and kinds fail; see validate.ts for the document-level pass.

import type { BlockIntentKind, CourseBlueprint } from './types';

export interface BlueprintIssue {
  severity: 'error' | 'warning';
  code:
    | 'json'
    | 'truncated'
    | 'format'
    | 'shape'
    | 'unknown-field'
    | 'unknown-kind'
    | 'empty'
    | 'html'
    | 'kc'
    | 'sorting'
    | 'table'
    | 'origin'
    | 'assets'
    | 'style';
  path: string;
  message: string;
}

export interface BlueprintValidation {
  blueprint: CourseBlueprint | null;
  issues: BlueprintIssue[];
  /** True when no error-severity issues remain — the compile gate. */
  ready: boolean;
}

export const KNOWN_KINDS: readonly BlockIntentKind[] = [
  'text',
  'list',
  'accordion',
  'tabs',
  'flashcards',
  'process',
  'timeline',
  'sorting',
  'knowledge-check',
  'fill-in-the-blank',
  'matching',
  'table',
  'labeled-graphic',
  'note',
  'links',
  'video-placeholder',
  'storyline-placeholder',
  'continue',
  'attachment-placeholder',
  'quote',
  'banner',
];

export const BANDS = ['white', 'light', 'accent'] as const;
export const LESSON_ICONS = ['Article', 'Quiz', 'Video', 'Interaction'] as const;
/** Asset-folder file names: a plain base name, no path separators. */
const FILE_NAME = /^[^/\\]+\.[A-Za-z0-9]{1,5}$/;

/** Inline/paragraph HTML the blueprint may carry (matches what the prompt
 *  allows and what the donor text slots have been fed so far). */
const ALLOWED_TAGS = new Set(['p', 'strong', 'em', 'b', 'i', 'a', 'ul', 'ol', 'li', 'br']);

export function issue(
  issues: BlueprintIssue[],
  severity: BlueprintIssue['severity'],
  code: BlueprintIssue['code'],
  path: string,
  message: string,
): void {
  issues.push({ severity, code, path, message });
}

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Strip chat noise around the JSON: a ```json fence, or leading/trailing
 *  prose outside the outermost braces. Returns the best JSON candidate. */
export function unwrapPastedJson(text: string): string {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) return fence[1].trim();
  // Unclosed fence (truncated paste): take everything after the opener.
  const openFence = /```(?:json)?\s*\n([\s\S]*)$/i.exec(trimmed);
  if (openFence?.[1] && !trimmed.startsWith('{')) return openFence[1].trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  if (first >= 0) return trimmed.slice(first); // `{` but no `}` — truncated paste
  return trimmed;
}

/** Fields whose values are rendered as HTML in Rise and in the preview. */
function checkHtml(issues: BlueprintIssue[], path: string, value: string): void {
  const tags = value.matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/g);
  for (const m of tags) {
    const tag = m[1]!.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      issue(issues, 'error', 'html', path, `HTML tag <${tag}> is not allowed (allowed: ${[...ALLOWED_TAGS].join(', ')}).`);
      return;
    }
  }
  if (/\son\w+\s*=/i.test(value) || /javascript:/i.test(value)) {
    issue(issues, 'error', 'html', path, 'Inline event handlers and javascript: URLs are not allowed.');
  }
}

export function str(
  issues: BlueprintIssue[],
  path: string,
  value: unknown,
  opts: { required?: boolean; nonEmpty?: boolean; html?: boolean } = {},
): value is string {
  if (value === undefined) {
    if (opts.required) issue(issues, 'error', 'shape', path, 'Required string is missing.');
    return false;
  }
  if (typeof value !== 'string') {
    issue(issues, 'error', 'shape', path, 'Must be a string.');
    return false;
  }
  if (opts.nonEmpty && value.trim() === '') {
    issue(issues, 'error', 'empty', path, 'Must not be empty.');
    return false;
  }
  if (opts.html) checkHtml(issues, path, value);
  return true;
}

export function strArray(
  issues: BlueprintIssue[],
  path: string,
  value: unknown,
  opts: { required?: boolean; nonEmpty?: boolean; html?: boolean } = {},
): boolean {
  if (value === undefined) {
    if (opts.required) issue(issues, 'error', 'shape', path, 'Required array of strings is missing.');
    return false;
  }
  if (!Array.isArray(value)) {
    issue(issues, 'error', 'shape', path, 'Must be an array of strings.');
    return false;
  }
  if (opts.nonEmpty && value.length === 0) {
    issue(issues, 'error', 'empty', path, 'Must not be empty.');
    return false;
  }
  value.forEach((v, i) => str(issues, `${path}[${i}]`, v, { html: opts.html }));
  return true;
}

export function noUnknownKeys(
  issues: BlueprintIssue[],
  path: string,
  row: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(row)) {
    if (!allowed.includes(key)) {
      issue(issues, 'error', 'unknown-field', `${path}.${key}`, `Unknown field "${key}" — the schema is closed.`);
    }
  }
}

export function checkSourceRef(issues: BlueprintIssue[], path: string, value: unknown, required: boolean): void {
  const ref = object(value);
  if (!ref) {
    if (required || value !== undefined) {
      issue(issues, 'error', 'shape', path, 'sourceRef must be an object {label, slideNo?, row?, excerpt?}.');
    }
    return;
  }
  noUnknownKeys(issues, path, ref, ['label', 'slideNo', 'row', 'excerpt']);
  str(issues, `${path}.label`, ref.label, { required: true, nonEmpty: true });
  if (ref.slideNo !== undefined && ref.slideNo !== null && typeof ref.slideNo !== 'number') {
    issue(issues, 'error', 'shape', `${path}.slideNo`, 'Must be a number or null.');
  }
  if (ref.row !== undefined && typeof ref.row !== 'number') {
    issue(issues, 'error', 'shape', `${path}.row`, 'Must be a number.');
  }
  if (ref.excerpt !== undefined) str(issues, `${path}.excerpt`, ref.excerpt);
}

function checkItems(issues: BlueprintIssue[], path: string, value: unknown): void {
  if (!Array.isArray(value)) {
    issue(issues, 'error', 'shape', path, 'Must be an array of {title, body} items.');
    return;
  }
  if (value.length === 0) {
    issue(issues, 'error', 'empty', path, 'Needs at least one item.');
    return;
  }
  value.forEach((v, i) => {
    const item = object(v);
    if (!item) {
      issue(issues, 'error', 'shape', `${path}[${i}]`, 'Item must be an object {title, body}.');
      return;
    }
    noUnknownKeys(issues, `${path}[${i}]`, item, ['title', 'body']);
    str(issues, `${path}[${i}].title`, item.title, { required: true, nonEmpty: true });
    str(issues, `${path}[${i}].body`, item.body, { required: true, html: true });
  });
}

export function checkIntent(issues: BlueprintIssue[], path: string, value: unknown): void {
  const intent = object(value);
  if (!intent) {
    issue(issues, 'error', 'shape', path, 'intent must be an object with a "kind".');
    return;
  }
  const kind = intent.kind;
  if (typeof kind !== 'string' || !(KNOWN_KINDS as readonly string[]).includes(kind)) {
    issue(
      issues,
      'error',
      'unknown-kind',
      `${path}.kind`,
      `Unsupported block kind ${JSON.stringify(kind)}. Supported: ${KNOWN_KINDS.join(', ')}.`,
    );
    return;
  }

  const common = ['kind', 'heading', 'intro'];
  if (intent.heading !== undefined) str(issues, `${path}.heading`, intent.heading);

  switch (kind as BlockIntentKind) {
    case 'text':
      noUnknownKeys(issues, path, intent, ['kind', 'heading', 'paragraphs']);
      strArray(issues, `${path}.paragraphs`, intent.paragraphs, { required: true, nonEmpty: true, html: true });
      break;
    case 'list':
      noUnknownKeys(issues, path, intent, [...common, 'ordered', 'items', 'outro']);
      if (typeof intent.ordered !== 'boolean') {
        issue(issues, 'error', 'shape', `${path}.ordered`, 'Must be true (numbered) or false (bulleted).');
      }
      strArray(issues, `${path}.intro`, intent.intro, { required: true, html: true });
      strArray(issues, `${path}.items`, intent.items, { required: true, nonEmpty: true, html: true });
      if (intent.outro !== undefined) strArray(issues, `${path}.outro`, intent.outro, { html: true });
      break;
    case 'accordion':
    case 'tabs':
    case 'flashcards':
    case 'process':
    case 'labeled-graphic':
      noUnknownKeys(issues, path, intent, [...common, 'items']);
      strArray(issues, `${path}.intro`, intent.intro, { required: true, html: true });
      checkItems(issues, `${path}.items`, intent.items);
      break;
    case 'timeline': {
      noUnknownKeys(issues, path, intent, [...common, 'events']);
      strArray(issues, `${path}.intro`, intent.intro, { required: true, html: true });
      if (!Array.isArray(intent.events) || intent.events.length === 0) {
        issue(issues, 'error', 'empty', `${path}.events`, 'Needs at least one {date, title, body} event.');
        break;
      }
      intent.events.forEach((v, i) => {
        const e = object(v);
        if (!e) {
          issue(issues, 'error', 'shape', `${path}.events[${i}]`, 'Event must be an object {date, title, body}.');
          return;
        }
        noUnknownKeys(issues, `${path}.events[${i}]`, e, ['date', 'title', 'body']);
        str(issues, `${path}.events[${i}].date`, e.date, { required: true, nonEmpty: true });
        str(issues, `${path}.events[${i}].title`, e.title, { required: true, nonEmpty: true });
        str(issues, `${path}.events[${i}].body`, e.body, { required: true, html: true });
      });
      break;
    }
    case 'sorting': {
      noUnknownKeys(issues, path, intent, [...common, 'piles', 'cards']);
      strArray(issues, `${path}.intro`, intent.intro, { required: true, html: true });
      const pilesOk = strArray(issues, `${path}.piles`, intent.piles, { required: true, nonEmpty: true });
      const pileCount = pilesOk ? (intent.piles as string[]).length : 0;
      if (!Array.isArray(intent.cards) || intent.cards.length === 0) {
        issue(issues, 'error', 'empty', `${path}.cards`, 'Needs at least one {title, pile} card.');
        break;
      }
      intent.cards.forEach((v, i) => {
        const c = object(v);
        if (!c) {
          issue(issues, 'error', 'shape', `${path}.cards[${i}]`, 'Card must be an object {title, pile}.');
          return;
        }
        noUnknownKeys(issues, `${path}.cards[${i}]`, c, ['title', 'pile']);
        str(issues, `${path}.cards[${i}].title`, c.title, { required: true, nonEmpty: true });
        if (
          typeof c.pile !== 'number' ||
          !Number.isInteger(c.pile) ||
          (pileCount > 0 && (c.pile < 1 || c.pile > pileCount))
        ) {
          issue(
            issues,
            'error',
            'sorting',
            `${path}.cards[${i}].pile`,
            `pile must be a 1-based integer index into piles (1..${pileCount || '?'}).`,
          );
        }
      });
      break;
    }
    case 'knowledge-check': {
      noUnknownKeys(issues, path, intent, [...common, 'questions']);
      strArray(issues, `${path}.intro`, intent.intro, { required: true, html: true });
      if (!Array.isArray(intent.questions) || intent.questions.length === 0) {
        issue(issues, 'error', 'empty', `${path}.questions`, 'Needs at least one question.');
        break;
      }
      intent.questions.forEach((v, i) => {
        const q = object(v);
        const qPath = `${path}.questions[${i}]`;
        if (!q) {
          issue(issues, 'error', 'shape', qPath, 'Question must be an object {stem, options, feedback?}.');
          return;
        }
        noUnknownKeys(issues, qPath, q, ['stem', 'options', 'feedback']);
        str(issues, `${qPath}.stem`, q.stem, { required: true, nonEmpty: true, html: true });
        if (q.feedback !== undefined) str(issues, `${qPath}.feedback`, q.feedback, { html: true });
        if (!Array.isArray(q.options) || q.options.length < 2) {
          issue(issues, 'error', 'kc', `${qPath}.options`, 'A knowledge check needs at least two options.');
          return;
        }
        let correct = 0;
        q.options.forEach((ov, j) => {
          const o = object(ov);
          const oPath = `${qPath}.options[${j}]`;
          if (!o) {
            issue(issues, 'error', 'shape', oPath, 'Option must be an object {text, correct, feedback?}.');
            return;
          }
          noUnknownKeys(issues, oPath, o, ['text', 'correct', 'feedback']);
          str(issues, `${oPath}.text`, o.text, { required: true, nonEmpty: true });
          if (typeof o.correct !== 'boolean') {
            issue(issues, 'error', 'kc', `${oPath}.correct`, 'Must be true or false.');
          } else if (o.correct) correct++;
          if (o.feedback !== undefined) str(issues, `${oPath}.feedback`, o.feedback, { html: true });
        });
        if (correct === 0) {
          issue(
            issues,
            'error',
            'kc',
            `${qPath}.options`,
            'No option is marked correct. If the source does not evidence a correct answer, move this question to unresolved[] instead.',
          );
        }
      });
      break;
    }
    case 'fill-in-the-blank': {
      noUnknownKeys(issues, path, intent, [...common, 'questions']);
      strArray(issues, `${path}.intro`, intent.intro, { required: true, html: true });
      if (!Array.isArray(intent.questions) || intent.questions.length === 0) {
        issue(issues, 'error', 'empty', `${path}.questions`, 'Needs at least one {stem, answers, feedback?} question.');
        break;
      }
      intent.questions.forEach((v, i) => {
        const q = object(v);
        const qPath = `${path}.questions[${i}]`;
        if (!q) {
          issue(issues, 'error', 'shape', qPath, 'Question must be an object {stem, answers, feedback?}.');
          return;
        }
        noUnknownKeys(issues, qPath, q, ['stem', 'answers', 'feedback']);
        str(issues, `${qPath}.stem`, q.stem, { required: true, nonEmpty: true, html: true });
        if (q.feedback !== undefined) str(issues, `${qPath}.feedback`, q.feedback, { html: true });
        const ok = strArray(issues, `${qPath}.answers`, q.answers, { required: true, nonEmpty: true });
        if (ok && (q.answers as unknown[]).some((a) => typeof a === 'string' && a.trim() === '')) {
          issue(issues, 'error', 'kc', `${qPath}.answers`, 'Accepted answers must not be empty strings. If the source does not evidence the answer, move the question to unresolved[] instead.');
        }
      });
      break;
    }
    case 'matching': {
      noUnknownKeys(issues, path, intent, [...common, 'stem', 'pairs', 'feedback']);
      strArray(issues, `${path}.intro`, intent.intro, { required: true, html: true });
      str(issues, `${path}.stem`, intent.stem, { required: true, nonEmpty: true, html: true });
      if (intent.feedback !== undefined) str(issues, `${path}.feedback`, intent.feedback, { html: true });
      if (!Array.isArray(intent.pairs) || intent.pairs.length < 2) {
        issue(issues, 'error', 'kc', `${path}.pairs`, 'A matching activity needs at least two {left, right} pairs.');
        break;
      }
      intent.pairs.forEach((v, i) => {
        const pair = object(v);
        if (!pair) {
          issue(issues, 'error', 'shape', `${path}.pairs[${i}]`, 'Pair must be an object {left, right}.');
          return;
        }
        noUnknownKeys(issues, `${path}.pairs[${i}]`, pair, ['left', 'right']);
        str(issues, `${path}.pairs[${i}].left`, pair.left, { required: true, nonEmpty: true });
        str(issues, `${path}.pairs[${i}].right`, pair.right, { required: true, nonEmpty: true });
      });
      break;
    }
    case 'table': {
      noUnknownKeys(issues, path, intent, [...common, 'columns', 'rows']);
      strArray(issues, `${path}.intro`, intent.intro, { required: true, html: true });
      const colsOk = strArray(issues, `${path}.columns`, intent.columns, { required: true, nonEmpty: true, html: true });
      const width = colsOk ? (intent.columns as string[]).length : 0;
      if (!Array.isArray(intent.rows) || intent.rows.length === 0) {
        issue(issues, 'error', 'empty', `${path}.rows`, 'Needs at least one row (an array of cell strings).');
        break;
      }
      intent.rows.forEach((row, i) => {
        const rowOk = strArray(issues, `${path}.rows[${i}]`, row, { required: true, html: true });
        if (rowOk && width > 0 && (row as string[]).length !== width) {
          issue(
            issues,
            'error',
            'table',
            `${path}.rows[${i}]`,
            `Row has ${(row as string[]).length} cell(s) but the table has ${width} column(s) — every row must match; use "" for an empty cell.`,
          );
        }
      });
      break;
    }
    case 'note':
      noUnknownKeys(issues, path, intent, ['kind', 'paragraphs']);
      strArray(issues, `${path}.paragraphs`, intent.paragraphs, { required: true, nonEmpty: true, html: true });
      break;
    case 'links': {
      noUnknownKeys(issues, path, intent, [...common, 'buttons', 'trailing']);
      strArray(issues, `${path}.intro`, intent.intro, { required: true, html: true });
      if (!Array.isArray(intent.buttons) || intent.buttons.length === 0) {
        issue(issues, 'error', 'empty', `${path}.buttons`, 'Needs at least one {label, destination, description} button.');
        break;
      }
      intent.buttons.forEach((v, i) => {
        const b = object(v);
        if (!b) {
          issue(issues, 'error', 'shape', `${path}.buttons[${i}]`, 'Button must be an object {label, destination, description}.');
          return;
        }
        noUnknownKeys(issues, `${path}.buttons[${i}]`, b, ['label', 'destination', 'description']);
        str(issues, `${path}.buttons[${i}].label`, b.label, { required: true, nonEmpty: true });
        str(issues, `${path}.buttons[${i}].destination`, b.destination, { required: true, nonEmpty: true });
        str(issues, `${path}.buttons[${i}].description`, b.description, { required: true });
        if (typeof b.destination === 'string' && /^\s*javascript:/i.test(b.destination)) {
          issue(issues, 'error', 'html', `${path}.buttons[${i}].destination`, 'javascript: URLs are not allowed.');
        }
      });
      if (intent.trailing !== undefined) strArray(issues, `${path}.trailing`, intent.trailing, { html: true });
      break;
    }
    case 'video-placeholder':
      noUnknownKeys(issues, path, intent, ['kind', 'label', 'url']);
      str(issues, `${path}.label`, intent.label, { required: true, nonEmpty: true });
      if (intent.url !== undefined && str(issues, `${path}.url`, intent.url) && !/^https?:\/\//i.test(intent.url)) {
        issue(issues, 'error', 'shape', `${path}.url`, 'url must be an http(s) URL (YouTube).');
      }
      break;
    case 'attachment-placeholder':
      noUnknownKeys(issues, path, intent, ['kind', 'label', 'file']);
      str(issues, `${path}.label`, intent.label, { required: true, nonEmpty: true });
      if (intent.file !== undefined) checkFileName(issues, `${path}.file`, intent.file);
      break;
    case 'storyline-placeholder':
    case 'continue':
      noUnknownKeys(issues, path, intent, ['kind', 'label']);
      str(issues, `${path}.label`, intent.label, { required: true, nonEmpty: true });
      break;
    case 'quote':
      noUnknownKeys(issues, path, intent, ['kind', 'heading', 'text', 'attribution']);
      str(issues, `${path}.text`, intent.text, { required: true, nonEmpty: true, html: true });
      if (intent.attribution !== undefined) str(issues, `${path}.attribution`, intent.attribution);
      break;
    case 'banner':
      noUnknownKeys(issues, path, intent, ['kind', 'label', 'subtitle']);
      str(issues, `${path}.label`, intent.label, { required: true, nonEmpty: true });
      if (intent.subtitle !== undefined) str(issues, `${path}.subtitle`, intent.subtitle);
      break;
  }
}

export function checkFileName(issues: BlueprintIssue[], path: string, value: unknown): void {
  if (!str(issues, path, value, { nonEmpty: true })) return;
  if (!FILE_NAME.test(value)) {
    issue(issues, 'error', 'style', path, 'Must be a plain file name with an extension (as listed under "Available images"), no folders.');
  }
}

