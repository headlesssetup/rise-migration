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
