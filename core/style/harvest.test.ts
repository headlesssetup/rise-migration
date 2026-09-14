import { describe, expect, it } from 'vitest';
import { harvestStyleProfile, parseStyleProfile } from './harvest';
import { FIX_ACCENT, FIX_LIGHT, TYPE_IDS, vasLikeCourse } from './fixture';
import { VIDEO_ID_TOKEN } from './types';
import { decorateParagraphHtml, sentenceCase, typeClass } from './typography';

function harvestFixture(opts?: Parameters<typeof vasLikeCourse>[2]) {
  const a = vasLikeCourse('crsA', 'VAS 1.1 Kurss A', { kcColors: true, ...opts });
  const b = vasLikeCourse('crsB', 'VAS 1.2 Kurss B', { heroOpener: true, ...opts });
  return harvestStyleProfile({
    name: 'VAS test',
    courses: [a, b],
    toolVersion: '0.9.12-test',
    harvestedAt: '2026-09-14T12:00:00Z',
  });
}

describe('harvestStyleProfile', () => {
  const { profile, report } = harvestFixture();

  it('takes theme, fonts, label set, cover and logo from the PRIMARY course verbatim', () => {
    expect(profile.course.theme?.themeId).toBe('organic');
    expect(profile.course.headingTypefaceId).toBe('tf-SourceSansPro');
    expect(profile.course.uiTypefaceId).toBe('tf-Inter');
    expect(profile.course.labelSetId).toBe('OB-YT24aYbEb8J5atoVsQFJY');
    expect(JSON.stringify(profile.course.coverImage)).toContain('rise/courses/crsA/cover.png');
    expect(JSON.stringify(profile.course.media)).toContain('rise/courses/crsA/logo.svg');
    // Empty {} course images are not "an image".
    expect(profile.course.cardImage).toBeNull();
    expect(profile.sourceCourseIds).toEqual(['crsA', 'crsB']);
  });

  it('resolves the Mighty global type styles to roles by name', () => {
    expect(profile.typography.roles).toEqual({
      h1: TYPE_IDS.h1,
      h1White: TYPE_IDS.h1White,
      h2: TYPE_IDS.h2,
      h2Gray: TYPE_IDS.h2Gray,
      h3: TYPE_IDS.h3,
      body: TYPE_IDS.body,
      boldBody: TYPE_IDS.boldBody,
    });
    expect(typeClass(profile, 'body')).toBe(`mighty-type-style-${TYPE_IDS.body}`);
    expect(profile.typography.styles.find((s) => s.id === TYPE_IDS.h1)?.fontSizePx).toBe(34);
  });

  it('records the light band colour, lesson icon, KC colours and the mid-lesson Continue label', () => {
    expect(profile.bands.lightColor).toBe(FIX_LIGHT);
    expect(profile.lessons.icon).toBe('Article');
    // Only course A carries the colours — the designer's rule says always apply them.
    expect(profile.knowledgeCheck).toEqual({ correctAnswerColor: FIX_ACCENT, incorrectAnswerColor: '#434656' });
    expect(profile.continueLabel).toBe('Turpināt');
  });

  it('computes per-type settings MODES without band keys or Mighty custom-code configs', () => {
    const heading = profile.blocks['text/heading']!;
    expect(heading.settings).toMatchObject({ paddingTop: 2, paddingBottom: 0, textWidth: 92 });
    expect(heading.settings).not.toHaveProperty('backgroundType');
    expect(profile.blocks['knowledgeCheck/multiple choice']!.settings).toMatchObject({ paddingTop: 3, paddingBottom: 3 });
    expect(profile.blocks['continue/continue']!.settings).toMatchObject({ continueRadius: 30 });
    expect(JSON.stringify(profile.blocks['continue/continue']!.settings.mightyMods)).toContain('button-style');
    // The Mighty video card is a motif, never a settings mode.
    expect(profile.blocks['interactive/tabs']).toBeUndefined();
  });

  it('detects the lesson opener, closer prefix, banners and the donors (a hero picture in one lesson\'s opener slot is content, not opener)', () => {
    const opener = profile.motifs.opener!;
    expect(opener.blocks.map((b) => `${b.family}/${b.variant}`)).toEqual([
      'text/paragraph',
      'text/heading',
      'image/text aside',
      'continue/continue',
    ]);
    expect(opener.headingIndex).toBe(1);
    expect(opener.asideIndex).toBe(2);
    expect(opener.continueIndex).toBe(3);
    for (const b of opener.blocks) {
      expect(b).not.toHaveProperty('globalBlockId');
      expect(b).not.toHaveProperty('id');
    }
    expect(profile.motifs.closer?.nextLabelPrefix).toBe('Nākamā tēma:');
    expect(profile.motifs.banners.map((b) => [b.label, b.count])).toEqual([
      ['Kopsavilkums', 6],
      ['Uzdevums', 4],
    ]);
    expect(profile.motifs.quote?.variant).toBe('d');
    expect(profile.motifs.aside?.variant).toBe('text aside');
    expect(profile.motifs.attachment?.variant).toBe('attachment');
  });

  it('templates the Mighty video card with the VIDEO_ID token (newest instance wins)', () => {
    const video = profile.motifs.video!;
    const html = String(
      ((video.settings as Record<string, unknown>).mightyBlockConfig as { data: { directHtml: string } }).data.directHtml,
    );
    expect(html).toContain(`embed/${VIDEO_ID_TOKEN}?`);
    expect(html).not.toMatch(/embed\/vid\d/);
    expect(video.createdAt).toBeUndefined();
  });

  it('lists every asset the profile references, with archive file paths', () => {
    const keys = profile.assets.map((a) => a.key);
    expect(keys).toContain('rise/courses/crsA/cover.png');
    expect(keys).toContain('rise/courses/crsA/logo.svg');
    expect(keys).toContain('rise/courses/crsA/01.jpg');
    expect(keys).toContain('rise/courses/crsA/edu.svg');
    expect(keys).toContain('rise/courses/crsA/icon.svg');
    for (const a of profile.assets) expect(a.file).toMatch(/^assets\/h[0-9a-f]+\.[a-z]+$/);
    expect(report.some((l) => /shared asset file/.test(l))).toBe(true);
  });

  it('drops a donor whose media has no archived bytes and says so', () => {
    const a = vasLikeCourse('crsA', 'A');
    a.assetManifest.assets = a.assetManifest.assets.filter((x) => !x.key.endsWith('edu.svg'));
    const r = harvestStyleProfile({ name: 'x', courses: [a], toolVersion: 't', harvestedAt: 'now' });
    expect(r.profile.motifs.quote).toBeNull();
    expect(r.report.some((l) => /Skipped \(no archived bytes\).*edu\.svg/.test(l))).toBe(true);
  });

  it('round-trips through JSON and the shape check', () => {
    const back = parseStyleProfile(JSON.stringify(profile));
    expect(back.name).toBe('VAS test');
    expect(() => parseStyleProfile('{"format":"nope"}')).toThrow(/rise-style-profile/);
  });
});

