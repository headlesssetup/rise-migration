// Parse a Rise "Publish to Web" export to locate each Storyline block's bundled
// package and its `media.storyline.meta`.
//
// Why: the web export is how we obtain a storyline block's published bytes for
// migration. It bundles each package under `content/assets/{leaf}/` (story.html,
// story_content/…, html5/…, mobile/…, AND `threeSixty.json` + `meta.xml`), and
// its `content/runtime-data.js` carries every storyline block as
// `media.storyline = { contentPrefix:"{leaf}", src:"{leaf}/story.html", meta }`.
// That gives a direct block→folder map plus the exact `meta` to re-write on the
// target block (it equals `threeSixty.json` and the EU `UPDATE_BLOCK_DEBOUNCE`
// payload — confirmed against the operator's MITM capture + sample zips).
//
// This module is pure (string in → refs out); the orchestrator does the I/O
// (download zip, read folders, join to the archived GET_COURSE blocks).

/** `media.storyline.meta` — kept permissive (copy-faithful; mirrors threeSixty.json). */
export interface StorylineMeta {
  title?: string;
  version?: string;
  course_id?: string;
  thumbnail?: string;
  stage?: { width?: number; height?: number };
  player?: { name?: string; width?: number; height?: number };
  scenes?: Array<{ title?: string }>;
  slides?: Array<{ id?: string; title?: string; scene_index?: string }>;
  [k: string]: unknown;
}

/** One storyline block located in a web export's runtime data. */
export interface StorylineRef {
  /** Asset-folder leaf, e.g. `k3sFdQgN6xRXAoBp` — the package lives at `content/assets/{leaf}/`. */
  leaf: string;
  /** `{leaf}/story.html` — the package entry point, as written in the export. */
  src: string;
  /** The block's `media.storyline.meta`, to re-write verbatim on the target block. */
  meta: StorylineMeta;
  /** Convenience copy of `meta.title`, when present. */
  title?: string;
  /** JSON path where the storyline object was found (diagnostics / position join). */
  path: string;
}

/** Matches `__jsonp("runtime-data.js","<base64>")` — Rise wraps the course JSON this way. */
const JSONP_RE = /__jsonp\(\s*"[^"]*"\s*,\s*"([A-Za-z0-9+/=]+)"/;

/**
 * Decode a Rise web export's `runtime-data.js` (a `__jsonp(...)`-wrapped,
 * base64-encoded JSON course document) into a plain object. Works in both the
 * extension (service worker) and Node/vitest via `atob` + `TextDecoder`.
 * @throws if the wrapper/base64/JSON can't be parsed.
 */
export function decodeRuntimeData(js: string): unknown {
  const m = JSONP_RE.exec(js);
  if (!m) throw new Error('runtime-data.js: no __jsonp("runtime-data.js", "<base64>") wrapper found');
  const bin = atob(m[1]!);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True for a `media.storyline` value that points at a bundled package. */
function isStorylineMedia(v: unknown): v is { contentPrefix?: unknown; src?: unknown; meta?: unknown } {
  return isObject(v) && (typeof v.contentPrefix === 'string' || typeof v.src === 'string');
}

/**
 * Generic recursive walk (per CLAUDE.md: never a per-block-type walk) that
 * collects every `media.storyline` package reference in a decoded web-export
 * document. The `leaf` is taken from `contentPrefix` when present, else derived
 * from `src` (`{leaf}/story.html`).
 */
export function findStorylineRefs(doc: unknown): StorylineRef[] {
  const out: StorylineRef[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (!isObject(node)) return;
    for (const [k, v] of Object.entries(node)) {
      const childPath = `${path}.${k}`;
      if (k === 'storyline' && isStorylineMedia(v)) {
        const src = typeof v.src === 'string' ? v.src : '';
        const contentPrefix = typeof v.contentPrefix === 'string' ? v.contentPrefix : '';
        const leaf = contentPrefix || src.replace(/\/story\.html$/i, '');
        const meta = (isObject(v.meta) ? v.meta : {}) as StorylineMeta;
        out.push({
          leaf,
          src: src || `${leaf}/story.html`,
          meta,
          title: typeof meta.title === 'string' ? meta.title : undefined,
          path: childPath,
        });
      }
      walk(v, childPath);
    }
  };
  walk(doc, '$');
  return out;
}

/** Convenience: decode `runtime-data.js` and return its storyline refs. */
export function parseWebExportRuntimeData(js: string): StorylineRef[] {
  return findStorylineRefs(decodeRuntimeData(js));
}
