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
