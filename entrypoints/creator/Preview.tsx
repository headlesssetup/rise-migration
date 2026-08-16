// Pseudo-Rise preview of a VALIDATED Course Blueprint. The operator approves
// what they see here, so each block card resembles the Rise widget it becomes:
// tables where the data is genuinely pairwise/columnar (flashcards, sorting,
// timeline), stacked title+body where the widget stacks (accordion, tabs,
// process), official green for correct KC options, amber for placeholders,
// a visible badge for provider-suggested (invented/rephrased) content.

import type {
  BlockIntent,
  BlueprintBlock,
  BlueprintSourceRef,
  CourseBlueprint,
} from '@/core/creator';

export const KIND_LABEL: Record<BlockIntent['kind'], string> = {
  text: 'Text',
  list: 'List',
  accordion: 'Accordion',
  tabs: 'Tabs',
  flashcards: 'Flashcards',
  process: 'Process',
  timeline: 'Timeline',
  sorting: 'Sorting',
  'knowledge-check': 'Knowledge check',
  note: 'Note',
  links: 'Buttons (links)',
  'video-placeholder': 'Video — placeholder',
  'storyline-placeholder': 'Storyline/Mighty — placeholder',
  continue: 'Continue (button)',
  'attachment-placeholder': 'Attachment — placeholder',
};

function isPlaceholder(kind: BlockIntent['kind']): boolean {
  return (
    kind === 'video-placeholder' ||
    kind === 'storyline-placeholder' ||
    kind === 'attachment-placeholder'
  );
}

/* --- HTML rendering ------------------------------------------------------ */

const ALLOWED_TAGS = new Set(['P', 'STRONG', 'EM', 'B', 'I', 'A', 'UL', 'OL', 'LI', 'BR']);

/** Defense-in-depth on top of the validator: keep only the allowed inline
 *  tags, strip every attribute except a sane href on <a>. */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const clean = (node: Element): void => {
    for (const child of [...node.children]) {
      clean(child);
      if (!ALLOWED_TAGS.has(child.tagName)) {
        child.replaceWith(...child.childNodes);
        continue;
      }
      const href = child.tagName === 'A' ? child.getAttribute('href') : null;
      for (const attr of [...child.attributes]) child.removeAttribute(attr.name);
      if (href && !/^\s*javascript:/i.test(href)) {
        child.setAttribute('href', href);
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noreferrer');
      }
    }
  };
  clean(doc.body);
  return doc.body.innerHTML;
}

function Html({ html, className }: { html: string; className?: string }) {
  if (!html) return null;
  return <div className={className} dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;
}

/* --- per-kind content ---------------------------------------------------- */

function StackedItems({
  items,
  numbered,
}: {
  items: { title: string; body: string }[];
  numbered?: boolean;
}) {
  return (
    <div className="stacked">
      {items.map((it, i) => (
        <div className="stacked-item" key={i}>
          <p className="item-title">
            {numbered ? `${i + 1}. ` : ''}
            {it.title}
          </p>
          <Html html={it.body} className="item-body" />
        </div>
      ))}
    </div>
  );
}

