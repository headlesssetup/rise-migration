// SBDOC — Rise rich-text HTML → SbPara runs.
//
// Rise block values are small HTML fragments (`<p>…</p>` paragraphs, inline
// <strong>/<em>/<a>, Mighty span classes). The storyboard docx represents ONLY
// text + bold/italic/link (format spec: everything else — font classes, colors,
// alignment — is not carried; a future merge must preserve it from the base
// archive). This is a lenient tokenizer, not a parser: unknown tags are
// unwrapped, never an error — a storyboard render must not fail on exotic
// markup that copy-faithful migration handles fine.

import { decodeEntities } from '../xml';
import type { SbPara, SbRun } from './model';

const BLOCK_TAGS = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'blockquote']);

/** Decode HTML entities (named subset + numeric) to plain text. */
function decode(s: string): string {
  return decodeEntities(s.replace(/&nbsp;/g, ' '));
}

function sameFormat(a: SbRun, b: SbRun): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.color === b.color && a.link === b.link;
}

function pushRun(runs: SbRun[], run: SbRun): void {
  if (run.text === '') return;
  const last = runs[runs.length - 1];
  if (last && sameFormat(last, run)) last.text += run.text;
  else runs.push(run);
}

/**
 * Convert a Rise HTML fragment to paragraphs of formatted runs.
 * `<li>` inside `<ol>` yields `list:'number'`, inside `<ul>` (or bare)
 * `list:'bullet'`. Whitespace-only paragraphs are dropped.
 */
export function htmlToParas(html: string): SbPara[] {
  const paras: SbPara[] = [];
  let runs: SbRun[] = [];
  let list: 'bullet' | 'number' | undefined;
  let bold = 0;
  let italic = 0;
  const links: string[] = [];
  const listStack: ('bullet' | 'number')[] = [];

  const flush = (): void => {
    if (runs.some((r) => r.text.trim() !== '')) {
      paras.push({ runs, ...(list ? { list } : {}) });
    }
    runs = [];
    list = undefined;
  };

  const emitText = (raw: string): void => {
    // Collapse HTML whitespace runs; keep leading/trailing spaces (coalescing
    // across runs needs them), drop pure-newline noise.
    const text = decode(raw).replace(/[\r\n\t]+/g, ' ');
    if (text === '') return;
    pushRun(runs, {
      text,
      ...(bold > 0 ? { bold: true } : {}),
      ...(italic > 0 ? { italic: true } : {}),
      ...(links.length > 0 ? { link: links[links.length - 1] } : {}),
    });
  };

  const re = /<[^>]*>|[^<]+/g;
  for (const token of html.match(re) ?? []) {
    if (!token.startsWith('<')) {
      emitText(token);
      continue;
    }
    const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(token);
    if (!m) continue; // comment / doctype noise — never content
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();

    if (tag === 'br') {
      // Line break inside a paragraph → keep as newline in the current run.
      pushRun(runs, { text: '\n', ...(bold > 0 ? { bold: true } : {}), ...(italic > 0 ? { italic: true } : {}) });
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      if (closing) listStack.pop();
      else listStack.push(tag === 'ol' ? 'number' : 'bullet');
      continue;
    }
    if (BLOCK_TAGS.has(tag)) {
      flush();
      if (!closing && tag === 'li') list = listStack[listStack.length - 1] ?? 'bullet';
      continue;
    }
    if (tag === 'strong' || tag === 'b') {
      bold += closing ? -1 : 1;
      if (bold < 0) bold = 0;
      continue;
    }
    if (tag === 'em' || tag === 'i') {
      italic += closing ? -1 : 1;
      if (italic < 0) italic = 0;
      continue;
    }
    if (tag === 'a') {
      if (closing) links.pop();
      else {
        const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(token);
        links.push(decode(href?.[2] ?? href?.[3] ?? ''));
      }
      continue;
    }
    // Everything else (span, u, sup, img, …) is unwrapped silently.
  }
  flush();
  return paras;
}

/** Plain text of an HTML fragment (paragraphs joined with newlines). */
export function htmlToText(html: string): string {
  return htmlToParas(html)
    .map((p) => p.runs.map((r) => r.text).join(''))
    .join('\n')
    .trim();
}
