// Style harvest — derive a StyleProfile from one or more EXPORTED courses
// (archive `courses/<id>.json` + `<id>.assets.json`). Pure: the caller reads
// the archive and copies asset bytes; this module only looks at JSON.
//
// The first course is PRIMARY (theme, fonts, cover, logo, label set); every
// course contributes to the block-settings modes, the motif detection and the
// banner vocabulary. Nothing here is invented: settings are per-key MODES of
// what the designer actually saved, donors are verbatim blocks (ids stripped).
// Findings that shape the rules (VAS 1.1/1.2/1.3, 2026-09-13/14) are in
// docs/creator-ai-design.md "Style harvest".

import type { AssetManifest } from '@/core/assets/manifest';
import { collectAssetKeys } from '@/core/assets/keys';
import type { Block, GetCourseDocument, Lesson } from '@/shared/types/rise';
import { sentenceCase } from './typography';
import {
  LESSON_ICONS,
  STYLE_PROFILE_FORMAT,
  STYLE_PROFILE_VERSION,
  VIDEO_ID_TOKEN,
  variantKey,
  type BannerDonor,
  type LessonIcon,
  type OpenerMotif,
  type StyleAsset,
  type StyleBlockSettings,
  type StyleProfile,
  type TypeRole,
  type TypeStyle,
} from './types';

export interface HarvestCourseInput {
  doc: GetCourseDocument;
  assetManifest: AssetManifest | null;
}

export interface HarvestOptions {
  name: string;
  /** courses[0] is the primary (theme/fonts/images source). */
  courses: HarvestCourseInput[];
  toolVersion: string;
  harvestedAt: string;
}

export interface HarvestResult {
  profile: StyleProfile;
  /** Human-readable findings for the operator (what was harvested, what was skipped). */
  report: string[];
}

