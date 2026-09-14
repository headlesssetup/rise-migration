// Styled compile (v0.9.12): a blueprint + a harvested style profile → a course
// carrying the theme, type-style classes, settings modes, band rhythm, the
// opener/closer motifs, banner/quote/video/attachment donors and folder
// images, with EVERY referenced media key declared in its asset manifest and
// accepted by the import planner.

import { describe, expect, it } from 'vitest';
import { buildPlan } from '@/core/import';
import { collectAssetKeys } from '@/core/assets/keys';
import type { AssetManifest } from '@/core/assets/manifest';
import type { Mints } from '@/core/storyboard/map';
import { harvestStyleProfile, type ResolvedFile } from '@/core/style';
import { TYPE_IDS, vasLikeCourse } from '@/core/style/fixture';
import {
  COURSE_BLUEPRINT_FORMAT,
  COURSE_BLUEPRINT_VERSION,
  type CourseBlueprint,
} from './blueprint/types';
import { assertCleanDocument, compileCourseBlueprint } from './compiler';

function mints(): Mints {
  let c = 0;
  let u = 0;
  return {
    cuid: () => `c${String(++c).padStart(24, '0')}`,
    uuid: () => `00000000-0000-4000-8000-${String(++u).padStart(12, '0')}`,
  };
}

const REF = (row: number) => ({ label: `Row ${row}`, slideNo: null, row });

function profile() {
  return harvestStyleProfile({
    name: 'VAS test',
    courses: [vasLikeCourse('crsA', 'A', { kcColors: true }), vasLikeCourse('crsB', 'B')],
    toolVersion: 't',
    harvestedAt: '2026-09-14T12:00:00Z',
  }).profile;
}

