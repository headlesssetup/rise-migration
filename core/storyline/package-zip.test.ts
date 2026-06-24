import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  buildReview360Zip,
  extractPackage,
  getRuntimeDataJs,
  listPackageLeaves,
  repackageLeafFromWebExport,
  unzipToMap,
} from './package-zip';
import { isReview360StoryHtml } from './repackage';

const fx = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../tests/fixtures/storyline/${name}`, import.meta.url)), 'utf8');

const WEB_STORY = fx('web-story.html');
const RUNTIME = fx('runtime-data.js');
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// Build a synthetic web-export zip with one storyline package under
// content/assets/{leaf}/ + content/runtime-data.js, mirroring the real layout.
const LEAF = 'k3sFdQgN6xRXAoBp';
function makeWebExportZip(): Uint8Array {
  return zipSync(
    {
      'content/runtime-data.js': enc(RUNTIME),
      [`content/assets/${LEAF}/story.html`]: enc(WEB_STORY),
      [`content/assets/${LEAF}/threeSixty.json`]: enc(fx('threeSixty.json')),
      [`content/assets/${LEAF}/story_content/user.js`]: enc('var x=1;\r\n'),
      [`content/assets/${LEAF}/html5/data/js/data.js`]: enc('DATA'),
      // a stray non-storyline asset that must NOT leak into the package
      'content/assets/other.png': enc('PNG'),
    },
    { mtime: Date.UTC(1980, 0, 1) },
  );
}

describe('unzipToMap / getRuntimeDataJs / listPackageLeaves', () => {
  const files = unzipToMap(makeWebExportZip());

  it('round-trips entries into a Map', () => {
    expect(files.get(`content/assets/${LEAF}/story.html`)).toBeInstanceOf(Uint8Array);
  });

  it('reads runtime-data.js as text', () => {
    expect(getRuntimeDataJs(files)).toContain('__jsonp');
  });

  it('lists only leaves that contain a story.html', () => {
    expect(listPackageLeaves(files)).toEqual([LEAF]);
  });

  it('throws when runtime-data.js is missing', () => {
    expect(() => getRuntimeDataJs(new Map())).toThrow(/runtime-data/);
  });
});

describe('extractPackage', () => {
  const files = unzipToMap(makeWebExportZip());

  it('re-roots the package to the leaf folder and excludes other assets', () => {
    const pkg = extractPackage(files, LEAF);
    expect([...pkg.keys()].sort()).toEqual([
      'html5/data/js/data.js',
      'story.html',
      'story_content/user.js',
      'threeSixty.json',
    ]);
    expect(pkg.has('other.png')).toBe(false);
  });

  it('throws when the leaf has no story.html', () => {
    expect(() => extractPackage(files, 'nope')).toThrow(/no story\.html/);
  });
});

describe('buildReview360Zip', () => {
  it('transforms story.html and keeps files at the zip root', () => {
    const pkg = extractPackage(unzipToMap(makeWebExportZip()), LEAF);
    const out = unzipSync(buildReview360Zip(pkg));
    // story.html now in Review-360 form
    expect(isReview360StoryHtml(new TextDecoder().decode(out['story.html']!))).toBe(true);
    // other files passed through byte-for-byte, still at root
    expect(new TextDecoder().decode(out['story_content/user.js']!)).toBe('var x=1;\r\n');
    expect(out['threeSixty.json']).toBeTruthy();
    expect(Object.keys(out).some((k) => k.startsWith('content/'))).toBe(false);
  });

  it('is deterministic (same input → identical bytes)', () => {
    const pkg = extractPackage(unzipToMap(makeWebExportZip()), LEAF);
    expect(buildReview360Zip(pkg)).toEqual(buildReview360Zip(pkg));
  });
});

describe('repackageLeafFromWebExport', () => {
  it('goes web-export bytes → R360 zip bytes in one call', () => {
    const out = unzipSync(repackageLeafFromWebExport(makeWebExportZip(), LEAF));
    expect(out['story.html']).toBeTruthy();
    expect(isReview360StoryHtml(new TextDecoder().decode(out['story.html']!))).toBe(true);
  });
});
