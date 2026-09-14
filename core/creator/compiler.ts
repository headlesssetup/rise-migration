// Deterministic Course Blueprint → Rise archive compiler.
//
// The compiler is the only Creator module allowed to emit Rise JSON. It uses
// registry-backed donor mappers and aborts on unresolved local asset refs,
// media keys, l10n refs, or cross-course references.
//
// v0.9.12: an optional STYLE PROFILE (core/style) is applied on top of the
// mapped blocks — theme/fonts/cover, Mighty type-style classes, per-block
// settings modes, the light-blue band rhythm, lesson opener/closer motifs and
// the banner / quote / video / image+text / attachment donors. Media the
// styled course references (profile assets + files from the operator's asset
// folder) is declared in a per-course asset manifest so the standard import
// upload/remap path handles it; any referenced key the manifest does not
// cover aborts the compile.

import { collectAssetKeys } from '@/core/assets/keys';
import {
  assetManifestToJson,
  buildAssetManifest,
  type AssetManifestEntry,
} from '@/core/assets/manifest';
import type { CourseBlueprint } from '@/core/creator/blueprint';
import { newId } from '@/core/import/ids';
import { findLocalAssetRefs } from '@/core/local-assets';
import {
  RISE_TEMPLATE_REGISTRY_REVISION,
  registryWarnings,
} from '@/core/rise-format';
import { findStorylineBlocks } from '@/core/storyline/detect';
import {
  defaultMints,
  mapLesson,
  type MappedBlockRecord,
  type Mints,
} from '@/core/storyboard/map';
import {
  applyCourseStyle,
  styleLesson,
  type ApplyContext,
  type ResolvedFile,
  type StyleProfile,
} from '@/core/style';
import { StoryboardError } from '@/core/creator/errors';
import type { Block, GetCourseDocument, Lesson } from '@/shared/types/rise';

export interface BuiltCourse {
  courseId: string;
  /** Raw `{course, lessons}` JSON body for `courses/<id>.json`. */
  raw: string;
  manifestEntry: { id: string; title: string };
  planJson: string;
  /** Narration companion (markdown), or null when there is none to report. */
  productionMd: string | null;
  lessonCount: number;
  blockCount: number;
  notes: string[];
  registryRevision: string;
  registryWarnings: string[];
  /** `courses/<id>.assets.json` body when the course references media; else null. */
  assetManifestJson: string | null;
  /** Asset-folder files to store content-addressed as `assets/<name>`. */
  assetFiles: { name: string; bytes: Uint8Array }[];
  /** Profile asset files (`<hash>.<ext>`) the writer must find already present. */
  profileAssetFiles: string[];
  styleName: string | null;
}

export interface CompileOptions {
  style?: StyleProfile | null;
  /** Exact file name → bytes from the operator's asset folder. */
  files?: Map<string, ResolvedFile>;
}

export { findLocalAssetRefs, type LocalAssetOccurrence } from '@/core/local-assets';

/** Assert the compiler output contains no unresolved/local or foreign refs.
 *  `declaredKeys` = uploaded-media keys the course's asset manifest covers
 *  (style-profile assets + folder files); any other media key is a fault. */
export function assertCleanDocument(doc: GetCourseDocument, declaredKeys?: Set<string>): void {
  const local = findLocalAssetRefs(doc);
  if (local.length > 0) {
    throw new StoryboardError(
      `compiler emitted unresolved local asset ref(s): ${local
        .map((item) => `${item.assetPath} @ ${item.path}`)
        .join('; ')}`,
    );
  }
  const media = collectAssetKeys(doc).filter((k) => !declaredKeys?.has(k.key));
  if (media.length > 0) {
    throw new StoryboardError(
      `compiler emitted media key(s) without an asset adapter: ${media
        .map((item) => `${item.key} @ ${item.paths[0]}`)
        .join('; ')}`,
    );
  }
  if (JSON.stringify(doc).includes('"l10nId"')) {
    throw new StoryboardError('compiler emitted an l10n ref in a monolingual course');
  }
  const storyline = findStorylineBlocks(doc);
  if (storyline.length > 0) {
    throw new StoryboardError(
      `compiler emitted storyline block(s): ${storyline.map((item) => item.blockId).join(', ')}`,
    );
  }
  if (JSON.stringify(doc).includes('DRAW_FROM_QUESTION_BANK')) {
    throw new StoryboardError('compiler emitted a draw-from-bank cross-ref');
  }
}