function blueprint(): CourseBlueprint {
  return {
    format: COURSE_BLUEPRINT_FORMAT,
    formatVersion: COURSE_BLUEPRINT_VERSION,
    source: { kind: 'ai-provider', originalFileName: 'M1_4-nodala_SD.docx' },
    title: '1.4. ES Padomes struktūra',
    lessons: [
      { title: '1. modulis | Nodaļa 4/4', type: 'section', blocks: [] },
      {
        title: '1.4.1. Padomes struktūra',
        image: '1.4.1.1.png',
        blocks: [
          { intent: { kind: 'text', paragraphs: ['<p>Ievads par Padomi.</p>'] }, sourceRef: REF(5), notes: [] },
          { intent: { kind: 'text', heading: 'Līmeņi', paragraphs: ['<p>Trīs līmeņi.</p>'] }, sourceRef: REF(6), notes: [], image: '1.4.1.4.png' },
          { intent: { kind: 'video-placeholder', label: 'Video (~6 min)', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, sourceRef: REF(7), notes: [] },
          { intent: { kind: 'text', heading: 'Sastāvi', paragraphs: ['<p>Desmit sastāvi.</p>'] }, sourceRef: REF(8), notes: [], band: 'light' },
          { intent: { kind: 'list', ordered: false, intro: [], items: ['<p>A</p>', '<p>B</p>'] }, sourceRef: REF(9), notes: [] },
          { intent: { kind: 'banner', label: 'Pārbaudi savas zināšanas!' }, sourceRef: REF(10), notes: [] },
          {
            intent: {
              kind: 'knowledge-check',
              intro: [],
              questions: [
                { stem: '<p>Q1?</p>', options: [{ text: 'a', correct: true }, { text: 'b', correct: false }] },
                { stem: '<p>Q2?</p>', options: [{ text: 'a', correct: true }, { text: 'b', correct: false }] },
              ],
            },
            sourceRef: REF(11),
            notes: [],
          },
          { intent: { kind: 'quote', heading: 'Tēmas padziļināšanai', text: '<p>Ja vēlies uzzināt vairāk.</p>' }, sourceRef: REF(12), notes: [] },
          { intent: { kind: 'links', intro: [], buttons: [{ label: 'Ko Padome dara', destination: 'https://consilium.europa.eu/', description: '' }] }, sourceRef: REF(13), notes: [] },
          { intent: { kind: 'attachment-placeholder', label: 'Kontrolsaraksts', file: 'kontrolsaraksts.pdf' }, sourceRef: REF(14), notes: [] },
          { intent: { kind: 'banner', label: 'Kopsavilkums' }, sourceRef: REF(15), notes: [] },
          { intent: { kind: 'text', paragraphs: ['<p>Kopsavilkuma teksts.</p>'] }, sourceRef: REF(16), notes: [] },
        ],
      },
      {
        title: '1.4.2. COREPER',
        icon: 'Quiz',
        blocks: [
          { intent: { kind: 'text', heading: 'Ar virsrakstu', paragraphs: ['<p>Nav ievada.</p>'] }, sourceRef: REF(20), notes: [] },
          { intent: { kind: 'video-placeholder', label: 'Video bez URL' }, sourceRef: REF(21), notes: [] },
          { intent: { kind: 'continue', label: 'BEIGT' }, sourceRef: REF(22), notes: [] },
        ],
      },
    ],
    assets: [],
    unresolved: [],
    production: [],
  };
}

function file(name: string, mime = 'image/png'): ResolvedFile {
  const bytes = new TextEncoder().encode(`bytes-of-${name}`);
  return {
    name,
    bytes,
    sha256: `sha-${name.replace(/\W/g, '')}`,
    ext: name.split('.').pop()!,
    mimeType: mime,
    size: bytes.byteLength,
    width: mime.startsWith('image/') ? 556 : null,
    height: mime.startsWith('image/') ? 556 : null,
  };
}

type B = Record<string, unknown> & { items: Record<string, unknown>[]; settings: Record<string, unknown> };

describe('compileCourseBlueprint with a style profile', () => {
  const style = profile();
  const files = new Map<string, ResolvedFile>([
    ['1.4.1.1.png', file('1.4.1.1.png')],
    ['1.4.1.4.png', file('1.4.1.4.png')],
    ['kontrolsaraksts.pdf', file('kontrolsaraksts.pdf', 'application/pdf')],
  ]);
  const built = compileCourseBlueprint(blueprint(), '2026-09-14T12:00:00Z', mints(), () => 'X', { style, files });
  const doc = JSON.parse(built.raw) as { course: Record<string, unknown>; lessons: { type: string; icon?: string; title: string; items: B[] }[] };
  const [section, l1, l2] = doc.lessons;
  const variants = (l: { items: B[] }) => l.items.map((b) => `${b.family}/${b.variant}`);

  it('clones the theme + fonts + label set + cover/logo and rewrites the published title', () => {
    const theme = doc.course.theme as { themeId: string; mightyPowerups: { tagName: string; data: Record<string, unknown> }[] };
    expect(theme.themeId).toBe('organic');
    const pub = theme.mightyPowerups.find((p) => p.tagName === 'mighty-powerup-published-course-title')!;
    expect(pub.data.publishedCourseTitle).toBe('1.4. ES Padomes struktūra');
    expect(doc.course.headingTypefaceId).toBe('tf-SourceSansPro');
    expect(doc.course.labelSetId).toBe('OB-YT24aYbEb8J5atoVsQFJY');
    expect(JSON.stringify(doc.course.coverImage)).toContain('rise/courses/crsA/cover.png');
    expect(built.styleName).toBe('VAS test');
  });

  it('emits section dividers and lesson icons (blueprint icon beats the profile default)', () => {
    expect(section).toMatchObject({ type: 'section', title: '1. modulis | Nodaļa 4/4', items: [] });
    expect(l1!.icon).toBe('Article');
    expect(l2!.icon).toBe('Quiz');
  });

  it('opens each lesson with the house opener: title as H1, intro consumed into the illustrated aside, sentence-case Continue', () => {
    expect(variants(l1!).slice(0, 4)).toEqual(['text/paragraph', 'text/heading', 'image/text aside', 'continue/continue']);
    const [, heading, aside, cont] = l1!.items;
    expect(heading!.items[0]!.heading).toBe(
      `<p><span class="mighty-type-style-${TYPE_IDS.h1}"><strong>1.4.1. Padomes struktūra</strong></span></p>`,
    );
    expect(aside!.items[0]!.paragraph).toBe(`<p><span class="mighty-type-style-${TYPE_IDS.body}">Ievads par Padomi.</span></p>`);
    const media = aside!.items[0]!.media as { image: Record<string, unknown> };
    expect(media.image.key).toMatch(/^rise\/courses\/sb-X\/.+\.png$/);
    expect(media.image.originalUrl).toBe('1.4.1.1.png');
    expect(media.image.dimensions).toEqual({ originalWidth: 556, originalHeight: 556 });
    expect(cont!.items[0]!.title).toBe('Turpināt');
    // The consumed intro is NOT emitted again as a paragraph block.
    expect(l1!.items.filter((b) => JSON.stringify(b).includes('Ievads par Padomi')).length).toBe(1);
  });

  it('keeps the opener when a lesson has no plain intro: the aside is left out and noted', () => {
    expect(variants(l2!).slice(0, 3)).toEqual(['text/paragraph', 'text/heading', 'continue/continue']);
    expect(built.notes.some((n) => /1\.4\.2\. COREPER.*illustrated intro was left out/.test(n))).toBe(true);
  });

  it('turns a text block with an image into the image + text aside donor, with heading and body classes', () => {
    const aside2 = l1!.items.filter((b) => b.variant === 'text aside')[1]!;
    expect(String(aside2.items[0]!.paragraph)).toContain(`mighty-type-style-${TYPE_IDS.h2}"><strong>Līmeņi</strong>`);
    expect(String(aside2.items[0]!.paragraph)).toContain(`<p><span class="mighty-type-style-${TYPE_IDS.body}">Trīs līmeņi.</span></p>`);
    expect((aside2.items[0]!.media as { image: { originalUrl: string } }).image.originalUrl).toBe('1.4.1.4.png');
  });

  it('substitutes the Mighty video card, filling the YouTube id from the url or leaving the VIDEO_ID slot', () => {
    const cards = doc.lessons.flatMap((l) => l.items).filter((b) => 'mightyBlockConfig' in b.settings);
    expect(cards).toHaveLength(2);
    const html = (b: B) => String((b.settings.mightyBlockConfig as { data: { directHtml: string } }).data.directHtml);
    expect(html(cards[0]!)).toContain('embed/dQw4w9WgXcQ?');
    expect(html(cards[1]!)).toContain('embed/VIDEO_ID?');
    expect(cards[0]!.settings.backgroundType).toBe('ACCENT');
    expect((cards[0]!.settings.mightyBlockConfig as { id: string }).id).not.toBe('7e9538a6-8cc7-4808-ba94-88b17f9e34e5');
    expect(built.notes.some((n) => /VIDEO_ID slot/.test(n))).toBe(true);
    // The mapper's own "empty native video block" note belongs to the REPLACED mapping.
    expect(built.notes.some((n) => /Tukšs video bloks/.test(n))).toBe(false);
  });

  it('substitutes banner, quote and attachment donors and fills their slots', () => {
    const banners = l1!.items.filter((b) => b.variant === 'text overlay');
    expect(banners).toHaveLength(2);
    expect(String(banners[0]!.items[0]!.caption)).toContain(`mighty-type-style-${TYPE_IDS.h1White}"><strong>Pārbaudi savas zināšanas!</strong>`);
    // Unknown label → the most common banner picture; "Kopsavilkums" → its own.
    expect((banners[0]!.items[0]!.media as { image: { key: string } }).image.key).toBe('rise/courses/crsA/01.jpg');
    expect(String(banners[1]!.items[0]!.caption)).toContain('Kopsavilkums');
    const q = l1!.items.find((b) => b.variant === 'd')!;
    expect(String(q.items[0]!.paragraph)).toContain('Tēmas padziļināšanai');
    expect(String(q.items[0]!.paragraph)).toContain('Ja vēlies uzzināt vairāk.');
    expect(JSON.stringify(q.items[0]!.avatar)).toContain('rise/courses/crsA/edu.svg');
    const att = l1!.items.find((b) => b.variant === 'attachment')!;
    const file0 = (att.items[0]!.media as { attachment: Record<string, unknown> }).attachment;
    expect(file0.originalUrl).toBe('kontrolsaraksts.pdf');
    expect(file0.mimeType).toBe('application/pdf');
    expect(String(file0.key)).toMatch(/^rise\/courses\/sb-X\/.+\.pdf$/);
    expect(JSON.stringify(att.items[1])).toContain('rise/courses/crsA/icon.svg');
  });

  it('stamps body/heading type styles and merges the settings modes + KC colours on ordinary blocks', () => {
    const list = l1!.items.find((b) => b.variant === 'bulleted')!;
    expect(String(list.items[0]!.paragraph)).toBe(`<p><span class="mighty-type-style-${TYPE_IDS.body}">A</span></p>`);
    const kcs = l1!.items.filter((b) => b.family === 'knowledgeCheck');
    expect(kcs).toHaveLength(2);
    expect(kcs[0]!.settings).toMatchObject({ paddingTop: 3, paddingBottom: 3, correctAnswerColor: '#0066cc', incorrectAnswerColor: '#434656' });
    expect(String(kcs[0]!.items[0]!.title)).toContain(`mighty-type-style-${TYPE_IDS.body}`);
    const heading = l1!.items.find((b) => b.variant === 'heading paragraph' && JSON.stringify(b).includes('Sastāvi'))!;
    expect(heading.settings).toMatchObject({ textWidth: 92 });
    expect(String(heading.items[0]!.heading)).toContain(`mighty-type-style-${TYPE_IDS.h2}`);
  });

  it('runs the band rhythm: alternation per topic group, hint wins, banners white, video accent, continue inherits', () => {
    const band = (b: B) => (b.settings.backgroundType === 'COLOR' ? 'light' : b.settings.backgroundType === 'ACCENT' ? 'accent' : 'white');
    const items = l1!.items;
    // opener paragraph keeps its donor light band; heading/aside/continue their donor white.
    expect(band(items[0]!)).toBe('light');
    expect(band(items[1]!)).toBe('white');
    // first content group (image+text "Līmeņi") → white; video → accent;
    // "Sastāvi" hinted light; list → white; banner → white; KC group alternates …
    const bands = items.slice(4).map(band);
    expect(bands.slice(0, 5)).toEqual(['white', 'accent', 'light', 'white', 'white']);
    const closer = items.at(-1)!;
    expect(closer.family).toBe('continue');
    expect(band(closer)).toBe(band(items.at(-2)!));
  });

  it('closes lessons with the "next topic" Continue, or the plain label on the last lesson; an explicit continue is kept (sentence-cased)', () => {
    expect(l1!.items.at(-1)!.items[0]!.title).toBe('Nākamā tēma: 1.4.2. COREPER');
    expect(l2!.items.at(-1)!.items[0]!.title).toBe('Beigt');
    expect(l2!.items.filter((b) => b.family === 'continue')).toHaveLength(2); // opener + explicit
  });

  it('declares every referenced media key in the asset manifest, ships folder bytes, and passes the clean-document gate', () => {
    const manifest = JSON.parse(built.assetManifestJson!) as AssetManifest;
    expect(manifest.ownerId).toBe('sb-X');
    const declared = new Set(manifest.assets.map((a) => a.key));
    for (const k of collectAssetKeys(doc, 'sb-X')) expect(declared.has(k.key), k.key).toBe(true);
    // profile assets → already-present files; folder files → bytes carried
    expect(built.profileAssetFiles.length).toBeGreaterThan(0);
    expect(built.assetFiles.map((f) => f.name).sort()).toEqual(
      ['sha-1411png.png', 'sha-1414png.png', 'sha-kontrolsarakstspdf.pdf'].sort(),
    );
    expect(manifest.assets.find((a) => a.file === 'assets/sha-1411png.png')?.kind).toBe('media-image');
    expect(manifest.assets.find((a) => a.file === 'assets/sha-kontrolsarakstspdf.pdf')?.kind).toBe('media-other');
    expect(() => assertCleanDocument(doc, declared)).not.toThrow();
    expect(() => assertCleanDocument(doc)).toThrow(/media key/);
  });

  it('feeds the import planner: media patches for the declared keys, no flags', () => {
    const manifest = JSON.parse(built.assetManifestJson!) as AssetManifest;
    const steps = buildPlan({
      course: doc,
      assets: manifest.assets.map((a) => ({ key: a.key, kind: a.kind, file: a.file, ext: a.ext, size: a.size })),
      banksById: new Map(),
      author: 'a',
    });
    const kinds = steps.map((s) => s.kind);
    expect(kinds).toContain('create-course');
    expect(kinds.filter((k) => k === 'create-lesson')).toHaveLength(3);
    expect(kinds).toContain('set-theme');
    expect(kinds.some((k) => /media/.test(k))).toBe(true);
    expect(kinds.filter((k) => /flag-unsupported/.test(k))).toEqual([]);
  });

  it('notes an image name the folder lacks and compiles without it', () => {
    const bp = blueprint();
    bp.lessons[1]!.image = 'nope.png';
    const b2 = compileCourseBlueprint(bp, 't', mints(), () => 'Y', { style, files });
    expect(b2.notes.some((n) => /"nope\.png" is not in the connected asset folder/.test(n))).toBe(true);
    expect(b2.notes.some((n) => /style source's illustration/.test(n))).toBe(true);
  });

  it('without a profile: quote and banner fall back to plain text/heading blocks and nothing is declared', () => {
    const plain = compileCourseBlueprint(blueprint(), 't', mints(), () => 'Z');
    const d = JSON.parse(plain.raw) as { lessons: { items: B[] }[] };
    const vs = d.lessons[1]!.items.map((b) => `${b.family}/${b.variant}`);
    expect(vs).toContain('text/heading');
    expect(vs).not.toContain('image/text overlay');
    expect(vs).not.toContain('quote/d');
    expect(plain.assetManifestJson).toBeNull();
    expect(plain.styleName).toBeNull();
  });
});
