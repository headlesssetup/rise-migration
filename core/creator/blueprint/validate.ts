// Strict runtime validation for PASTED Course Blueprint JSON (the chat-AI
// flow, docs/creator-ai-design.md). Closed-schema posture: unknown fields and
// unsupported block intents FAIL validation — the operator pastes the error
// report back into the chat instead of us guessing. Style mirrors
// core/local-archive/validate.ts: accumulate issues with dotted paths, never
// throw; `ready` = no error-severity issues.

import {
  COURSE_BLUEPRINT_FORMAT,
  COURSE_BLUEPRINT_VERSION,
  type BlockIntentKind,
  type CourseBlueprint,
} from './types';

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
    | 'origin'
    | 'assets';
  path: string;
  message: string;
}

export interface BlueprintValidation {
  blueprint: CourseBlueprint | null;
  issues: BlueprintIssue[];
  /** True when no error-severity issues remain — the compile gate. */
  ready: boolean;
}

const KNOWN_KINDS: readonly BlockIntentKind[] = [
  'text',
  'list',
  'accordion',
  'tabs',
  'flashcards',
  'process',
  'timeline',
  'sorting',
  'knowledge-check',
  'note',
  'links',
  'video-placeholder',
  'storyline-placeholder',
  'continue',
  'attachment-placeholder',
];

/** Inline/paragraph HTML the blueprint may carry (matches what the prompt
 *  allows and what the donor text slots have been fed so far). */
const ALLOWED_TAGS = new Set(['p', 'strong', 'em', 'b', 'i', 'a', 'ul', 'ol', 'li', 'br']);

function issue(
  issues: BlueprintIssue[],
  severity: BlueprintIssue['severity'],
  code: BlueprintIssue['code'],
  path: string,
  message: string,
): void {
  issues.push({ severity, code, path, message });
}