// --- generic helpers --------------------------------------------------------

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function mode<T>(values: T[]): T | null {
  const counts = new Map<string, { n: number; v: T }>();
  for (const v of values) {
    const k = JSON.stringify(v);
    const e = counts.get(k);
    if (e) e.n++;
    else counts.set(k, { n: 1, v });
  }
  let best: { n: number; v: T } | null = null;
  for (const e of counts.values()) if (!best || e.n > best.n) best = e;
  return best ? best.v : null;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A block ready to be a donor: block-level bookkeeping removed, ids kept as
 *  placeholders (the compiler re-mints every id when it instantiates). */
export function stripDonor(block: Block): Block {
  const out = clone(block) as Record<string, unknown>;
  delete out.id;
  delete out.globalBlockId;
  delete out.createdAt;
  delete out.updatedAt;
  if (isObj(out.data) && Object.keys(out.data).length === 0) delete out.data;
  if (isObj(out.background) && Object.keys(out.background).length === 0) delete out.background;
  return out as Block;
}

/** Content lessons in display order. */
export function contentLessons(doc: GetCourseDocument): Lesson[] {
  const lessons = [...(doc.lessons ?? [])];
  lessons.sort((a, b) => (Number(a.position ?? 0) || 0) - (Number(b.position ?? 0) || 0));
  return lessons.filter((l) => (l.type ?? 'blocks') === 'blocks' && Array.isArray(l.items));
}

function blocksOf(lesson: Lesson): Block[] {
  return (lesson.items ?? []) as Block[];
}

function settingsOf(block: Block): Record<string, unknown> {
  return isObj(block.settings) ? block.settings : {};
}

// --- settings ---------------------------------------------------------------

/** Style-only settings keys. Band keys (backgroundType/backgroundColor) are
 *  handled by the rhythm rule; content/behaviour keys are never copied. */
const STYLE_KEYS = new Set([
  'v',
  'paddingTop',
  'paddingBottom',
  'paddingLinked',
  'customPaddingTop',
  'customPaddingBottom',
  'customPaddingLinked',
  'attachedToNextBlock',
  'markerColorContrast',
  'snippetColorContrast',
  'customBackgroundColorContrast',
  'continueColorContrast',
  'accentContrast',
  'textWidth',
  'textPadding',
  'listWidth',
  'bulletPadding',
  'tableWidth',
  'cellPadding',
  'knowledgeCheckWidth',
  'quoteWidth',
  'quotePadding',
  'quotesInline',
  'avatar',
  'avatarSize',
  'imageSize',
  'imagePosition',
  'mediaWidth',
  'contentWidth',
  'buttonWidth',
  'buttonSpacing',
  'buttonAlignment',
  'buttonShowDescription',
  'continueRadius',
  'cornerRadius',
  'buttonRadius',
  'cardMode',
  'entranceAnimation',
  'zoomOnClick',
  'flashcardSize',
  'audioPosition',
  'opacity',
  'opacityColor',
  'markerColor',
  'accentColor',
  'mightyMods',
]);

const BAND_KEYS = new Set(['backgroundType', 'backgroundColor']);

function harvestBlockSettings(blocks: Block[]): Record<string, StyleBlockSettings> {
  const byVariant = new Map<string, Record<string, unknown>[]>();
  for (const b of blocks) {
    const s = settingsOf(b);
    if ('mightyBlockConfig' in s) continue; // Mighty custom-code blocks are motif donors
    const k = variantKey(b);
    const list = byVariant.get(k) ?? [];
    list.push(s);
    byVariant.set(k, list);
  }
  const out: Record<string, StyleBlockSettings> = {};
  for (const [k, list] of byVariant) {
    const keys = new Set<string>();
    for (const s of list) for (const key of Object.keys(s)) keys.add(key);
    const settings: Record<string, unknown> = {};
    for (const key of keys) {
      if (!STYLE_KEYS.has(key) || BAND_KEYS.has(key)) continue;
      const values = list.filter((s) => key in s).map((s) => s[key]);
      // A key half the blocks omit is not a rule — require a majority carrying it.
      if (values.length * 2 < list.length) continue;
      const m = mode(values);
      if (m !== null) settings[key] = m;
    }
    out[k] = { count: list.length, settings };
  }
  return out;
}

// --- typography (Mighty global styles) ---------------------------------------

const ROLE_MATCHERS: [TypeRole, RegExp][] = [
  ['h1White', /^h1\s*white$/i],
  ['h1', /^h1$/i],
  ['h2Gray', /^h2\s*gr[ae]y$/i],
  ['h2', /^h2$/i],
  ['h3', /^h3$/i],
  ['boldBody', /^bold\s*body/i],
  ['body', /^body/i],
];

function harvestTypography(theme: Record<string, unknown> | null): StyleProfile['typography'] {
  const styles: TypeStyle[] = [];
  const roles: Partial<Record<TypeRole, string>> = {};
  const powerups = Array.isArray(theme?.mightyPowerups) ? theme!.mightyPowerups : [];
  for (const p of powerups) {
    if (!isObj(p) || p.tagName !== 'mighty-powerup-global-styles' || !isObj(p.data)) continue;
    const type = isObj(p.data.type) ? p.data.type : null;
    const custom = isObj(type?.styles) && Array.isArray(type!.styles.customStyles)
      ? (type!.styles.customStyles as unknown[])
      : [];
    for (const raw of custom) {
      if (!isObj(raw) || typeof raw.id !== 'string') continue;
      const sizes = isObj(raw.fontSizes) ? raw.fontSizes : {};
      const style: TypeStyle = {
        id: raw.id,
        name: typeof raw.name === 'string' ? raw.name : raw.id,
        className: `mighty-type-style-${raw.id}`,
        fontSizePx: typeof sizes.desktop === 'number' ? sizes.desktop : null,
        color: typeof raw.color === 'string' ? raw.color : null,
        fontWeight: typeof raw.fontWeight === 'string' ? raw.fontWeight : null,
      };
      styles.push(style);
      for (const [role, re] of ROLE_MATCHERS) {
        if (!roles[role] && re.test(style.name.trim())) {
          roles[role] = style.id;
          break;
        }
      }
    }
  }
  return { styles, roles };
}

// --- motifs -----------------------------------------------------------------

const OPENER_MIN_SHARE = 0.5;
/** A Continue right after the shared prefix counts as part of the opener when
 *  at least this share of lessons has it there (VAS 1.2: half the lessons put
 *  a hero image or a note in that slot instead — content, not opener). */
const OPENER_CONTINUE_SHARE = 0.34;

function isContinue(b: Block): boolean {
  return b.family === 'continue';
}

/** Block types an opener donor may consist of: a fixed label paragraph, the
 *  title heading, the illustrated intro, the Continue. Anything else (a note,
 *  a hero picture, a video) is lesson CONTENT and ends the prefix — copying
 *  it into every generated lesson would duplicate the source's words. */
const OPENER_VARIANTS = new Set(['text/paragraph', 'text/heading', 'image/text aside', 'continue/continue']);

function blockText(b: Block): string {
  return stripTags(
    (Array.isArray(b.items) ? b.items : [])
      .map((it) => (isObj(it) ? [it.heading, it.paragraph].filter((x) => typeof x === 'string').join(' ') : ''))
      .join(' '),
  );
}

/** Longest variant prefix shared by a majority of lessons (safe block types
 *  only; a label paragraph must carry the SAME text in every lesson), plus
 *  the Continue that commonly follows it. Accepted when it carries a heading
 *  or an aside — otherwise the lessons simply do not share an opener. */
function detectOpener(lessons: Lesson[]): OpenerMotif | null {
  const seqs = lessons.map((l) => blocksOf(l));
  if (seqs.length < 2) return null;
  const prefix: string[] = [];
  let continueAt: number | null = null;
  for (let i = 0; i < 6; i++) {
    const at = seqs.map((s) => (s[i] ? variantKey(s[i]!) : null)).filter((v): v is string => !!v);
    const m = mode(at);
    const share = m ? at.filter((v) => v === m).length / seqs.length : 0;
    if (m === 'continue/continue' && share >= OPENER_CONTINUE_SHARE) {
      continueAt = i;
      break;
    }
    if (!m || share < OPENER_MIN_SHARE || !OPENER_VARIANTS.has(m)) break;
    if (m === 'text/paragraph') {
      // A fixed label ("Ritini uz leju!") repeats verbatim; prose does not.
      const texts = seqs.map((s) => (s[i] && variantKey(s[i]!) === m ? blockText(s[i]!) : null)).filter((t): t is string => !!t);
      const t = mode(texts);
      if (!t || texts.filter((x) => x === t).length < seqs.length * OPENER_MIN_SHARE) break;
    }
    prefix.push(m);
  }
  const headingIndex = prefix.indexOf('text/heading');
  const asideIndex = prefix.indexOf('image/text aside');
  if (prefix.length < 2 || (headingIndex < 0 && asideIndex < 0)) return null;
  const full = continueAt !== null ? [...prefix, 'continue/continue'] : prefix;
  // Donor = the first lesson whose blocks match the whole opener.
  const donorSeq = seqs.find((s) => full.every((v, i) => s[i] && variantKey(s[i]!) === v));
  if (!donorSeq) return null;
  return {
    blocks: full.map((_, i) => stripDonor(donorSeq[i]!)),
    headingIndex: headingIndex >= 0 ? headingIndex : null,
    asideIndex: asideIndex >= 0 ? asideIndex : null,
    continueIndex: continueAt !== null ? full.length - 1 : null,
  };
}

function continueTitle(b: Block): string | null {
  const it = Array.isArray(b.items) ? (b.items[0] as Record<string, unknown> | undefined) : undefined;
  return it && typeof it.title === 'string' ? it.title : null;
}

function detectCloser(lessons: Lesson[]): StyleProfile['motifs']['closer'] {
  const lasts = lessons.map((l) => blocksOf(l).at(-1)).filter((b): b is Block => !!b && isContinue(b));
  if (lasts.length < Math.max(2, lessons.length * OPENER_MIN_SHARE)) return null;
  const labels = lasts.map(continueTitle).filter((t): t is string => !!t);
  const prefixes = labels
    .map((t) => (t.includes(':') ? t.slice(0, t.indexOf(':') + 1).trim() : null))
    .filter((p): p is string => !!p);
  const prefix = prefixes.length * 2 >= labels.length ? mode(prefixes) : null;
  // Donor = the closer whose label carries the prefix (or the first one).
  const donor = lasts.find((b) => prefix && (continueTitle(b) ?? '').startsWith(prefix)) ?? lasts[0]!;
  return { block: stripDonor(donor), nextLabelPrefix: prefix };
}

function bannerLabel(block: Block): string {
  const it = Array.isArray(block.items) ? (block.items[0] as Record<string, unknown> | undefined) : undefined;
  const caption = it && typeof it.caption === 'string' ? it.caption : '';
  const firstP = /<p[^>]*>([\s\S]*?)<\/p>/.exec(caption)?.[1] ?? caption;
  return stripTags(firstP).replace(/[.:;,]+$/, '');
}

export function normalizeLabel(label: string): string {
  return label
    .toLocaleLowerCase('lv')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectBanners(blocks: Block[]): BannerDonor[] {
  const groups = new Map<string, { label: string; count: number; block: Block }>();
  for (const b of blocks) {
    if (variantKey(b) !== 'image/text overlay') continue;
    const label = bannerLabel(b);
    if (!label) continue;
    // "Kopsavilkums: politiskā…" and "Kopsavilkums" share the first word.
    const key = normalizeLabel(label).split(' ')[0] ?? '';
    if (!key) continue;
    const g = groups.get(key);
    if (g) {
      g.count++;
      if (label.length < g.label.length) g.label = label; // the bare form
    } else groups.set(key, { label, count: 1, block: stripDonor(b) });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function detectQuote(blocks: Block[]): Block | null {
  const quotes = blocks.filter((b) => variantKey(b) === 'quote/d');
  const withAvatar = quotes.filter((b) => {
    const it = Array.isArray(b.items) ? (b.items[0] as Record<string, unknown> | undefined) : undefined;
    return !!it && isObj(it.avatar);
  });
  const pool = withAvatar.length > 0 ? withAvatar : quotes;
  if (pool.length === 0) return null;
  const m = mode(pool.map((b) => JSON.stringify(settingsOf(b))));
  return stripDonor(pool.find((b) => JSON.stringify(settingsOf(b)) === m) ?? pool[0]!);
}

function detectAside(blocks: Block[], opener: OpenerMotif | null): Block | null {
  if (opener?.asideIndex != null) return clone(opener.blocks[opener.asideIndex]!);
  const asides = blocks.filter((b) => variantKey(b) === 'image/text aside');
  if (asides.length === 0) return null;
  const m = mode(asides.map((b) => JSON.stringify(settingsOf(b))));
  return stripDonor(asides.find((b) => JSON.stringify(settingsOf(b)) === m) ?? asides[0]!);
}

const RE_EMBED = /(youtube(?:-nocookie)?\.com\/embed\/)([A-Za-z0-9_-]+)/g;

function mightyHtml(b: Block): string | null {
  const s = settingsOf(b);
  const cfg = isObj(s.mightyBlockConfig) ? s.mightyBlockConfig : null;
  const data = cfg && isObj(cfg.data) ? cfg.data : null;
  return data && typeof data.directHtml === 'string' ? data.directHtml : null;
}

/** The designer's YouTube card: a Mighty Interactive-HTML block whose HTML
 *  embeds a YouTube player. Several generations exist in older lessons; the
 *  most-used HTML (whitespace-normalised) wins, its newest instance is the
 *  donor, and the video id becomes VIDEO_ID_TOKEN. */
function detectVideo(blocks: Block[]): Block | null {
  const groups = new Map<string, Block[]>();
  for (const b of blocks) {
    const html = mightyHtml(b);
    if (!html || !RE_EMBED.test(html)) continue;
    RE_EMBED.lastIndex = 0;
    const key = html.replace(RE_EMBED, `$1${VIDEO_ID_TOKEN}`).replace(/\s+/g, ' ').trim();
    const list = groups.get(key) ?? [];
    list.push(b);
    groups.set(key, list);
  }
  let best: Block[] | null = null;
  for (const list of groups.values()) if (!best || list.length > best.length) best = list;
  if (!best) return null;
  const newest = [...best].sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
  )[0]!;
  const donor = stripDonor(newest);
  const s = donor.settings as Record<string, unknown>;
  const cfg = s.mightyBlockConfig as Record<string, unknown>;
  const data = cfg.data as Record<string, unknown>;
  data.directHtml = String(data.directHtml).replace(RE_EMBED, `$1${VIDEO_ID_TOKEN}`);
  return donor;
}

function detectAttachment(blocks: Block[]): Block | null {
  for (const b of blocks) {
    if (variantKey(b) !== 'multimedia/attachment' || !Array.isArray(b.items)) continue;
    const icon = b.items[1] as Record<string, unknown> | undefined;
    const media = icon && isObj(icon.media) ? icon.media : null;
    const att = media && isObj(media.attachment) ? media.attachment : null;
    if (att && typeof att.mimeType === 'string' && att.mimeType.startsWith('image/')) {
      return stripDonor(b);
    }
  }
  return null;
}

// --- assets -----------------------------------------------------------------

function assetIndex(inputs: HarvestCourseInput[]): Map<string, StyleAsset> {
  const idx = new Map<string, StyleAsset>();
  for (const c of inputs) {
    for (const a of c.assetManifest?.assets ?? []) {
      if (!idx.has(a.key)) {
        idx.set(a.key, { key: a.key, kind: a.kind, hash: a.hash, ext: a.ext, file: a.file, size: a.size });
      }
    }
  }
  return idx;
}

/** Keys a donor/course field needs; `null` when one has no archived bytes. */
function resolveKeys(
  value: unknown,
  idx: Map<string, StyleAsset>,
  ownerId: string,
): { assets: StyleAsset[]; missing: string[] } {
  const assets: StyleAsset[] = [];
  const missing: string[] = [];
  for (const ak of collectAssetKeys(value, ownerId)) {
    const a = idx.get(ak.key);
    if (a) assets.push(a);
    else missing.push(ak.key);
  }
  return { assets, missing };
}

// --- main -------------------------------------------------------------------

export function harvestStyleProfile(opts: HarvestOptions): HarvestResult {
  if (opts.courses.length === 0) throw new Error('style harvest needs at least one course');
  const report: string[] = [];
  const primary = opts.courses[0]!;
  const course = (primary.doc.course ?? {}) as Record<string, unknown>;
  const primaryId = typeof course.id === 'string' ? course.id : 'course';
  const theme = isObj(course.theme) ? clone(course.theme) : null;

  const allLessons = opts.courses.flatMap((c) => contentLessons(c.doc));
  const allBlocks = allLessons.flatMap(blocksOf);
  report.push(
    `${opts.courses.length} course(s), ${allLessons.length} content lesson(s), ${allBlocks.length} block(s) harvested`,
  );

  // Course level (primary).
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const typography = harvestTypography(theme);
  report.push(
    typography.styles.length > 0
      ? `Type styles: ${typography.styles.map((s) => s.name).join(', ')} (roles: ${Object.keys(typography.roles).join(', ') || 'none matched'})`
      : 'No Mighty global type styles in the theme — text ships unstyled',
  );

  // Lesson icon.
  const icons = allLessons
    .map((l) => l.icon)
    .filter((i): i is LessonIcon => typeof i === 'string' && (LESSON_ICONS as readonly string[]).includes(i));
  const icon = mode(icons);
  report.push(icon ? `Lesson icon: ${icon} (${icons.length}/${allLessons.length} lessons set one)` : 'Lesson icon: none set — lessons show a dot');

  // Bands.
  const lightColors = allBlocks
    .map(settingsOf)
    .filter((s) => s.backgroundType === 'COLOR' && typeof s.backgroundColor === 'string')
    .map((s) => s.backgroundColor as string);
  const lightColor = mode(lightColors) ?? '#e8efff';
  report.push(`Light band colour: ${lightColor} (${lightColors.length} tinted blocks)`);

  // Block settings.
  const blocks = harvestBlockSettings(allBlocks);
  report.push(`Settings modes for ${Object.keys(blocks).length} block type(s)`);

  // Knowledge-check colours.
  const kcColors = allBlocks
    .filter((b) => b.family === 'knowledgeCheck')
    .map(settingsOf)
    .filter((s) => typeof s.correctAnswerColor === 'string' && typeof s.incorrectAnswerColor === 'string')
    .map((s) => ({
      correctAnswerColor: s.correctAnswerColor as string,
      incorrectAnswerColor: s.incorrectAnswerColor as string,
    }));
  const knowledgeCheck = mode(kcColors);
  report.push(
    knowledgeCheck
      ? `Knowledge-check answer colours: ${knowledgeCheck.correctAnswerColor} / ${knowledgeCheck.incorrectAnswerColor}`
      : 'Knowledge checks: no custom answer colours found',
  );

  // Continue label (mid-lesson).
  const midLabels: string[] = [];
  for (const l of allLessons) {
    const bs = blocksOf(l);
    bs.forEach((b, i) => {
      if (i === bs.length - 1 || !isContinue(b)) return;
      const t = continueTitle(b);
      if (t) midLabels.push(sentenceCase(t));
    });
  }
  const continueLabel = mode(midLabels);

  // Motifs.
  const opener = detectOpener(contentLessons(primary.doc)) ?? detectOpener(allLessons);
  report.push(
    opener
      ? `Lesson opener: ${opener.blocks.map(variantKey).join(' › ')}`
      : 'Lesson opener: no shared opening sequence — lessons start with their own blocks',
  );
  const closer = detectCloser(allLessons);
  report.push(
    closer
      ? `Lesson closer: Continue${closer.nextLabelPrefix ? ` "${closer.nextLabelPrefix} <next lesson>"` : ''}`
      : 'Lesson closer: none detected',
  );
  const banners = detectBanners(allBlocks);
  report.push(
    banners.length > 0
      ? `Banners: ${banners.map((b) => `${b.label} (${b.count})`).join(', ')}`
      : 'Banners: none',
  );
  const quote = detectQuote(allBlocks);
  const aside = detectAside(allBlocks, opener);
  const video = detectVideo(allBlocks);
  const attachment = detectAttachment(allBlocks);
  report.push(
    `Donors: quote ${quote ? '✓' : '—'}, image+text aside ${aside ? '✓' : '—'}, video card ${video ? '✓' : '—'}, attachment ${attachment ? '✓' : '—'}`,
  );

  // Assets: everything the profile's donors and course images reference.
  const idx = assetIndex(opts.courses);
  const assets = new Map<string, StyleAsset>();
  const missing: string[] = [];
  const take = (what: string, value: unknown, ownerId: string): boolean => {
    const r = resolveKeys(value, idx, ownerId);
    if (r.missing.length > 0) {
      missing.push(...r.missing.map((k) => `${what}: ${k}`));
      return false;
    }
    for (const a of r.assets) assets.set(a.key, a);
    return true;
  };
  const courseField = (name: string): unknown => {
    const v = course[name];
    if (v === undefined || v === null) return null;
    if (isObj(v) && Object.keys(v).length === 0) return null;
    return take(`course.${name}`, v, primaryId) ? clone(v) : null;
  };
  const motifs: StyleProfile['motifs'] = {
    opener: opener && opener.blocks.every((b, i) => take(`opener[${i}]`, b, primaryId)) ? opener : null,
    closer: closer && take('closer', closer.block, primaryId) ? closer : null,
    banners: banners.filter((b) => take(`banner "${b.label}"`, b.block, primaryId)),
    quote: quote && take('quote', quote, primaryId) ? quote : null,
    aside: aside && take('aside', aside, primaryId) ? aside : null,
    video: video && take('video', video, primaryId) ? video : null,
    attachment: attachment && take('attachment', attachment, primaryId) ? attachment : null,
  };
  if (opener && !motifs.opener) report.push('Opener dropped: its media has no archived bytes');
  if (missing.length > 0) {
    report.push(`Skipped (no archived bytes): ${missing.join('; ')}`);
  }
  // Theme images: theme-level user uploads are blanked by the importer anyway
  // (docs/rise-api-reference.md §5) — report them so nobody expects them.
  if (theme) {
    const r = resolveKeys(theme, idx, primaryId);
    if (r.assets.length + r.missing.length > 0) {
      report.push(`Theme carries ${r.assets.length + r.missing.length} uploaded image key(s) — the importer blanks theme uploads; set them in Rise`);
    }
  }

  const profile: StyleProfile = {
    format: STYLE_PROFILE_FORMAT,
    formatVersion: STYLE_PROFILE_VERSION,
    name: opts.name,
    harvestedAt: opts.harvestedAt,
    toolVersion: opts.toolVersion,
    sourceCourseIds: opts.courses.map((c) => String((c.doc.course as Record<string, unknown> | undefined)?.id ?? '')),
    sourceTitles: opts.courses.map((c) => {
      const t = (c.doc.course as Record<string, unknown> | undefined)?.title;
      return typeof t === 'string' ? t : '';
    }),
    course: {
      theme,
      headingTypefaceId: str(course.headingTypefaceId),
      bodyTypefaceId: str(course.bodyTypefaceId),
      uiTypefaceId: str(course.uiTypefaceId),
      labelSetId: str(course.labelSetId),
      coverImage: courseField('coverImage'),
      cardImage: courseField('cardImage'),
      media: courseField('media'),
      lessonHeaderImage: courseField('lessonHeaderImage'),
      settings: isObj(course.settings) && Object.keys(course.settings).length > 0 ? clone(course.settings) : null,
    },
    lessons: { icon },
    typography,
    bands: { lightColor },
    blocks,
    knowledgeCheck,
    continueLabel,
    motifs,
    assets: [...assets.values()],
  };
  report.push(`${profile.assets.length} shared asset file(s) referenced by the profile`);
  return { profile, report };
}

/** Parse + shape-check a stored profile (never trust storage blindly). */
export function parseStyleProfile(raw: string): StyleProfile {
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isObj(parsed) ||
    parsed.format !== STYLE_PROFILE_FORMAT ||
    parsed.formatVersion !== STYLE_PROFILE_VERSION ||
    typeof parsed.name !== 'string' ||
    !isObj(parsed.course) ||
    !isObj(parsed.motifs) ||
    !isObj(parsed.blocks) ||
    !Array.isArray(parsed.assets)
  ) {
    throw new Error('Not a rise-style-profile v1 document.');
  }
  return parsed as unknown as StyleProfile;
}