describe('typography helpers', () => {
  it('wraps paragraph, bare list-item and bare cell content in the class span, once', () => {
    const cls = 'mighty-type-style-x';
    expect(decorateParagraphHtml('<p>a</p><p></p>', cls)).toBe(
      `<p><span class="${cls}">a</span></p><p></p>`,
    );
    expect(decorateParagraphHtml('<ul><li>x</li></ul>', cls)).toBe(
      `<ul><li><span class="${cls}">x</span></li></ul>`,
    );
    expect(decorateParagraphHtml('<table><tr><td>c</td></tr></table>', cls)).toBe(
      `<table><tr><td><p><span class="${cls}">c</span></p></td></tr></table>`,
    );
    const styled = '<p><span class="mighty-type-style-y">a</span></p>';
    expect(decorateParagraphHtml(styled, cls)).toBe(styled);
    expect(decorateParagraphHtml('<p>a</p>', null)).toBe('<p>a</p>');
  });

  it('sentence-cases ALL-CAPS labels only', () => {
    expect(sentenceCase('TURPINĀT')).toBe('Turpināt');
    expect(sentenceCase('Turpināt')).toBe('Turpināt');
    expect(sentenceCase('Nākamā tēma: ES')).toBe('Nākamā tēma: ES');
    expect(sentenceCase('123')).toBe('123');
  });
});
