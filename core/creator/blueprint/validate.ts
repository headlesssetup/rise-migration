// Strict runtime validation for PASTED Course Blueprint JSON (the chat-AI
// flow, docs/creator-ai-design.md). Closed-schema posture: unknown fields and
// unsupported block intents FAIL validation — the operator pastes the error
// report back into the chat instead of us guessing. Style mirrors
// core/local-archive/validate.ts: accumulate issues with dotted paths, never
// throw; `ready` = no error-severity issues.

import {
  COURSE_BLUEPRINT_FORMAT,
  COURSE_BLUEPRINT_VERSION,
  type CourseBlueprint,
} from './types';
import {
  BANDS,
  LESSON_ICONS,
  checkFileName,
  checkIntent,
  checkSourceRef,
  issue,
  noUnknownKeys,
  object,
  str,
  strArray,
  unwrapPastedJson,
  type BlueprintIssue,
  type BlueprintValidation,
} from './validate-intents';

// Types + per-intent checks live in ./validate-intents (v0.9.12 split); this
// module remains the public door.
export type { BlueprintIssue, BlueprintValidation } from './validate-intents';
export { unwrapPastedJson } from './validate-intents';

/** True when the text ends inside an unclosed JSON structure or string —
 *  the signature of a chat that stopped emitting mid-document. */
function looksTruncated(raw: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of raw) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  return inString || depth > 0;
}

