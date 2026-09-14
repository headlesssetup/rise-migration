// Style profile — the harvested "house style" of a hand-designed Rise course
// (v0.9.12, docs/creator-ai-design.md "Style harvest"). A profile is DATA
// pulled out of exported course JSON, never authored by hand and never seen
// by the AI: the Creator compiler applies it deterministically on top of a
// validated blueprint so a generated course lands close to the designer's
// finished look (theme + Mighty power-ups, fonts/type styles, per-block
// settings, band rhythm, recurring motifs, shared assets).
//
// Everything block-shaped in here is a DONOR copied verbatim from the source
// course (ids stripped) — the same copy-faithful posture as migration. The
// compiler re-mints ids and fills text slots; it never invents a shape.

import type { Block } from '@/shared/types/rise';

export const STYLE_PROFILE_FORMAT = 'rise-style-profile' as const;
export const STYLE_PROFILE_VERSION = 1 as const;

/** Background band of a block: white (Rise LIGHT), the house light tint
 *  (COLOR + hex), or the theme accent (ACCENT — the designer's "dark blue"). */
export type Band = 'white' | 'light' | 'accent';
export const BANDS: readonly Band[] = ['white', 'light', 'accent'];

/** Rise's four lesson icons (the `icon` string on a lesson row; absent = a dot). */
export type LessonIcon = 'Article' | 'Quiz' | 'Video' | 'Interaction';
export const LESSON_ICONS: readonly LessonIcon[] = ['Article', 'Quiz', 'Video', 'Interaction'];

/** One Mighty global type style (theme power-up `mighty-powerup-global-styles`). */
export interface TypeStyle {
  id: string;
  name: string;
  /** The class Mighty stamps on styled spans: `mighty-type-style-<id>`. */
  className: string;
  fontSizePx: number | null;
  color: string | null;
  fontWeight: string | null;
}

/** Semantic roles the compiler needs; resolved from style NAMES at harvest. */
export type TypeRole = 'body' | 'boldBody' | 'h1' | 'h1White' | 'h2' | 'h2Gray' | 'h3';

/** A shared asset the profile's donors/course fields reference — a row of the
 *  source course's `<id>.assets.json`, copied into the Creator folder's
 *  content-addressed `assets/` store at harvest time. */
export interface StyleAsset {
  key: string;
  kind: string;
  hash: string;
  ext: string;
  /** `assets/<hash>.<ext>` */
  file: string;
  size: number;
}

export interface StyleBlockSettings {
  /** Blocks of this family/variant seen across the harvested courses. */
  count: number;
  /** Per-key MODE of the style-only settings (band keys excluded). */
  settings: Record<string, unknown>;
}

export interface BannerDonor {
  /** Display label (first caption line, tags stripped). */
  label: string;
  count: number;
  /** `image/text overlay` donor, ids stripped. */
  block: Block;
}

export interface OpenerMotif {
  /** Donor blocks in order, ids stripped (e.g. "Ritini uz leju!" paragraph,
   *  H1 heading, illustrated aside, Continue). */
  blocks: Block[];
  headingIndex: number | null;
  asideIndex: number | null;
  continueIndex: number | null;
}

export interface StyleMotifs {
  opener: OpenerMotif | null;
  /** The lesson's closing Continue donor + the label prefix used before the
   *  next lesson's title ("Nākamā tēma:"), when one recurs. */
  closer: { block: Block; nextLabelPrefix: string | null } | null;
  banners: BannerDonor[];
  /** `quote/d` deep-dive donor (icon avatar + default background). */
  quote: Block | null;
  /** `image/text aside` donor for mid-lesson image + text blocks. */
  aside: Block | null;
  /** Mighty "Interactive HTML" video card: settings.mightyBlockConfig.data
   *  .directHtml carries the token below where the YouTube id goes. */
  video: Block | null;
  /** `multimedia/attachment` donor (file item + icon item + appearance mods). */
  attachment: Block | null;
}

/** Token the video donor's HTML carries in place of the YouTube video id. */
export const VIDEO_ID_TOKEN = '__VIDEO_ID__';

export interface StyleProfile {
  format: typeof STYLE_PROFILE_FORMAT;
  formatVersion: typeof STYLE_PROFILE_VERSION;
  name: string;
  harvestedAt: string;
  toolVersion: string;
  sourceCourseIds: string[];
  sourceTitles: string[];
  course: {
    /** Verbatim theme incl. Mighty power-ups (custom CSS, global type/color
     *  styles) and mods (font families). Round-trips through UPDATE_COURSE. */
    theme: Record<string, unknown> | null;
    headingTypefaceId: string | null;
    bodyTypefaceId: string | null;
    uiTypefaceId: string | null;
    labelSetId: string | null;
    coverImage: unknown;
    cardImage: unknown;
    /** Cover-page logo (`course.media`). */
    media: unknown;
    lessonHeaderImage: unknown;
    settings: unknown;
  };
  lessons: {
    /** Most common explicit icon on content lessons (designer: Article). */
    icon: LessonIcon | null;
  };
  typography: {
    styles: TypeStyle[];
    /** role → style id */
    roles: Partial<Record<TypeRole, string>>;
  };
  bands: {
    /** The light tint hex (`#e8efff` on VAS). */
    lightColor: string;
  };
  /** "family/variant" → style settings mode. */
  blocks: Record<string, StyleBlockSettings>;
  knowledgeCheck: { correctAnswerColor: string; incorrectAnswerColor: string } | null;
  /** Mid-lesson Continue label, sentence-cased ("Turpināt"). */
  continueLabel: string | null;
  motifs: StyleMotifs;
  assets: StyleAsset[];
}

export function variantKey(block: Block): string {
  return `${String(block.family ?? '')}/${String(block.variant ?? '')}`;
}
