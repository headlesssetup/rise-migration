// Tier-2 novelty review (PRD §8): diff the per-variant field profiles against
// the known catalog and surface only what's genuinely new — so nothing migrates
// unseen, without the optional-field noise of per-shape signatures.
//
//   - new-variant : family/variant absent from the catalog (high-value signal).
//   - new-field   : a field-path not in the catalog's known set for a known
//                   variant. Only emitted for variants that HAVE a recorded
//                   field baseline; until then the field profile (catalog.json)
//                   is the thing to review, so we don't spam unknown fields.

import { toCsv } from '@/core/util/csv';
import { isKnownVariant, knownFieldsFor } from './catalog';
import type { VariantProfile } from './profile';

export interface NewVariant {
  key: string;
  instances: number;
  courseCount: number;
  fieldCount: number;
  coreFields: string[];
  examplePath: string;
  courseIds: string[];
}

export interface NewField {
  key: string;
  path: string;
  presence: number;
  count: number;
  courseCount: number;
}

export interface NoveltyReport {
  generatedAt: string;
  variantCount: number;
  newVariants: NewVariant[];
  newFields: NewField[];
  /** Known variants with no recorded field baseline yet → see catalog.json. */
  knownWithoutFieldCatalog: string[];
}

export interface NoveltyCatalog {
  isKnownVariant(key: string): boolean;
  knownFieldsFor(key: string): Set<string> | null;
}

const DEFAULT_CATALOG: NoveltyCatalog = { isKnownVariant, knownFieldsFor };

export function buildNovelty(
  profiles: VariantProfile[],
  catalog: NoveltyCatalog = DEFAULT_CATALOG,
  now: Date = new Date(),
): NoveltyReport {
  const newVariants: NewVariant[] = [];
  const newFields: NewField[] = [];
  const knownWithoutFieldCatalog: string[] = [];

  for (const p of profiles) {
    if (!catalog.isKnownVariant(p.key)) {
      newVariants.push({
        key: p.key,
        instances: p.instances,
        courseCount: p.courseCount,
        fieldCount: p.fields.length,
        coreFields: p.fields.filter((f) => f.core).map((f) => f.path),
        examplePath: p.examplePath,
        courseIds: p.courseIds.slice(0, 5),
      });
      continue;
    }
    const known = catalog.knownFieldsFor(p.key);
    if (!known) {
      knownWithoutFieldCatalog.push(p.key);
      continue;
    }
    for (const f of p.fields) {
      if (!known.has(f.path)) {
        newFields.push({
          key: p.key,
          path: f.path,
          presence: f.presence,
          count: f.count,
          courseCount: f.courseCount,
        });
      }
    }
  }

  newVariants.sort((a, b) => b.instances - a.instances || a.key.localeCompare(b.key));
  newFields.sort((a, b) => a.key.localeCompare(b.key) || b.count - a.count);

  return {
    generatedAt: now.toISOString(),
    variantCount: profiles.length,
    newVariants,
    newFields,
    knownWithoutFieldCatalog: knownWithoutFieldCatalog.sort(),
  };
}

export function noveltyToJson(r: NoveltyReport): string {
  return JSON.stringify(r, null, 2);
}

export function noveltyToCsv(r: NoveltyReport): string {
  const headers = ['kind', 'key', 'detail', 'metric', 'courseCount', 'example'];
  const rows: (string | number)[][] = [];
  for (const v of r.newVariants) {
    rows.push([
      'new-variant',
      v.key,
      `${v.fieldCount} fields`,
      `${v.instances} instances`,
      v.courseCount,
      v.examplePath,
    ]);
  }
  for (const f of r.newFields) {
    rows.push([
      'new-field',
      f.key,
      f.path,
      `${Math.round(f.presence * 100)}%`,
      f.courseCount,
      '',
    ]);
  }
  return toCsv(headers, rows);
}