/** Validate pasted text as a Course Blueprint. Never throws. */
export function validateBlueprint(text: string): BlueprintValidation {
  const issues: BlueprintIssue[] = [];
  const raw = unwrapPastedJson(text);
  if (raw === '') {
    issue(issues, 'error', 'json', 'blueprint', 'Nothing to parse — paste the JSON the AI returned.');
    return { blueprint: null, issues, ready: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    issue(issues, 'error', 'json', 'blueprint', `Invalid JSON: ${String(e)}`);
    if (looksTruncated(raw)) {
      issue(
        issues,
        'error',
        'truncated',
        'blueprint',
        'The JSON ends unexpectedly — the chat likely truncated its output. Ask the AI to re-emit the FULL JSON in one block.',
      );
    }
    return { blueprint: null, issues, ready: false };
  }

  const root = object(parsed);
  if (!root) {
    issue(issues, 'error', 'shape', 'blueprint', 'The blueprint must be a JSON object.');
    return { blueprint: null, issues, ready: false };
  }
  if (root.format !== COURSE_BLUEPRINT_FORMAT || root.formatVersion !== COURSE_BLUEPRINT_VERSION) {
    issue(
      issues,
      'error',
      'format',
      'blueprint.format',
      `Expected format "${COURSE_BLUEPRINT_FORMAT}" formatVersion ${COURSE_BLUEPRINT_VERSION}.`,
    );
    return { blueprint: null, issues, ready: false };
  }

  noUnknownKeys(issues, 'blueprint', root, [
    'format',
    'formatVersion',
    'source',
    'title',
    'lessons',
    'assets',
    'unresolved',
    'production',
  ]);

  const source = object(root.source);
  if (!source) {
    issue(issues, 'error', 'shape', 'blueprint.source', 'source must be an object {kind, originalFileName?, provider?, model?}.');
  } else {
    noUnknownKeys(issues, 'blueprint.source', source, ['kind', 'originalFileName', 'provider', 'model']);
    if (source.kind !== 'ai-provider' && source.kind !== 'intea-storyboard') {
      issue(issues, 'error', 'shape', 'blueprint.source.kind', 'source.kind must be "ai-provider".');
    }
    for (const key of ['originalFileName', 'provider', 'model'] as const) {
      if (source[key] !== undefined) str(issues, `blueprint.source.${key}`, source[key]);
    }
  }

  str(issues, 'blueprint.title', root.title, { required: true, nonEmpty: true });

  if (!Array.isArray(root.lessons) || root.lessons.length === 0) {
    issue(issues, 'error', 'empty', 'blueprint.lessons', 'The course needs at least one lesson.');
  } else {
    root.lessons.forEach((lv, li) => {
      const lesson = object(lv);
      const lPath = `blueprint.lessons[${li}]`;
      if (!lesson) {
        issue(issues, 'error', 'shape', lPath, 'Lesson must be an object {title, blocks}.');
        return;
      }
      noUnknownKeys(issues, lPath, lesson, ['title', 'blocks', 'type', 'icon', 'image']);
      str(issues, `${lPath}.title`, lesson.title, { required: true, nonEmpty: true });
      if (lesson.type !== undefined && lesson.type !== 'blocks' && lesson.type !== 'section') {
        issue(issues, 'error', 'shape', `${lPath}.type`, 'type must be "blocks" or "section".');
      }
      if (lesson.icon !== undefined && !(LESSON_ICONS as readonly unknown[]).includes(lesson.icon)) {
        issue(issues, 'error', 'style', `${lPath}.icon`, `icon must be one of ${LESSON_ICONS.join(', ')}.`);
      }
      if (lesson.image !== undefined) checkFileName(issues, `${lPath}.image`, lesson.image);
      const section = lesson.type === 'section';
      if (!Array.isArray(lesson.blocks) || (lesson.blocks.length === 0 && !section)) {
        issue(issues, 'error', 'empty', `${lPath}.blocks`, 'The lesson needs at least one block (only a "section" divider may have blocks: []).');
        return;
      }
      if (section && lesson.blocks.length > 0) {
        issue(issues, 'error', 'shape', `${lPath}.blocks`, 'A "section" lesson is a divider — it must have blocks: [].');
        return;
      }
      lesson.blocks.forEach((bv, bi) => {
        const block = object(bv);
        const bPath = `${lPath}.blocks[${bi}]`;
        if (!block) {
          issue(issues, 'error', 'shape', bPath, 'Block must be an object {intent, sourceRef, notes?, origin?}.');
          return;
        }
        noUnknownKeys(issues, bPath, block, ['intent', 'sourceRef', 'notes', 'origin', 'band', 'image']);
        checkIntent(issues, `${bPath}.intent`, block.intent);
        checkSourceRef(issues, `${bPath}.sourceRef`, block.sourceRef, true);
        // notes is our bookkeeping — tolerate absence, normalize below.
        if (block.notes !== undefined) strArray(issues, `${bPath}.notes`, block.notes);
        if (block.origin !== undefined && block.origin !== 'source' && block.origin !== 'suggested') {
          issue(issues, 'error', 'origin', `${bPath}.origin`, 'origin must be "source" or "suggested".');
        }
        if (block.band !== undefined && !(BANDS as readonly unknown[]).includes(block.band)) {
          issue(issues, 'error', 'style', `${bPath}.band`, `band must be one of ${BANDS.join(', ')}.`);
        }
        if (block.image !== undefined) {
          checkFileName(issues, `${bPath}.image`, block.image);
          const kind = object(block.intent)?.kind;
          if (kind !== 'text' && kind !== 'banner') {
            issue(issues, 'error', 'style', `${bPath}.image`, 'image is only allowed on "text" (→ image + text) and "banner" blocks.');
          }
        }
      });
    });
  }

  if (!Array.isArray(root.assets)) {
    issue(issues, 'error', 'shape', 'blueprint.assets', 'assets must be an array (and empty: []).');
  } else if (root.assets.length > 0) {
    issue(
      issues,
      'error',
      'assets',
      'blueprint.assets',
      'Images/media cannot arrive via chat paste — assets must be []. Reference missing media as placeholder blocks and unresolved[] entries instead.',
    );
  }

  if (!Array.isArray(root.unresolved)) {
    issue(issues, 'error', 'shape', 'blueprint.unresolved', 'unresolved must be an array.');
  } else {
    root.unresolved.forEach((uv, i) => {
      const u = object(uv);
      const uPath = `blueprint.unresolved[${i}]`;
      if (!u) {
        issue(issues, 'error', 'shape', uPath, 'Must be an object {sourceRef, reason}.');
        return;
      }
      noUnknownKeys(issues, uPath, u, ['sourceRef', 'reason']);
      checkSourceRef(issues, `${uPath}.sourceRef`, u.sourceRef, true);
      str(issues, `${uPath}.reason`, u.reason, { required: true, nonEmpty: true });
    });
  }

  if (!Array.isArray(root.production)) {
    issue(issues, 'error', 'shape', 'blueprint.production', 'production must be an array.');
  } else {
    if (root.production.length > 0) {
      issue(
        issues,
        'warning',
        'shape',
        'blueprint.production',
        `${root.production.length} narration entr${root.production.length === 1 ? 'y' : 'ies'} — narration scripts are not needed for Rise (the source document is the producers' script) and bloat the JSON. Ask the AI to return "production": [] and keep only the video-placeholder blocks.`,
      );
    }
    root.production.forEach((pv, i) => {
      const p = object(pv);
      const pPath = `blueprint.production[${i}]`;
      if (!p) {
        issue(issues, 'error', 'shape', pPath, 'Must be an object {kind:"narration", lesson, sourceRef, text}.');
        return;
      }
      noUnknownKeys(issues, pPath, p, ['kind', 'lesson', 'sourceRef', 'text']);
      if (p.kind !== 'narration') {
        issue(issues, 'error', 'shape', `${pPath}.kind`, 'production kind must be "narration".');
      }
      str(issues, `${pPath}.lesson`, p.lesson, { required: true, nonEmpty: true });
      checkSourceRef(issues, `${pPath}.sourceRef`, p.sourceRef, true);
      str(issues, `${pPath}.text`, p.text, { required: true, nonEmpty: true });
    });
  }

  const ready = !issues.some((i) => i.severity === 'error');
  if (!ready) return { blueprint: null, issues, ready };

  // Normalize the tolerated absences so downstream code sees the full shape.
  const blueprint = parsed as CourseBlueprint;
  for (const lesson of blueprint.lessons) {
    for (const block of lesson.blocks) {
      block.notes ??= [];
    }
  }
  return { blueprint, issues, ready };
}

/** Human-readable failure report the operator pastes back into the AI chat. */
export function blueprintErrorReport(issues: BlueprintIssue[]): string {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const lines = [
    `The JSON failed validation against the ${COURSE_BLUEPRINT_FORMAT} v${COURSE_BLUEPRINT_VERSION} schema.`,
    'Fix the issues below and re-emit the FULL corrected JSON in one fenced block:',
    '',
    ...errors.map((i) => `- ${i.path}: ${i.message}`),
  ];
  if (warnings.length > 0) {
    lines.push('', 'Warnings (fix if possible):', ...warnings.map((i) => `- ${i.path}: ${i.message}`));
  }
  return lines.join('\n');
}
