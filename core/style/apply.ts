// Apply a StyleProfile to the compiler's mapped output (v0.9.12).
//
// Order per lesson: opener donors (H1 = lesson title, illustrated intro =
// the lesson's first text block) › the mapped blocks (typography stamped,
// settings modes merged, motif donors substituted for banner / quote / video /
// image+text / attachment intents) › the closing Continue. Then the band
// rhythm runs over the whole lesson. Every donor instance gets fresh ids.
//
// Media: donors keep their SOURCE keys (rise/courses/<styleSource>/…) — they
// resolve through the profile's asset rows; folder images get a key under the
// compiled course id. The compiler declares both in the course's asset
// manifest so the standard importer uploads and remaps them.

import type { BlueprintBlock, BlueprintLesson, CourseBlueprint } from '@/core/creator/blueprint';
import type { Mints } from '@/core/storyboard/map';
import type { Block, GetCourseDocument } from '@/shared/types/rise';
import { normalizeLabel } from './harvest';
import {
  decorateBlockText,
  decorateHeadingHtml,
  decorateParagraphHtml,
  sentenceCase,
  typeClass,
} from './typography';
import { VIDEO_ID_TOKEN, variantKey, type Band, type StyleProfile } from './types';

/** A file from the operator's asset folder, resolved by exact file name. */
export interface ResolvedFile {
  name: string;
  bytes: Uint8Array;
  sha256: string;
  ext: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
}

export interface UsedFile {
  key: string;
  file: ResolvedFile;
}

export interface ApplyContext {
  profile: StyleProfile;
  mints: Mints;
  courseId: string;
  /** Exact file name → resolved bytes (the Review page reads the folder). */
  files: Map<string, ResolvedFile>;
  /** Filled by the applier: minted key → file, for the asset manifest. */
  usedFiles: Map<string, UsedFile>;
  notes: string[];
}

export interface MappedForStyle {
  blocks: Block[];
  /** For each mapped Rise block, the index of the blueprint block it came from. */
  blueprintIndex: number[];
}

// --- helpers ----------------------------------------------------------------

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fresh client ids on a donor instance: the block id, every nested item id
 *  (uuid-shaped ids stay uuid-shaped), and Mighty's per-block config id. */
export function instantiateDonor(donor: Block, mints: Mints): Block {
  const b = clone(donor) as Record<string, unknown>;
  b.id = mints.cuid();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isObj(node)) return;
    if (typeof node.id === 'string') node.id = UUID.test(node.id) ? mints.uuid() : mints.cuid();
    for (const v of Object.values(node)) walk(v);
  };
  walk(b.items);
  const s = isObj(b.settings) ? b.settings : null;
  if (s && isObj(s.mightyBlockConfig)) s.mightyBlockConfig.id = mints.uuid();
  return b as Block;
}