function object(value: unknown): Record<string, unknown> | null {
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

function str(
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

function strArray(
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

function noUnknownKeys(
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

function checkSourceRef(issues: BlueprintIssue[], path: string, value: unknown, required: boolean): void {
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

function checkIntent(issues: BlueprintIssue[], path: string, value: unknown): void {
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
    case 'storyline-placeholder':
    case 'continue':
    case 'attachment-placeholder':
      noUnknownKeys(issues, path, intent, ['kind', 'label']);
      str(issues, `${path}.label`, intent.label, { required: true, nonEmpty: true });
      break;
  }
}

/** True when the text ends inside an unclosed JSON structure or string —
 *  the signature of a chat that stopped emitting mid-document. */
function looksTruncated(raw: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of raw) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return inString || depth > 0;
}

/** Validate pasted text as a Course Blueprint. Never throws. */
export function validateBlueprint(text: string): BlueprintValidation {
  const issues: BlueprintIssue[] = [];
  const raw = unwrapPastedJson(text);
  if (raw === '') {
    issue(issues, 'error', 'json', 'blueprint', 'Nothing to parse — paste the JSON the AI returned.');
    return { blueprint: null, issues, ready: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    issue(issues, 'error', 'json', 'blueprint', `Invalid JSON: ${String(e)}`);
    if (looksTruncated(raw)) {
      issue(
        issues,
        'error',
        'truncated',
        'blueprint',
        'The JSON ends unexpectedly — the chat likely truncated its output. Ask the AI to re-emit the FULL JSON in one block.',
      );
    }
    return { blueprint: null, issues, ready: false };
  }

  const root = object(parsed);
  if (!root) {
    issue(issues, 'error', 'shape', 'blueprint', 'The blueprint must be a JSON object.');
    return { blueprint: null, issues, ready: false };
  }
  if (root.format !== COURSE_BLUEPRINT_FORMAT || root.formatVersion !== COURSE_BLUEPRINT_VERSION) {
    issue(
      issues,
      'error',
      'format',
      'blueprint.format',
      `Expected format "${COURSE_BLUEPRINT_FORMAT}" formatVersion ${COURSE_BLUEPRINT_VERSION}.`,
    );
    return { blueprint: null, issues, ready: false };
  }

  noUnknownKeys(issues, 'blueprint', root, [
    'format',
    'formatVersion',
    'source',
    'title',
    'lessons',
    'assets',
    'unresolved',
    'production',
  ]);

  const source = object(root.source);
  if (!source) {
    issue(issues, 'error', 'shape', 'blueprint.source', 'source must be an object {kind, originalFileName?, provider?, model?}.');
  } else {
    noUnknownKeys(issues, 'blueprint.source', source, ['kind', 'originalFileName', 'provider', 'model']);
    if (source.kind !== 'ai-provider' && source.kind !== 'intea-storyboard') {
      issue(issues, 'error', 'shape', 'blueprint.source.kind', 'source.kind must be "ai-provider".');
    }
    for (const key of ['originalFileName', 'provider', 'model'] as const) {
      if (source[key] !== undefined) str(issues, `blueprint.source.${key}`, source[key]);
    }
  }

  str(issues, 'blueprint.title', root.title, { required: true, nonEmpty: true });

  if (!Array.isArray(root.lessons) || root.lessons.length === 0) {
    issue(issues, 'error', 'empty', 'blueprint.lessons', 'The course needs at least one lesson.');
  } else {
    root.lessons.forEach((lv, li) => {
      const lesson = object(lv);
      const lPath = `blueprint.lessons[${li}]`;
      if (!lesson) {
        issue(issues, 'error', 'shape', lPath, 'Lesson must be an object {title, blocks}.');
        return;
      }
      noUnknownKeys(issues, lPath, lesson, ['title', 'blocks']);
      str(issues, `${lPath}.title`, lesson.title, { required: true, nonEmpty: true });
      if (!Array.isArray(lesson.blocks) || lesson.blocks.length === 0) {
        issue(issues, 'error', 'empty', `${lPath}.blocks`, 'The lesson needs at least one block.');
        return;
      }
      lesson.blocks.forEach((bv, bi) => {
        const block = object(bv);
        const bPath = `${lPath}.blocks[${bi}]`;
        if (!block) {
          issue(issues, 'error', 'shape', bPath, 'Block must be an object {intent, sourceRef, notes?, origin?}.');
          return;
        }
        noUnknownKeys(issues, bPath, block, ['intent', 'sourceRef', 'notes', 'origin']);
        checkIntent(issues, `${bPath}.intent`, block.intent);
        checkSourceRef(issues, `${bPath}.sourceRef`, block.sourceRef, true);
        // notes is our bookkeeping — tolerate absence, normalize below.
        if (block.notes !== undefined) strArray(issues, `${bPath}.notes`, block.notes);
        if (block.origin !== undefined && block.origin !== 'source' && block.origin !== 'suggested') {
          issue(issues, 'error', 'origin', `${bPath}.origin`, 'origin must be "source" or "suggested".');
        }
      });
    });
  }

  if (!Array.isArray(root.assets)) {
    issue(issues, 'error', 'shape', 'blueprint.assets', 'assets must be an array (and empty: []).');
  } else if (root.assets.length > 0) {
    issue(
      issues,
      'error',
      'assets',
      'blueprint.assets',
      'Images/media cannot arrive via chat paste — assets must be []. Reference missing media as placeholder blocks and unresolved[] entries instead.',
    );
  }

  if (!Array.isArray(root.unresolved)) {
    issue(issues, 'error', 'shape', 'blueprint.unresolved', 'unresolved must be an array.');
  } else {
    root.unresolved.forEach((uv, i) => {
      const u = object(uv);
      const uPath = `blueprint.unresolved[${i}]`;
      if (!u) {
        issue(issues, 'error', 'shape', uPath, 'Must be an object {sourceRef, reason}.');
        return;
      }
      noUnknownKeys(issues, uPath, u, ['sourceRef', 'reason']);
      checkSourceRef(issues, `${uPath}.sourceRef`, u.sourceRef, true);
      str(issues, `${uPath}.reason`, u.reason, { required: true, nonEmpty: true });
    });
  }

  if (!Array.isArray(root.production)) {
    issue(issues, 'error', 'shape', 'blueprint.production', 'production must be an array.');
  } else {
    root.production.forEach((pv, i) => {
      const p = object(pv);
      const pPath = `blueprint.production[${i}]`;
      if (!p) {
        issue(issues, 'error', 'shape', pPath, 'Must be an object {kind:"narration", lesson, sourceRef, text}.');
        return;
      }
      noUnknownKeys(issues, pPath, p, ['kind', 'lesson', 'sourceRef', 'text']);
      if (p.kind !== 'narration') {
        issue(issues, 'error', 'shape', `${pPath}.kind`, 'production kind must be "narration".');
      }
      str(issues, `${pPath}.lesson`, p.lesson, { required: true, nonEmpty: true });
      checkSourceRef(issues, `${pPath}.sourceRef`, p.sourceRef, true);
      str(issues, `${pPath}.text`, p.text, { required: true, nonEmpty: true });
    });
  }

  const ready = !issues.some((i) => i.severity === 'error');
  if (!ready) return { blueprint: null, issues, ready };

  // Normalize the tolerated absences so downstream code sees the full shape.
  const blueprint = parsed as CourseBlueprint;
  for (const lesson of blueprint.lessons) {
    for (const block of lesson.blocks) {
      block.notes ??= [];
    }
  }
  return { blueprint, issues, ready };
}

/** Human-readable failure report the operator pastes back into the AI chat. */
export function blueprintErrorReport(issues: BlueprintIssue[]): string {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const lines = [
    `The JSON failed validation against the ${COURSE_BLUEPRINT_FORMAT} v${COURSE_BLUEPRINT_VERSION} schema.`,
    'Fix the issues below and re-emit the FULL corrected JSON in one fenced block:',
    '',
    ...errors.map((i) => `- ${i.path}: ${i.message}`),
  ];
  if (warnings.length > 0) {
    lines.push('', 'Warnings (fix if possible):', ...warnings.map((i) => `- ${i.path}: ${i.message}`));
  }
  return lines.join('\n');
}
