// Typography decoration — stamp the profile's Mighty type-style classes onto
// the compiler's clean HTML. The designer's courses carry
// `<span class="mighty-type-style-<id>">` on ~97% of body paragraphs and the
// H1/H2 classes on headings; Mighty resolves the class to the global style
// (font, size, colour) at runtime. The MINIMAL serialisation is used here — a
// single class span — which is exactly what the designer's own most recent
// blocks carry (3.2 opener heading, 3.2 intro aside). Text that already carries
// a type-style class is left untouched.

import type { StyleProfile, TypeRole } from './types';

const STYLED = /mighty-type-style-/;

export function typeClass(profile: StyleProfile, role: TypeRole): string | null {
  const id = profile.typography.roles[role];
  if (!id) return null;
  const style = profile.typography.styles.find((s) => s.id === id);
  return style?.className ?? `mighty-type-style-${id}`;
}

function wrap(inner: string, cls: string): string {
  return `<span class="${cls}">${inner}</span>`;
}

/** Wrap the content of every `<p>`, bare `<li>`, and bare `<th>/<td>` in the
 *  body-text class. Empty paragraphs and already-styled HTML are untouched. */
export function decorateParagraphHtml(html: string, cls: string | null): string {
  if (!cls || !html || STYLED.test(html)) return html;
  let out = html.replace(/<p(\s[^>]*)?>([\s\S]*?)<\/p>/g, (m, attrs: string | undefined, inner: string) =>
    inner.trim() === '' ? m : `<p${attrs ?? ''}>${wrap(inner, cls)}</p>`,
  );
  // List items and table cells that hold bare text (no <p> of their own).
  out = out.replace(/<(li|th|td)(\s[^>]*)?>([\s\S]*?)<\/\1>/g, (m, tag: string, attrs: string | undefined, inner: string) => {
    if (inner.trim() === '' || /<p[\s>]/.test(inner)) return m;
    return tag === 'li'
      ? `<li${attrs ?? ''}>${wrap(inner, cls)}</li>`
      : `<${tag}${attrs ?? ''}><p>${wrap(inner, cls)}</p></${tag}>`;
  });
  return out;
}

/** Headings are inline HTML (`<strong>…</strong>`) — one class span around all of it. */
export function decorateHeadingHtml(html: string, cls: string | null): string {
  if (!cls || !html || STYLED.test(html)) return html;
  return wrap(html, cls);
}

/** The designer's rule: buttons are never ALL CAPS ("TURPINĀT" was a mistake).
 *  An all-caps label becomes sentence case; anything else is returned as-is. */
export function sentenceCase(label: string, locale = 'lv'): string {
  const trimmed = label.trim();
  if (!/\p{L}/u.test(trimmed)) return label;
  if (trimmed !== trimmed.toLocaleUpperCase(locale)) return label;
  const lower = trimmed.toLocaleLowerCase(locale);
  const first = [...lower][0] ?? '';
  return first.toLocaleUpperCase(locale) + lower.slice(first.length);
}

/** Item fields whose HTML gets the body-text treatment when it holds `<p>`. */
const PARAGRAPH_FIELDS = new Set(['paragraph', 'description', 'feedback', 'caption', 'title']);

/** Decorate every text slot of a compiler-emitted block in place. `headingRole`
 *  picks the class for `heading` fields (H2 for in-lesson headings). */
export function decorateBlockText(
  block: Record<string, unknown>,
  profile: StyleProfile,
  headingRole: TypeRole = 'h2',
): void {
  const body = typeClass(profile, 'body');
  const heading = typeClass(profile, headingRole);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const row = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'string') {
        if (key === 'heading' && value !== '') {
          row[key] = decorateHeadingHtml(value, heading);
        } else if (PARAGRAPH_FIELDS.has(key) && /<p[\s>]/.test(value)) {
          row[key] = decorateParagraphHtml(value, body);
        }
      } else {
        walk(value);
      }
    }
  };
  walk(block.items);
}
