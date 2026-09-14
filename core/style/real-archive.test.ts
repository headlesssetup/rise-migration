// Operator check against a REAL rise-export archive (never committed data):
//   STYLE_ARCHIVE=/path/to/_export1309 STYLE_COURSES=id1,id2 pnpm vitest run core/style/real-archive
// Harvests the profile, prints its report, compiles a small blueprint with it
// and runs the import planner over the result. Skipped without the env var.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlan } from '@/core/import';
import type { AssetManifest } from '@/core/assets/manifest';
import { compileCourseBlueprint } from '@/core/creator/compiler';
import {
  COURSE_BLUEPRINT_FORMAT,
  COURSE_BLUEPRINT_VERSION,
  type CourseBlueprint,
} from '@/core/creator/blueprint';
import type { GetCourseDocument } from '@/shared/types/rise';
import { harvestStyleProfile } from './harvest';

const ROOT = process.env.STYLE_ARCHIVE;
const COURSES = (process.env.STYLE_COURSES ?? '').split(',').filter(Boolean);

describe.skipIf(!ROOT)('style harvest over the real archive', () => {
  it('harvests, compiles and plans', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT!, 'manifest.json'), 'utf8')) as {
      courses: { id: string; title: string }[];
    };
    const ids = COURSES.length > 0 ? COURSES : manifest.courses.slice(0, 1).map((c) => c.id);
    const inputs = ids.map((id) => {
      const raw = JSON.parse(readFileSync(join(ROOT!, 'courses', `${id}.json`), 'utf8')) as {
        payload?: GetCourseDocument;
      } & GetCourseDocument;
      const assetsPath = join(ROOT!, 'courses', `${id}.assets.json`);
      return {
        doc: raw.payload ?? raw,
        assetManifest: existsSync(assetsPath)
          ? (JSON.parse(readFileSync(assetsPath, 'utf8')) as AssetManifest)
          : null,
      };
    });
    const { profile, report } = harvestStyleProfile({
      name: 'real',
      courses: inputs,
      toolVersion: 'test',
      harvestedAt: new Date().toISOString(),
    });
    // eslint-disable-next-line no-console
    console.log(report.join('\n'));
    expect(profile.course.theme).not.toBeNull();

    const REF = (row: number) => ({ label: `Row ${row}`, slideNo: null, row });
    const bp: CourseBlueprint = {
      format: COURSE_BLUEPRINT_FORMAT,
      formatVersion: COURSE_BLUEPRINT_VERSION,
      source: { kind: 'ai-provider' },
      title: 'Testa kurss (stils)',
      lessons: [
        {
          title: '1.4.1. Padomes struktūra',
          blocks: [
            { intent: { kind: 'text', paragraphs: ['<p>Ievads.</p>'] }, sourceRef: REF(2), notes: [] },
            { intent: { kind: 'text', heading: 'Virsraksts', paragraphs: ['<p>Teksts.</p>'] }, sourceRef: REF(3), notes: [] },
            { intent: { kind: 'video-placeholder', label: 'Video' }, sourceRef: REF(4), notes: [] },
            { intent: { kind: 'banner', label: 'Pārbaudi savas zināšanas!' }, sourceRef: REF(5), notes: [] },
            {
              intent: { kind: 'knowledge-check', intro: [], questions: [{ stem: '<p>Q?</p>', options: [{ text: 'a', correct: true }, { text: 'b', correct: false }] }] },
              sourceRef: REF(6),
              notes: [],
            },
            { intent: { kind: 'quote', heading: 'Tēmas padziļināšanai', text: '<p>Vairāk.</p>' }, sourceRef: REF(7), notes: [] },
            { intent: { kind: 'banner', label: 'Kopsavilkums' }, sourceRef: REF(8), notes: [] },
            { intent: { kind: 'text', paragraphs: ['<p>Kopsavilkums.</p>'] }, sourceRef: REF(9), notes: [] },
          ],
        },
        { title: '1.4.2. Otrā', blocks: [{ intent: { kind: 'text', paragraphs: ['<p>Ievads 2.</p>'] }, sourceRef: REF(10), notes: [] }] },
      ],
      assets: [],
      unresolved: [],
      production: [],
    };
    const built = compileCourseBlueprint(bp, new Date().toISOString(), undefined, undefined, { style: profile });
    const doc = JSON.parse(built.raw) as GetCourseDocument;
    const am = JSON.parse(built.assetManifestJson!) as AssetManifest;
    const steps = buildPlan({
      course: doc,
      assets: am.assets.map((a) => ({ key: a.key, kind: a.kind, file: a.file, ext: a.ext, size: a.size })),
      banksById: new Map(),
      author: 'a',
    });
    // eslint-disable-next-line no-console
    console.log(
      `compiled ${built.blockCount} blocks; ${am.assets.length} assets; steps: ${[...new Set(steps.map((s) => s.kind))].join(', ')}\nnotes:\n${built.notes.join('\n')}`,
    );
    // eslint-disable-next-line no-console
    console.log(
      (doc.lessons ?? [])[0]!.items!.map((b) => `${b.family}/${b.variant} ${JSON.stringify((b.settings as Record<string, unknown>).backgroundType)}`).join('\n'),
    );
    expect(steps.some((s) => s.kind === 'set-theme')).toBe(true);
    expect(steps.filter((s) => /flag-unsupported/.test(s.kind))).toEqual([]);
  });
});