/** Narration companion report; null when the blueprint carries no narration
 *  (the writer then skips the file entirely). Content stays in the source
 *  language — only the report scaffolding is English. */
function productionReport(blueprint: CourseBlueprint): string | null {
  if (blueprint.production.length === 0) return null;
  const lines: string[] = [
    `# Production material — ${blueprint.title}`,
    '',
    'Narration / voice-over scripts per lesson. This text is NOT course',
    'content — it is for the experts and producers recording the media.',
    '',
  ];
  let lesson = '';
  for (const item of blueprint.production) {
    if (item.lesson !== lesson) {
      lesson = item.lesson;
      lines.push(`## ${lesson}`, '');
    }
    const slide = item.sourceRef.slideNo != null
      ? `Slide ${item.sourceRef.slideNo}`
      : item.sourceRef.label;
    const experience = item.sourceRef.excerpt?.replace(/\s+/g, ' ').trim();
    lines.push(`### ${slide}${experience ? ` — ${experience}` : ''}`, '', item.text, '');
  }
  return lines.join('\n');
}

/** Declare every uploaded-media key the built document references: profile
 *  assets (bytes already in the Creator folder) and folder files (bytes
 *  carried in the result). A referenced key nobody covers is a compile fault. */
function declareAssets(
  doc: GetCourseDocument,
  courseId: string,
  generatedAt: string,
  ctx: ApplyContext | null,
): Pick<BuiltCourse, 'assetManifestJson' | 'assetFiles' | 'profileAssetFiles'> & {
  declaredKeys: Set<string>;
} {
  const collected = collectAssetKeys(doc, courseId);
  const entries = new Map<string, AssetManifestEntry>();
  const assetFiles: { name: string; bytes: Uint8Array }[] = [];
  const profileAssetFiles: string[] = [];
  if (ctx) {
    const referenced = new Set(collected.map((k) => k.key));
    for (const a of ctx.profile.assets) {
      if (!referenced.has(a.key)) continue;
      entries.set(a.key, { key: a.key, kind: a.kind as AssetManifestEntry['kind'], hash: a.hash, ext: a.ext, file: a.file, size: a.size });
      profileAssetFiles.push(a.file.replace(/^assets\//, ''));
    }
    for (const [key, used] of ctx.usedFiles) {
      const f = used.file;
      const name = `${f.sha256}.${f.ext || 'bin'}`;
      entries.set(key, {
        key,
        kind: f.mimeType.startsWith('image/') ? 'media-image' : 'media-other',
        hash: f.sha256,
        ext: f.ext || 'bin',
        file: `assets/${name}`,
        size: f.size,
      });
      if (!assetFiles.some((x) => x.name === name)) assetFiles.push({ name, bytes: f.bytes });
    }
  }
  const uncovered = collected.filter((k) => !entries.has(k.key));
  if (uncovered.length > 0) {
    throw new StoryboardError(
      `styled course references media with no archived bytes: ${uncovered
        .map((k) => `${k.key} @ ${k.paths[0]}`)
        .join('; ')} — re-harvest the style profile`,
    );
  }
  const assetManifestJson =
    entries.size > 0
      ? assetManifestToJson(
          buildAssetManifest('course', courseId, collected, [...entries.values()], [], generatedAt),
        )
      : null;
  return {
    assetManifestJson,
    assetFiles,
    profileAssetFiles: [...new Set(profileAssetFiles)],
    declaredKeys: new Set(entries.keys()),
  };
}

/** Compile an approved blueprint into the standard local archive course body. */
export function compileCourseBlueprint(
  blueprint: CourseBlueprint,
  generatedAt: string,
  mints: Mints = defaultMints(),
  mintCourseId: () => string = newId,
  options: CompileOptions = {},
): BuiltCourse {
  if (blueprint.lessons.length === 0) {
    throw new StoryboardError('blueprint has no lessons — nothing to build');
  }
  if (blueprint.assets.length > 0) {
    throw new StoryboardError(
      'blueprint contains local assets, but no registry-backed local-asset adapter is enabled',
    );
  }

  const courseId = `sb-${mintCourseId()}`;
  const style = options.style ?? null;
  const ctx: ApplyContext | null = style
    ? {
        profile: style,
        mints,
        courseId,
        files: options.files ?? new Map(),
        usedFiles: new Map(),
        notes: [],
      }
    : null;

  const lessons: Lesson[] = [];
  const records: (MappedBlockRecord & { lessonId: string; lesson: string })[] = [];
  const notes: string[] = [];
  const usedKinds = blueprint.lessons.flatMap((lesson) =>
    lesson.blocks.map((block) => block.intent.kind),
  );
  let blockCount = 0;

  for (let index = 0; index < blueprint.lessons.length; index++) {
    const plannedLesson = blueprint.lessons[index]!;
    const lessonId = mints.cuid();
    const icon = plannedLesson.icon ?? style?.lessons.icon ?? null;
    if (plannedLesson.type === 'section') {
      lessons.push({ id: lessonId, courseId, type: 'section', position: index, title: plannedLesson.title, items: [] });
      continue;
    }
    const mapped = mapLesson(plannedLesson.title, plannedLesson.blocks, mints);
    let blocks: Block[] = mapped.blocks;
    let lessonRecords: MappedBlockRecord[] = mapped.records;
    let lessonNotes: string[] = mapped.notes;
    if (ctx) {
      const next = blueprint.lessons.slice(index + 1).find((l) => l.type !== 'section');
      const styled = styleLesson(
        ctx,
        plannedLesson,
        { blocks: mapped.blocks, blueprintIndex: mapped.records.map((r) => r.blueprintIndex) },
        next?.title ?? null,
      );
      blocks = styled.blocks;
      // Notes of mappings a donor replaced (e.g. the native empty-video
      // placeholder) would mislead the operator — keep only the survivors'.
      lessonNotes = mapped.blockNotes
        .filter((n) => !styled.replaced.has(n.blueprintIndex))
        .map((n) => n.note);
      lessonRecords = [];
      styled.blocks.forEach((b, i) => {
        const bi = styled.blueprintIndex[i];
        if (bi === null || bi === undefined) return;
        const pb = plannedLesson.blocks[bi]!;
        lessonRecords.push({
          blockId: String(b.id),
          slideNo: pb.sourceRef.slideNo ?? null,
          kind: pb.intent.kind,
          blueprintIndex: bi,
        });
      });
    }
    lessons.push({
      id: lessonId,
      courseId,
      type: 'blocks',
      position: index,
      title: plannedLesson.title,
      ...(icon ? { icon } : {}),
      items: blocks,
    });
    blockCount += blocks.length;
    for (const record of lessonRecords) {
      records.push({ ...record, lessonId, lesson: plannedLesson.title });
    }
    for (const note of lessonNotes) notes.push(`${plannedLesson.title}: ${note}`);
  }

  const doc: GetCourseDocument = {
    course: {
      id: courseId,
      title: blueprint.title,
      description: '',
      type: null,
    },
    lessons,
  };
  if (ctx) {
    applyCourseStyle(doc, blueprint, ctx.profile);
    notes.push(...ctx.notes.map((n) => `style: ${n}`));
  }
  const assets = declareAssets(doc, courseId, generatedAt, ctx);
  assertCleanDocument(doc, assets.declaredKeys);
  const warnings = registryWarnings(usedKinds);

  return {
    courseId,
    raw: JSON.stringify(doc, null, 2),
    manifestEntry: { id: courseId, title: blueprint.title },
    planJson: JSON.stringify(
      {
        generatedAt,
        courseId,
        source: blueprint.source,
        blueprint,
        registryRevision: RISE_TEMPLATE_REGISTRY_REVISION,
        style: style
          ? { name: style.name, harvestedAt: style.harvestedAt, sourceCourseIds: style.sourceCourseIds }
          : null,
        blocks: records,
        unresolvedCount: blueprint.unresolved.length,
        registryWarnings: warnings,
        notes,
      },
      null,
      2,
    ),
    productionMd: productionReport(blueprint),
    lessonCount: lessons.length,
    blockCount,
    notes,
    registryRevision: RISE_TEMPLATE_REGISTRY_REVISION,
    registryWarnings: warnings,
    assetManifestJson: assets.assetManifestJson,
    assetFiles: assets.assetFiles,
    profileAssetFiles: assets.profileAssetFiles,
    styleName: style?.name ?? null,
  };
}