function firstItem(block: Block): Record<string, unknown> | null {
  const it = Array.isArray(block.items) ? block.items[0] : undefined;
  return isObj(it) ? it : null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mimeExt(file: ResolvedFile): string {
  return file.ext || 'bin';
}

/** Mint an uploaded-media key under the compiled course for a folder file
 *  (one key per file — the same file used twice shares the bytes). */
function keyFor(ctx: ApplyContext, file: ResolvedFile): string {
  for (const [key, used] of ctx.usedFiles) if (used.file.sha256 === file.sha256) return key;
  const key = `rise/courses/${ctx.courseId}/${ctx.mints.cuid().slice(-16)}.${mimeExt(file)}`;
  ctx.usedFiles.set(key, { key, file });
  return key;
}

/** A Rise image media object for a folder file (donor field set, minus the
 *  crushed variant — `useCrushedKey:false` renders `key`). */
function imageMedia(ctx: ApplyContext, file: ResolvedFile): Record<string, unknown> {
  const key = keyFor(ctx, file);
  return {
    image: {
      key,
      type: 'image',
      ...(file.width && file.height
        ? { dimensions: { originalWidth: file.width, originalHeight: file.height } }
        : {}),
      isSkipCrush: true,
      originalUrl: file.name,
      sourcedFrom: 'USER',
      useCrushedKey: false,
    },
  };
}

function resolveFile(ctx: ApplyContext, name: string | undefined, where: string): ResolvedFile | null {
  if (!name) return null;
  const f = ctx.files.get(name);
  if (!f) {
    ctx.notes.push(`${where}: image "${name}" is not in the connected asset folder — left out`);
    return null;
  }
  return f;
}

function setBand(block: Block, band: Band, profile: StyleProfile): void {
  const s = isObj(block.settings) ? block.settings : {};
  if (band === 'light') {
    s.backgroundType = 'COLOR';
    s.backgroundColor = profile.bands.lightColor;
  } else if (band === 'accent') {
    s.backgroundType = 'ACCENT';
    s.backgroundColor = null;
  } else {
    s.backgroundType = 'LIGHT';
    s.backgroundColor = null;
  }
  block.settings = s;
}

/** Merge the profile's settings mode for this block type over the mapper's
 *  donor settings (style keys only; the mode never carries band keys). */
function applyVariantSettings(block: Block, profile: StyleProfile): void {
  const mode = profile.blocks[variantKey(block)];
  const s = isObj(block.settings) ? block.settings : {};
  block.settings = mode ? { ...s, ...clone(mode.settings) } : s;
  if (block.family === 'knowledgeCheck' && profile.knowledgeCheck) {
    Object.assign(block.settings as Record<string, unknown>, profile.knowledgeCheck);
  }
  if (block.family === 'continue') {
    const it = firstItem(block);
    if (it && typeof it.title === 'string') it.title = sentenceCase(it.title);
  }
}

function headingHtml(profile: StyleProfile, text: string, role: 'h1' | 'h2' | 'h1White'): string {
  return `<p>${decorateHeadingHtml(`<strong>${escapeHtml(text)}</strong>`, typeClass(profile, role))}</p>`;
}

// --- motif instances --------------------------------------------------------

function openerBlocks(
  ctx: ApplyContext,
  lesson: BlueprintLesson,
  intro: BlueprintBlock | null,
): Block[] {
  const { profile, mints } = ctx;
  const opener = profile.motifs.opener;
  if (!opener) return [];
  const out: Block[] = [];
  opener.blocks.forEach((donor, i) => {
    const b = instantiateDonor(donor, mints);
    if (i === opener.headingIndex) {
      const it = firstItem(b);
      if (it) it.heading = headingHtml(profile, lesson.title, 'h1');
    } else if (i === opener.asideIndex) {
      const it = firstItem(b);
      const image = resolveFile(ctx, lesson.image, `lesson "${lesson.title}" opener`);
      if (!intro && !image) {
        ctx.notes.push(
          `lesson "${lesson.title}": no intro text (first block is not a plain text block) and no lesson image — the illustrated intro was left out`,
        );
        return;
      }
      if (it) {
        it.paragraph = intro && intro.intent.kind === 'text'
          ? decorateParagraphHtml(intro.intent.paragraphs.join(''), typeClass(profile, 'body'))
          : '';
        if (image) it.media = imageMedia(ctx, image);
        else ctx.notes.push(`lesson "${lesson.title}": no lesson image — the opener shows the style source's illustration; replace it in Rise`);
      }
    } else if (i === opener.continueIndex) {
      const it = firstItem(b);
      if (it && typeof it.title === 'string') it.title = sentenceCase(it.title);
    }
    out.push(b);
  });
  return out;
}

function closerBlock(ctx: ApplyContext, nextTitle: string | null): Block | null {
  const { profile, mints } = ctx;
  const closer = profile.motifs.closer;
  if (!closer) return null;
  const b = instantiateDonor(closer.block, mints);
  const it = firstItem(b);
  if (it) {
    it.title = nextTitle && closer.nextLabelPrefix
      ? `${closer.nextLabelPrefix} ${nextTitle}`
      : profile.continueLabel ?? sentenceCase(typeof it.title === 'string' ? it.title : 'Turpināt');
  }
  return b;
}

function bannerBlock(ctx: ApplyContext, block: BlueprintBlock): Block | null {
  const { profile, mints } = ctx;
  if (block.intent.kind !== 'banner' || profile.motifs.banners.length === 0) return null;
  const want = normalizeLabel(block.intent.label);
  const donor =
    profile.motifs.banners.find((d) => {
      const have = normalizeLabel(d.label);
      return have === want || want.startsWith(`${have} `) || have.startsWith(`${want} `);
    }) ?? profile.motifs.banners[0]!;
  const b = instantiateDonor(donor.block, mints);
  const it = firstItem(b);
  if (it) {
    const title = headingHtml(profile, block.intent.label, 'h1White');
    const sub = block.intent.subtitle ? `<p><strong>${escapeHtml(block.intent.subtitle)}</strong></p>` : '';
    it.caption = `${title}${sub}`;
    const image = resolveFile(ctx, block.image, `banner "${block.intent.label}"`);
    if (image) it.media = imageMedia(ctx, image);
  }
  return b;
}

function quoteBlock(ctx: ApplyContext, block: BlueprintBlock): Block | null {
  const { profile, mints } = ctx;
  if (block.intent.kind !== 'quote' || !profile.motifs.quote) return null;
  const b = instantiateDonor(profile.motifs.quote, mints);
  const it = firstItem(b);
  if (it) {
    const heading = block.intent.heading ? headingHtml(profile, block.intent.heading, 'h1') : '';
    it.paragraph = `${heading}${decorateParagraphHtml(block.intent.text, typeClass(profile, 'body'))}`;
    it.name = block.intent.attribution
      ? `<p>${escapeHtml(block.intent.attribution)}</p>`
      : '<p></p>';
  }
  return b;
}

function asideBlock(ctx: ApplyContext, block: BlueprintBlock): Block | null {
  const { profile, mints } = ctx;
  if (block.intent.kind !== 'text' || !profile.motifs.aside) return null;
  const image = resolveFile(ctx, block.image, 'image + text block');
  if (!image) return null;
  const b = instantiateDonor(profile.motifs.aside, mints);
  const it = firstItem(b);
  if (it) {
    const heading = block.intent.heading ? headingHtml(profile, block.intent.heading, 'h2') : '';
    it.paragraph = `${heading}${decorateParagraphHtml(block.intent.paragraphs.join(''), typeClass(profile, 'body'))}`;
    it.media = imageMedia(ctx, image);
    it.caption = '';
  }
  return b;
}

function youtubeId(url: string | undefined): string | null {
  if (!url) return null;
  const m =
    /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?(?:.*&)?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/.exec(url);
  return m?.[1] ?? null;
}

function videoBlock(ctx: ApplyContext, block: BlueprintBlock): Block | null {
  const { profile, mints } = ctx;
  if (block.intent.kind !== 'video-placeholder' || !profile.motifs.video) return null;
  const b = instantiateDonor(profile.motifs.video, mints);
  const s = b.settings as Record<string, unknown>;
  const data = (s.mightyBlockConfig as Record<string, unknown>).data as Record<string, unknown>;
  const id = youtubeId(block.intent.url);
  data.directHtml = String(data.directHtml).split(VIDEO_ID_TOKEN).join(id ?? 'VIDEO_ID');
  if (!id) {
    ctx.notes.push(
      `video "${block.intent.label}": styled YouTube card shipped with the literal VIDEO_ID slot — paste the video id into the Mighty block's HTML in Rise`,
    );
  }
  return b;
}

function attachmentBlock(ctx: ApplyContext, block: BlueprintBlock): Block | null {
  const { profile, mints } = ctx;
  if (block.intent.kind !== 'attachment-placeholder' || !profile.motifs.attachment) return null;
  const file = resolveFile(ctx, block.intent.file, `attachment "${block.intent.label}"`);
  if (!file) return null;
  const b = instantiateDonor(profile.motifs.attachment, mints);
  const it = firstItem(b);
  if (it) {
    const key = keyFor(ctx, file);
    it.media = {
      attachment: {
        key,
        size: file.size,
        type: 'attachment',
        filename: key.split('/').pop(),
        mimeType: file.mimeType,
        originalUrl: file.name,
      },
    };
  }
  return b;
}

// --- band rhythm ------------------------------------------------------------

function bandExempt(block: Block): 'banner' | 'video' | 'continue' | null {
  const k = variantKey(block);
  if (k === 'image/text overlay' || k === 'image/banner' || k === 'image/hero') return 'banner';
  if (block.family === 'multimedia' && block.variant === 'video') return 'video';
  const s = isObj(block.settings) ? block.settings : {};
  if ('mightyBlockConfig' in s) return 'video';
  if (block.family === 'continue') return 'continue';
  return null;
}

/** Designer's rule: the opener paragraph is light, then white and light
 *  alternate per topic group (= per blueprint block), a Continue inherits its
 *  neighbour's band, banners sit on white and restart the alternation, video
 *  cards are always accent. An explicit `band` hint wins for its group. */
function applyBands(
  blocks: Block[],
  groupOf: (Block | null)[],
  hints: (Band | undefined)[],
  openerCount: number,
  profile: StyleProfile,
): void {
  let next: Band = 'white';
  let current: Band = 'white';
  let lastGroup: unknown = Symbol('none');
  blocks.forEach((b, i) => {
    if (i < openerCount) return; // donors carry their own bands
    const exempt = bandExempt(b);
    if (exempt === 'banner') {
      setBand(b, 'white', profile);
      current = 'white';
      next = 'white';
      lastGroup = groupOf[i];
      return;
    }
    if (exempt === 'video') {
      setBand(b, 'accent', profile);
      current = 'accent';
      lastGroup = groupOf[i];
      return;
    }
    if (exempt === 'continue') {
      setBand(b, current === 'accent' ? 'white' : current, profile);
      lastGroup = groupOf[i];
      return;
    }
    const sameGroup = groupOf[i] !== null && groupOf[i] === lastGroup;
    const band: Band = sameGroup ? current : (hints[i] ?? next);
    setBand(b, band, profile);
    current = band;
    if (!sameGroup) next = band === 'light' ? 'white' : 'light';
    lastGroup = groupOf[i];
  });
}

// --- lesson ------------------------------------------------------------------

export interface StyledLesson {
  blocks: Block[];
  /** Blueprint index per emitted block (null for motif blocks). */
  blueprintIndex: (number | null)[];
  /** Blueprint blocks whose mapped output was REPLACED by a donor (or
   *  consumed into the opener) — their mapper notes no longer apply. */
  replaced: Set<number>;
}

export function styleLesson(
  ctx: ApplyContext,
  lesson: BlueprintLesson,
  mapped: MappedForStyle,
  nextTitle: string | null,
): StyledLesson {
  const { profile } = ctx;
  if (lesson.type === 'section') return { blocks: [], blueprintIndex: [], replaced: new Set() };

  // The lesson's first plain text block becomes the illustrated intro when the
  // opener motif has an aside slot.
  const first = lesson.blocks[0];
  const consumeIntro =
    !!profile.motifs.opener &&
    profile.motifs.opener.asideIndex != null &&
    !!first &&
    first.intent.kind === 'text' &&
    !first.intent.heading &&
    !first.image;

  const out: Block[] = [];
  const groupOf: (Block | null)[] = [];
  const hints: (Band | undefined)[] = [];
  const indexOut: (number | null)[] = [];
  const opener = openerBlocks(ctx, lesson, consumeIntro ? first! : null);
  for (const b of opener) {
    out.push(b);
    groupOf.push(null);
    hints.push(undefined);
    indexOut.push(null);
  }

  const replaced = new Set<number>();
  if (consumeIntro) replaced.add(0);
  const groupTokens = lesson.blocks.map(() => ({}));
  lesson.blocks.forEach((bp, bi) => {
    if (consumeIntro && bi === 0) return;
    const own = mapped.blocks.filter((_, j) => mapped.blueprintIndex[j] === bi);
    const donor =
      bannerBlock(ctx, bp) ??
      quoteBlock(ctx, bp) ??
      asideBlock(ctx, bp) ??
      videoBlock(ctx, bp) ??
      attachmentBlock(ctx, bp);
    const emitted = donor ? [donor] : own;
    if (donor) replaced.add(bi);
    if (!donor) {
      for (const b of emitted) {
        decorateBlockText(b as Record<string, unknown>, profile, 'h2');
        applyVariantSettings(b, profile);
      }
    }
    for (const b of emitted) {
      out.push(b);
      groupOf.push(groupTokens[bi]!);
      hints.push(bp.band);
      indexOut.push(bi);
    }
  });

  const lastIntent = lesson.blocks.at(-1)?.intent.kind;
  if (lastIntent !== 'continue') {
    const closer = closerBlock(ctx, nextTitle);
    if (closer) {
      out.push(closer);
      groupOf.push(null);
      hints.push(undefined);
      indexOut.push(null);
    }
  }

  applyBands(out, groupOf, hints, opener.length, profile);
  return { blocks: out, blueprintIndex: indexOut, replaced };
}

// --- course -----------------------------------------------------------------

/** Course-level fields from the profile; the published-title power-up (a
 *  per-course string inside the theme) is rewritten to this course's title. */
export function applyCourseStyle(
  doc: GetCourseDocument,
  blueprint: CourseBlueprint,
  profile: StyleProfile,
): void {
  const course = doc.course as Record<string, unknown>;
  const c = profile.course;
  if (c.theme) {
    const theme = clone(c.theme);
    const powerups = Array.isArray(theme.mightyPowerups) ? theme.mightyPowerups : [];
    for (const p of powerups) {
      if (isObj(p) && p.tagName === 'mighty-powerup-published-course-title' && isObj(p.data)) {
        p.data.publishedCourseTitle = blueprint.title;
      }
    }
    course.theme = theme;
  }
  if (c.headingTypefaceId) course.headingTypefaceId = c.headingTypefaceId;
  if (c.bodyTypefaceId) course.bodyTypefaceId = c.bodyTypefaceId;
  if (c.uiTypefaceId) course.uiTypefaceId = c.uiTypefaceId;
  if (c.labelSetId) course.labelSetId = c.labelSetId;
  if (c.coverImage) course.coverImage = clone(c.coverImage);
  if (c.cardImage) course.cardImage = clone(c.cardImage);
  if (c.media) course.media = clone(c.media);
  if (c.lessonHeaderImage) course.lessonHeaderImage = clone(c.lessonHeaderImage);
  if (c.settings) course.settings = clone(c.settings);
}
