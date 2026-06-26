import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeRuntimeData, findStorylineRefs, parseWebExportRuntimeData } from './web-export';

const fxPath = (name: string): string =>
  fileURLToPath(new URL(`../../tests/fixtures/storyline/${name}`, import.meta.url));
const fx = (name: string): string => readFileSync(fxPath(name), 'utf8');

// Real `runtime-data.js` from the operator's "Publish to Web" sample (a course
// containing one storyline block whose package is bundled at
// content/assets/k3sFdQgN6xRXAoBp/), plus that package's threeSixty.json.
const RUNTIME = fx('runtime-data.js');
const THREE_SIXTY = JSON.parse(fx('threeSixty.json'));

describe('decodeRuntimeData', () => {
  it('strips the __jsonp wrapper and base64-decodes to the course document', () => {
    const doc = decodeRuntimeData(RUNTIME) as { course?: { lessons?: unknown[] } };
    expect(doc.course).toBeTruthy();
    expect(Array.isArray(doc.course?.lessons)).toBe(true);
  });

  it('throws on a malformed wrapper', () => {
    expect(() => decodeRuntimeData('not jsonp at all')).toThrow(/wrapper/);
  });
});

describe('findStorylineRefs', () => {
  it('locates the storyline block, its asset folder leaf, and src', () => {
    const refs = parseWebExportRuntimeData(RUNTIME);
    expect(refs).toHaveLength(1);
    const ref = refs[0]!;
    expect(ref.leaf).toBe('k3sFdQgN6xRXAoBp');
    expect(ref.src).toBe('k3sFdQgN6xRXAoBp/story.html');
    expect(ref.title).toBe('Untitled2');
  });

  it('extracts a meta equal to the package threeSixty.json (the target block payload)', () => {
    const ref = parseWebExportRuntimeData(RUNTIME)[0]!;
    // The web-export block.meta is exactly the manifest Rise writes to
    // media.storyline.meta on import — so it must match the bundled threeSixty.json.
    expect(ref.meta).toEqual(THREE_SIXTY);
  });

  it('derives leaf from src when contentPrefix is absent', () => {
    const refs = findStorylineRefs({
      a: { media: { storyline: { src: 'AbC123/story.html', meta: { title: 'X' } } } },
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.leaf).toBe('AbC123');
    expect(refs[0]!.title).toBe('X');
  });

  it('returns nothing for a document with no storyline media', () => {
    expect(findStorylineRefs({ course: { lessons: [{ items: [{ type: 'text' }] }] } })).toEqual([]);
  });
});
