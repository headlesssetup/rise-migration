// Storyline package compatibility policy.
//
// This is deliberately narrow: it identifies only the legacy Storyline 360
// generation that our captured Review 360 uploads reject. Everything outside
// the evidenced range remains on the existing automatic pipeline; an absent or
// unfamiliar version is never guessed to be legacy.

import type { Block } from '@/shared/types/rise';
import type { StorylineMeta } from './web-export';

export const LEGACY_STORYLINE_MAX_UPDATE = 48;
export const LEGACY_STORYLINE_PLACEHOLDER =
  'Legacy Storyline block, requires manual review';
export const LEGACY_STORYLINE_IMPORTABILITY =
  'Not suitable for automatic import: contains legacy Storyline package(s); Storyline block(s) will be replaced with manual-review placeholders.';

interface ParsedStorylineVersion {
  major: number;
  update: number;
}

/** Parse Storyline's `3.<update>.<build>[.<revision>]` metadata. */
export function parseStorylineVersion(version: unknown): ParsedStorylineVersion | null {
  if (typeof version !== 'string') return null;
  const match = /^\s*(\d+)\.(\d+)(?:\.|$)/.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const update = Number(match[2]);
  return Number.isInteger(major) && Number.isInteger(update) ? { major, update } : null;
}

/**
 * True only for the known legacy Storyline 360 package generation. Captures
 * cover the older router packages and Review 360 `unpackFailed` at 3.42/3.48;
 * 3.49 is the first generation left on the established automatic path.
 */
export function isKnownLegacyStorylineMeta(meta: unknown): boolean {
  const version =
    meta && typeof meta === 'object' ? (meta as StorylineMeta).version : undefined;
  const parsed = parseStorylineVersion(version);
  return parsed?.major === 3 && parsed.update <= LEGACY_STORYLINE_MAX_UPDATE;
}

/** Read the attached package metadata from a materialized Storyline block. */
export function storylineMetaOfBlock(block: Block): StorylineMeta | undefined {
  const items = Array.isArray(block.items) ? block.items : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const media = (item as { media?: unknown }).media;
    if (!media || typeof media !== 'object') continue;
    const storyline = (media as { storyline?: unknown }).storyline;
    if (!storyline || typeof storyline !== 'object') continue;
    const meta = (storyline as { meta?: unknown }).meta;
    if (meta && typeof meta === 'object') return meta as StorylineMeta;
  }
  return undefined;
}

export function isKnownLegacyStorylineBlock(block: Block): boolean {
  return isKnownLegacyStorylineMeta(storylineMetaOfBlock(block));
}

/**
 * Replace an unsupported Storyline block with a capture-backed text donor.
 * Existing freshly-remapped ids are retained so plan/executor joins stay exact.
 */
export function legacyStorylinePlaceholderBlock(
  remapped: Record<string, unknown>,
  mintId: () => string,
): Record<string, unknown> {
  const sourceItems = Array.isArray(remapped.items) ? remapped.items : [];
  const first = sourceItems.find((item) => item && typeof item === 'object') as
    | Record<string, unknown>
    | undefined;
  return {
    id: typeof remapped.id === 'string' ? remapped.id : mintId(),
    type: 'text',
    family: 'text',
    variant: 'paragraph',
    items: [
      {
        id: typeof first?.id === 'string' ? first.id : mintId(),
        paragraph: `<p><strong>⚠ ${LEGACY_STORYLINE_PLACEHOLDER}</strong></p>`,
      },
    ],
    settings: {},
  };
}