function IntentContent({ intent }: { intent: BlockIntent }) {
  switch (intent.kind) {
    case 'text':
      return (
        <>
          {intent.heading && <p className="blk-heading">{intent.heading}</p>}
          <Html html={intent.paragraphs.join('')} />
        </>
      );

    case 'list': {
      const ListTag = intent.ordered ? 'ol' : 'ul';
      return (
        <>
          {intent.heading && <p className="blk-heading">{intent.heading}</p>}
          <Html html={intent.intro.join('')} />
          <ListTag className="blk-list">
            {intent.items.map((item, i) => (
              <li key={i}>
                <Html html={item} />
              </li>
            ))}
          </ListTag>
          {intent.outro && <Html html={intent.outro.join('')} />}
        </>
      );
    }

    case 'accordion':
    case 'tabs':
    case 'process':
      return (
        <>
          {intent.heading && <p className="blk-heading">{intent.heading}</p>}
          <Html html={intent.intro.join('')} />
          <StackedItems items={intent.items} numbered={intent.kind === 'process'} />
        </>
      );

    case 'flashcards':
      return (
        <>
          {intent.heading && <p className="blk-heading">{intent.heading}</p>}
          <Html html={intent.intro.join('')} />
          <table className="plan-table pair-table">
            <thead>
              <tr>
                <th>Front</th>
                <th>Back</th>
              </tr>
            </thead>
            <tbody>
              {intent.items.map((it, i) => (
                <tr key={i}>
                  <td className="pair-front">{it.title}</td>
                  <td>
                    <Html html={it.body} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      );

    case 'timeline':
      return (
        <>
          {intent.heading && <p className="blk-heading">{intent.heading}</p>}
          <Html html={intent.intro.join('')} />
          <table className="plan-table pair-table">
            <thead>
              <tr>
                <th className="col-date">Date</th>
                <th>Event</th>
              </tr>
            </thead>
            <tbody>
              {intent.events.map((e, i) => (
                <tr key={i}>
                  <td className="pair-front">{e.date}</td>
                  <td>
                    <p className="item-title">{e.title}</p>
                    <Html html={e.body} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      );

    case 'sorting': {
      const byPile = intent.piles.map((_, pi) =>
        intent.cards.filter((c) => c.pile === pi + 1),
      );
      return (
        <>
          {intent.heading && <p className="blk-heading">{intent.heading}</p>}
          <Html html={intent.intro.join('')} />
          <table className="plan-table pair-table">
            <thead>
              <tr>
                {intent.piles.map((p, i) => (
                  <th key={i}>{p}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {byPile.map((cards, i) => (
                  <td key={i}>
                    <ul className="blk-list">
                      {cards.map((c, j) => (
                        <li key={j}>{c.title}</li>
                      ))}
                    </ul>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </>
      );
    }

    case 'knowledge-check':
      return (
        <>
          {intent.heading && <p className="blk-heading">{intent.heading}</p>}
          <Html html={intent.intro.join('')} />
          {intent.questions.map((q, i) => (
            <div className="kc-question" key={i}>
              <Html html={q.stem} className="kc-stem" />
              <ul className="kc-options">
                {q.options.map((o, j) => (
                  <li key={j} className={o.correct ? 'kc-correct' : undefined}>
                    {o.correct ? '✓ ' : '○ '}
                    {o.text}
                    {o.feedback && <span className="kc-answer-feedback"> ↳ {o.feedback}</span>}
                  </li>
                ))}
              </ul>
              {q.options.some((o) => o.feedback) && (
                <p className="hint">
                  ⚠ Per-answer feedback is shown for review only — it has no donor-backed Rise
                  slot yet and will NOT be imported (it stays in the plan artifact).
                </p>
              )}
              {q.feedback && (
                <div className="kc-feedback">
                  <span className="kc-feedback-label">Feedback: </span>
                  <Html html={q.feedback} />
                </div>
              )}
            </div>
          ))}
        </>
      );

    case 'note':
      return (
        <div className="note-box">
          <Html html={intent.paragraphs.join('')} />
        </div>
      );

    case 'links':
      return (
        <>
          {intent.heading && <p className="blk-heading">{intent.heading}</p>}
          <Html html={intent.intro.join('')} />
          <ul className="blk-buttons">
            {intent.buttons.map((b, i) => (
              <li key={i}>
                <span className="btn-label">[{b.label}]</span> →{' '}
                <a href={b.destination} target="_blank" rel="noreferrer">
                  {b.destination}
                </a>
                {b.description && <span className="hint"> — {b.description}</span>}
              </li>
            ))}
          </ul>
          {intent.trailing && <Html html={intent.trailing.join('')} />}
        </>
      );

    case 'video-placeholder':
    case 'storyline-placeholder':
    case 'attachment-placeholder':
      return (
        <p className="placeholder-label">
          {intent.kind === 'video-placeholder' ? '🎬' : intent.kind === 'attachment-placeholder' ? '📎' : '⚠'}{' '}
          {intent.label}
        </p>
      );

    case 'continue':
      return <p className="continue-gate">[{intent.label}]</p>;
  }
}

/* --- block card + lesson + summary --------------------------------------- */

function refText(ref: BlueprintSourceRef): string {
  const where = ref.slideNo != null ? `slide ${ref.slideNo}` : ref.label;
  return ref.slideNo != null && ref.label && !new RegExp(`^slide\\s*${ref.slideNo}$`, 'i').test(ref.label)
    ? `${where} — ${ref.label}`
    : where;
}

function BlockCard({ block, ordinal }: { block: BlueprintBlock; ordinal: number }) {
  const kind = block.intent.kind;
  return (
    <div className={`block-card${block.origin === 'suggested' ? ' block-suggested' : ''}`}>
      <div className="block-head">
        <span className="blk-no">{ordinal}</span>
        <span className={`chip ${isPlaceholder(kind) ? 'chip-placeholder' : 'chip-auto'}`}>
          {KIND_LABEL[kind]}
        </span>
        {block.origin === 'suggested' && (
          <span className="chip chip-suggested" title="Text invented or rephrased by the AI — review against the source">
            AI-suggested
          </span>
        )}
      </div>
      <div className="block-body">
        <IntentContent intent={block.intent} />
      </div>
      {block.notes.length > 0 && (
        <ul className="notes">
          {block.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <details>
        <summary>Source: {refText(block.sourceRef)}</summary>
        {block.sourceRef.excerpt && <pre>{block.sourceRef.excerpt}</pre>}
      </details>
    </div>
  );
}

/** "1–14, 17" from a set of slide numbers. */
export function formatRanges(nums: number[]): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]! === sorted[j]! + 1) j++;
    parts.push(i === j ? String(sorted[i]) : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(', ');
}

export function slideCoverage(bp: CourseBlueprint): { referenced: string; missing: string } | null {
  const nums: number[] = [];
  for (const lesson of bp.lessons) {
    for (const block of lesson.blocks) {
      if (block.sourceRef.slideNo != null) nums.push(block.sourceRef.slideNo);
    }
  }
  for (const u of bp.unresolved) if (u.sourceRef.slideNo != null) nums.push(u.sourceRef.slideNo);
  for (const p of bp.production) if (p.sourceRef.slideNo != null) nums.push(p.sourceRef.slideNo);
  if (nums.length === 0) return null;
  const seen = new Set(nums);
  const max = Math.max(...nums);
  const missing: number[] = [];
  for (let n = 1; n <= max; n++) if (!seen.has(n)) missing.push(n);
  return { referenced: formatRanges(nums), missing: formatRanges(missing) };
}

export function Preview({ blueprint }: { blueprint: CourseBlueprint }) {
  const coverage = slideCoverage(blueprint);
  return (
    <>
      <p className="course-title">{blueprint.title}</p>
      {coverage && (
        <p className="hint">
          Slides referenced: {coverage.referenced}
          {coverage.missing && (
            <>
              {' '}
              · <b className="error">not referenced: {coverage.missing}</b> — compare with the
              original document
            </>
          )}
        </p>
      )}

      {blueprint.lessons.map((lesson, li) => (
        <section className="card" key={li}>
          <h2>
            {li + 1} / {blueprint.lessons.length} · {lesson.title}
          </h2>
          {lesson.blocks.map((block, bi) => (
            <BlockCard block={block} ordinal={bi + 1} key={bi} />
          ))}
        </section>
      ))}

      {blueprint.production.length > 0 && (
        <section className="card">
          <h2>Production material (narration — NOT course content)</h2>
          {blueprint.production.map((p, i) => (
            <div className="production-item" key={i}>
              <p className="item-title">
                {p.lesson} · {refText(p.sourceRef)}
              </p>
              <p className="item-body">{p.text}</p>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
