import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { renderCourseModel } from './from-course';
import { writeStoryboardDocxProse, type ResolvedImage } from './docx-write-prose';

const COURSE_PATH =
  '/Users/ssneg/Downloads/zz21/courses/_OJHJ1wTpi4OcXRz_IGbFn0IaE-gXyty.json';
const MANIFEST_PATH =
  '/Users/ssneg/Downloads/zz21/courses/_OJHJ1wTpi4OcXRz_IGbFn0IaE-gXyty.assets.json';
const ASSETS_DIR = '/Users/ssneg/Downloads/zz21/assets';
const OUT_DIR =
  '/private/tmp/claude-501/-Users-ssneg--development-intea-rise-migration--claude-worktrees-rise-docx-export-92326b/4b0049d0-e858-4ba2-a540-51e6d97004fd/scratchpad';

const RASTER = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

describe('prose docx writer', () => {
  it('renders a minimal model', () => {
    const model = renderCourseModel(
      {
        course: {
          id: 'test-1',
          title: 'Test Course',
          lessons: [{ id: 'l1', title: 'Lesson 1', type: 'regular', blocks: [] }],
          themeId: 'default',
        },
        lessons: [
          {
            id: 'l1',
            title: 'Lesson 1',
            type: 'regular',
            blocks: [
              {
                id: 'b1',
                family: 'text',
                variant: 'paragraph',
                items: [{ id: 'i1', type: 'text', text: '<p>Hello <strong>world</strong></p>' }],
              },
            ],
          },
        ],
      } as any,
      { generatedAt: '2026-01-01T00:00:00Z', toolVersion: '0.0.test' },
    );

    const bytes = writeStoryboardDocxProse(model);
    expect(bytes.length).toBeGreaterThan(100);
    // Valid ZIP signature
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it.skipIf(!existsSync(COURSE_PATH))(
    'generates Marlink sample docx with images',
    () => {
      const parsed = JSON.parse(readFileSync(COURSE_PATH, 'utf8'));
      const raw = parsed.payload ?? parsed;
      const model = renderCourseModel(raw, {
        generatedAt: new Date().toISOString(),
        toolVersion: '0.0.test',
      });
      console.log(`Model: ${model.lessons.length} lessons, ${model.blockCount} blocks`);

      const images = new Map<string, ResolvedImage>();
      if (existsSync(MANIFEST_PATH)) {
        const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
        const keyToEntry = new Map<string, any>(
          manifest.assets.map((a: any) => [a.key, a]),
        );
        const needed = new Set<string>();
        for (const lesson of model.lessons) {
          for (const row of lesson.rows) {
            if (row.image?.key) needed.add(row.image.key);
          }
        }
        console.log(`Needed images: ${needed.size}`);

        for (const key of needed) {
          const entry = keyToEntry.get(key);
          if (!entry || !RASTER.has(entry.ext)) continue;
          const filePath = join(ASSETS_DIR, `${entry.hash}.${entry.ext}`);
          if (!existsSync(filePath)) continue;
          const bytes = readFileSync(filePath);
          const row = model.lessons
            .flatMap((l) => l.rows)
            .find((r) => r.image?.key === key);
          images.set(key, {
            key,
            bytes: new Uint8Array(bytes),
            ext: entry.ext === 'jpeg' ? 'jpg' : entry.ext,
            width: row?.image?.width ?? 800,
            height: row?.image?.height ?? 600,
          });
        }
        console.log(`Resolved images: ${images.size}`);
      }

      const bytes = writeStoryboardDocxProse(model, images);
      const outPath = join(OUT_DIR, 'marlink-sample.docx');
      writeFileSync(outPath, bytes);
      console.log(`Written: ${outPath} (${bytes.length} bytes)`);

      expect(bytes.length).toBeGreaterThan(1000);
      expect(model.lessons.length).toBe(5);
    },
  );
});

describe('prose docx — descriptions, highlighted type tokens, indentation', () => {
  const { unzipSync } = require('fflate') as typeof import('fflate');
  const docXml = (bytes: Uint8Array): string =>
    new TextDecoder().decode(unzipSync(bytes)['word/document.xml']!);

  it('emits course description under the title and highlights the block type', () => {
    const model = renderCourseModel(
      {
        course: {
          id: 'c1',
          title: 'T',
          description: '<p>The course intro paragraph.</p>',
          lessons: ['l1'],
        },
        lessons: [
          {
            id: 'l1',
            title: 'L1',
            type: 'blocks',
            items: [
              {
                id: 'b1',
                family: 'text',
                variant: 'heading paragraph',
                items: [{ id: 'i1', heading: '<p>H</p>', paragraph: '<p>P</p>' }],
              },
              {
                id: 'b2',
                family: 'interactive',
                variant: 'accordion',
                items: [{ id: 'a1', title: 'Acc title', description: '<p>Acc body.</p>' }],
              },
            ],
          },
        ],
      } as any,
      { generatedAt: '2026-01-01T00:00:00Z', toolVersion: '0.0.test' },
    );
    const xml = docXml(writeStoryboardDocxProse(model));
    expect(xml).toContain('The course intro paragraph.');
    // block-type designator: yellow highlight + black + bold, inside the token line
    expect(xml).toContain('<w:highlight w:val="yellow"/>');
    expect(xml).toMatch(/<w:highlight w:val="yellow"\/>[^<]*<\/w:rPr><w:t xml:space="preserve">interactive\/accordion<\/w:t>/);
    // text block: ONLY the word `text` highlighted; the variant stays plain
    expect(xml).toMatch(/<w:highlight w:val="yellow"\/>[^<]*<\/w:rPr><w:t xml:space="preserve">text<\/w:t>/);
    expect(xml).not.toMatch(/<w:highlight w:val="yellow"\/>[^<]*<\/w:rPr><w:t xml:space="preserve">text\/heading paragraph<\/w:t>/);
    // accordion content is indented (720 twips), its title is not
    expect(xml).toContain('<w:ind w:left="720"/>');
  });

  it('emits lesson description under the lesson heading', () => {
    const model = renderCourseModel(
      {
        course: { id: 'c1', title: 'T', lessons: ['l1'] },
        lessons: [
          { id: 'l1', title: 'L1', type: 'blocks', description: '<p>Why this lesson matters.</p>', items: [] },
        ],
      } as any,
      { generatedAt: '2026-01-01T00:00:00Z', toolVersion: '0.0.test' },
    );
    const xml = docXml(writeStoryboardDocxProse(model));
    expect(xml).toContain('Why this lesson matters.');
  });
});

describe('prose docx — export cover page', () => {
  const { unzipSync } = require('fflate') as typeof import('fflate');
  const docXml = (bytes: Uint8Array): string =>
    new TextDecoder().decode(unzipSync(bytes)['word/document.xml']!);

  it('page 1 = title + meta + TOC, page break, then title + description + content', () => {
    const model = renderCourseModel(
      {
        course: {
          id: 'c1',
          title: 'Cover Course',
          description: '<p>The intro.</p>',
          lessons: ['l1'],
        },
        lessons: [
          {
            id: 'l1',
            title: 'Only Lesson',
            type: 'blocks',
            items: [
              { id: 'b1', family: 'text', variant: 'paragraph', items: [{ id: 'i1', paragraph: '<p>Body.</p>' }] },
            ],
          },
        ],
      } as any,
      { generatedAt: '2026-01-01T00:00:00Z', toolVersion: '0.0.test' },
    );
    const xml = docXml(writeStoryboardDocxProse(model));

    // The title heading appears twice: on the cover and atop the content.
    const titles = xml.split('Cover Course').length - 1;
    expect(titles).toBeGreaterThanOrEqual(2);
    // Exactly one explicit page break separates cover from content.
    const brk = xml.indexOf('<w:br w:type="page"/>');
    expect(brk).toBeGreaterThan(-1);
    // Cover: meta + TOC before the break; single-lesson courses get a TOC too.
    expect(xml.indexOf('Course ID')).toBeLessThan(brk);
    expect(xml.indexOf('Lessons')).toBeLessThan(brk);
    expect(xml.indexOf('1. Only Lesson')).toBeLessThan(brk);
    // Content: description and blocks only AFTER the break.
    expect(xml.indexOf('The intro.')).toBeGreaterThan(brk);
    expect(xml.indexOf('Body.')).toBeGreaterThan(brk);
    // Second title heading is after the break too.
    expect(xml.lastIndexOf('Cover Course')).toBeGreaterThan(brk);
  });
});

describe('prose docx — flashcard table, hidden shading, legend', () => {
  const { unzipSync } = require('fflate') as typeof import('fflate');
  const docXml = (bytes: Uint8Array): string =>
    new TextDecoder().decode(unzipSync(bytes)['word/document.xml']!);

  const model = () =>
    renderCourseModel(
      {
        course: { id: 'c1', title: 'T', lessons: ['l1'] },
        lessons: [
          {
            id: 'l1',
            title: 'L1',
            type: 'blocks',
            items: [
              {
                id: 'b-fc',
                family: 'flashcard',
                variant: 'flashcard',
                items: [
                  { id: 'c1', front: { description: '<p>Front one</p>' }, back: { description: '<p>Back one</p>' } },
                  { id: 'c2', front: { description: '<p>Front two</p>' }, back: { media: { image: { key: 'k' } } } },
                ],
              },
              {
                id: 'b-proc',
                family: 'interactive-fullscreen',
                variant: 'process',
                items: [
                  { id: 'p1', type: 'step', title: 'Step 1', description: '<p>Visible step.</p>' },
                  { id: 'p2', type: 'summary', title: 'Summary', isHidden: true, description: '<p>Secret summary.</p>' },
                ],
              },
            ],
          },
        ],
      } as any,
      { generatedAt: '2026-01-01T00:00:00Z', toolVersion: '0.0.test' },
    );

  it('renders flashcards as a 2-column table, one card per row', () => {
    const m = model();
    const row = m.lessons[0]!.rows.find((r) => r.blockId === 'b-fc')!;
    expect(row.cards).toHaveLength(2);
    const xml = docXml(writeStoryboardDocxProse(m));
    // one table row per card: front cell then back cell
    const tbl = xml.slice(xml.indexOf('Front one') - 2000);
    expect(tbl.indexOf('Front one')).toBeLessThan(tbl.indexOf('Back one'));
    expect(xml).toContain('Front two');
    expect(xml).toContain('(media)');
    // the flat front/back paragraph fallback is NOT also emitted (no dup text)
    expect(xml.split('Front one').length - 1).toBe(1);
    // square-ish rows: min height on each card row
    expect(xml).toContain('<w:trHeight w:val="2400" w:hRule="atLeast"/>');
  });

  it('marks hidden items in the model and shades them light red in prose', () => {
    const m = model();
    const proc = m.lessons[0]!.rows.find((r) => r.blockId === 'b-proc')!;
    const hiddenParas = proc.content.filter((p) => p.hidden);
    expect(hiddenParas.length).toBeGreaterThan(0);
    expect(hiddenParas.some((p) => p.runs.some((r) => r.text.includes('Secret summary')))).toBe(true);
    // visible step is NOT marked
    expect(
      proc.content.some((p) => !p.hidden && p.runs.some((r) => r.text.includes('Visible step'))),
    ).toBe(true);
    const xml = docXml(writeStoryboardDocxProse(m));
    const at = xml.indexOf('Secret summary');
    expect(xml.lastIndexOf('w:fill="FFC7CE"', at)).toBeGreaterThan(at - 400);
    // the visible step carries no shading
    const vis = xml.indexOf('Visible step');
    expect(xml.slice(vis - 400, vis)).not.toContain('FFC7CE');
  });

  it('puts a legend on the cover, before the page break', () => {
    const xml = docXml(writeStoryboardDocxProse(model()));
    const brk = xml.indexOf('<w:br w:type="page"/>');
    const legend = xml.indexOf('Legend:');
    expect(legend).toBeGreaterThan(-1);
    expect(legend).toBeLessThan(brk);
    expect(xml).toContain('= correct quiz answer');
    expect(xml).toContain('= block type');
    expect(xml).toContain('= in the course but hidden from learners');
  });
});

describe('prose docx — flashcard variants and image dedup', () => {
  const { unzipSync } = require('fflate') as typeof import('fflate');
  const parts = (bytes: Uint8Array): Record<string, Uint8Array> => unzipSync(bytes);
  const docXml = (bytes: Uint8Array): string =>
    new TextDecoder().decode(parts(bytes)['word/document.xml']!);

  // Regression: a live course reported variant `stack`, which fell through the
  // exact-variant gate to the RO extractor — emitting back-then-front (JSON key
  // order) as loose paragraphs instead of a card table.
  it.each(['flashcard', 'stack', 'someFutureVariant'])(
    'renders flashcard/%s as a card table',
    (variant) => {
      const model = renderCourseModel(
        {
          course: { id: 'c1', title: 'T', lessons: ['l1'] },
          lessons: [
            {
              id: 'l1',
              title: 'L1',
              type: 'blocks',
              items: [
                {
                  id: 'b-fc',
                  family: 'flashcard',
                  variant,
                  // NOTE: `back` first, exactly as the archive stores it.
                  items: [
                    {
                      id: 'c1',
                      back: { description: '<p>The answer.</p>' },
                      front: { description: '<p>The prompt.</p>' },
                    },
                  ],
                },
              ],
            },
          ],
        } as any,
        { generatedAt: '2026-01-01T00:00:00Z', toolVersion: '0.0.test' },
      );
      const row = model.lessons[0]!.rows[0]!;
      expect(row.fidelity).toBe('edit');
      expect(row.cards).toHaveLength(1);
      const xml = docXml(writeStoryboardDocxProse(model));
      expect(xml).toContain('<w:tbl>');
      // FRONT precedes BACK in the table, whatever the source key order.
      expect(xml.indexOf('The prompt.')).toBeLessThan(xml.indexOf('The answer.'));
    },
  );

  it('embeds byte-identical images once, however many keys reference them', () => {
    const model = renderCourseModel(
      {
        course: { id: 'c1', title: 'T', lessons: ['l1'] },
        lessons: [
          {
            id: 'l1',
            title: 'L1',
            type: 'blocks',
            items: ['a', 'b', 'c'].map((n) => ({
              id: `b-${n}`,
              family: 'image',
              variant: 'banner',
              items: [{ id: `i-${n}`, media: { image: { key: `rise/courses/c1/${n}.jpg`, type: 'image' } } }],
            })),
          },
        ],
      } as any,
      { generatedAt: '2026-01-01T00:00:00Z', toolVersion: '0.0.test' },
    );
    // Same bytes under three different keys (a real course re-uploads a photo).
    const shared = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const images = new Map(
      ['a', 'b', 'c'].map((n) => [
        `rise/courses/c1/${n}.jpg`,
        { key: `rise/courses/c1/${n}.jpg`, bytes: shared, ext: 'jpg', width: 100, height: 80 },
      ]),
    );
    const bytes = writeStoryboardDocxProse(model, images as never);
    const media = Object.keys(parts(bytes)).filter((p) => p.startsWith('word/media/'));
    expect(media).toHaveLength(1);
    // …and all three blocks still show it.
    expect(docXml(bytes).split('rIdImg1').length - 1).toBe(3);
  });
});
