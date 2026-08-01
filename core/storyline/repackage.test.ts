import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isReview360StoryHtml, webStoryHtmlToReview360 } from './repackage';

const fx = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../tests/fixtures/storyline/${name}`, import.meta.url)), 'utf8');

// Fixtures are the real `story.html` from the operator's two sample zips:
//  - web-story.html  : from the Rise "Publish to Web" export (content/assets/{leaf}/)
//  - r360-story.html : from the Review-360 manual-upload package
// Every other file in the two packages is byte-identical (verified out of band).
const WEB = fx('web-story.html');
const R360 = fx('r360-story.html');

describe('webStoryHtmlToReview360', () => {
  it('reproduces the Review-360 package story.html byte-for-byte', () => {
    expect(webStoryHtmlToReview360(WEB)).toBe(R360);
  });

  it('is idempotent (already-converted input is unchanged)', () => {
    const once = webStoryHtmlToReview360(WEB);
    expect(webStoryHtmlToReview360(once)).toBe(once);
    expect(webStoryHtmlToReview360(R360)).toBe(R360);
  });

  it('drops the robots meta and swaps the player script for the 360 marker', () => {
    const out = webStoryHtmlToReview360(WEB);
    expect(out).not.toContain('name="robots"');
    expect(out).not.toContain('360-player-interface');
    expect(out).toContain('<!-- 360 -->');
  });

  it('preserves CRLF line endings', () => {
    expect(webStoryHtmlToReview360(WEB)).toContain('\r\n');
  });

  // Loud-failure guard (M14): the transform is two exact-string replaces, so a
  // new player version with slightly different markup would silently no-op both
  // and we'd upload a story.html still pointing at ../../lib/player-interface.js.
  it('throws loudly when the player script markup drifted (replace no-ops)', () => {
    // attribute order changed → the exact-string replace no longer matches
    const drifted = WEB.replace(
      '<script id="360-player-interface" type="text/javascript" src="../../lib/player-interface.js"></script>',
      '<script type="text/javascript" id="360-player-interface" src="../../lib/player-interface.js"></script>',
    );
    expect(drifted).not.toBe(WEB); // fixture sanity: the drift actually applied
    expect(() => webStoryHtmlToReview360(drifted)).toThrow(/Rise export format changed/);
    expect(() => webStoryHtmlToReview360(drifted)).toThrow(/player marker is missing/);
  });

  it('throws loudly when the robots meta drifted (survives the exact replace)', () => {
    const drifted = WEB.replace(
      '<meta name="robots" content="noindex, nofollow">',
      '<meta content="noindex, nofollow" name="robots">',
    );
    expect(drifted).not.toBe(WEB);
    expect(() => webStoryHtmlToReview360(drifted)).toThrow(/Rise export format changed/);
    expect(() => webStoryHtmlToReview360(drifted)).toThrow(/robots meta tag survived/);
  });

  it('throws on markup that is neither web-export nor Review-360 form', () => {
    expect(() => webStoryHtmlToReview360('<html><head></head></html>')).toThrow(
      /Rise export format changed/,
    );
  });
});

describe('isReview360StoryHtml', () => {
  it('distinguishes the two forms', () => {
    expect(isReview360StoryHtml(WEB)).toBe(false);
    expect(isReview360StoryHtml(R360)).toBe(true);
    expect(isReview360StoryHtml(webStoryHtmlToReview360(WEB))).toBe(true);
  });
});
