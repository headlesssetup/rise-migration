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
});

describe('isReview360StoryHtml', () => {
  it('distinguishes the two forms', () => {
    expect(isReview360StoryHtml(WEB)).toBe(false);
    expect(isReview360StoryHtml(R360)).toBe(true);
    expect(isReview360StoryHtml(webStoryHtmlToReview360(WEB))).toBe(true);
  });
});
