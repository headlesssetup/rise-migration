// Phase 2.2 — locate a media key in its source document.
//
// The asset scan records each occurrence's JSON path (e.g.
// `$.lessons[2].items[5].items[0].media.image.key`). Given that path and the
// course/bank doc, resolve a human-friendly location — the chapter/lesson and
// the block — so an orphaned (missing) asset can be found in Rise.

export interface KeyLocation {
  /** Nearest enclosing lesson/section title, if any. */
  lessonTitle?: string;
  /** Nearest enclosing lesson `type` (section/blocks/quiz…), if any. */
  lessonType?: string;
  /** The block this key belongs to. */
  family?: string;
  variant?: string;
  blockId?: string;
}

/** Parse a `$.a.b[0].c` path into its segment keys/indices. */
function parsePath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  // Matches `.name` and `[index]` segments after the leading `$`.
  const re = /\.([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(Number(m[2]));
  }
  return out;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Resolve a media key's JSON path to its location in the doc. Walks the path,
 * remembering the nearest ancestor that looks like a lesson (`type` + `title`)
 * and the nearest block (`family` + `variant`). Best-effort: returns whatever it
 * can identify, never throws.
 */
export function locateKey(doc: unknown, path: string): KeyLocation {
  const loc: KeyLocation = {};
  let node: unknown = doc;
  let prevSeg: string | number | undefined;
  const segs = parsePath(path);
  for (let i = 0; i < segs.length; i++) {
    let seg = segs[i]!;
    if (Array.isArray(node) && typeof seg === 'number') {
      node = node[seg];
    } else if (isRecord(node) && typeof seg === 'string') {
      // A JSON key containing '.' was split apart by parsePath (the scanner
      // builds paths with a bare `.` joiner). On a miss, greedily rejoin with
      // the following string segments until one resolves — best-effort
      // diagnostics only; keys containing '[' stay ambiguous.
      if (!(seg in node)) {
        let joined = seg;
        for (let j = i + 1; j < segs.length && typeof segs[j] === 'string'; j++) {
          joined = `${joined}.${segs[j]}`;
          if (joined in node) {
            seg = joined;
            i = j;
            break;
          }
        }
      }
      node = node[seg];
    } else {
      break; // path diverged from the doc — stop with what we have
    }

    if (isRecord(node)) {
      // The lesson/section is the entry right under `lessons[i]` — capture it
      // precisely so a block's own type/title (e.g. quiz questions) can't clobber.
      if (prevSeg === 'lessons' && typeof seg === 'number') {
        if (typeof node.title === 'string') loc.lessonTitle = node.title;
        if (typeof node.type === 'string') loc.lessonType = node.type;
      }
      if (typeof node.family === 'string' && typeof node.variant === 'string') {
        loc.family = node.family;
        loc.variant = node.variant;
        if (typeof node.id === 'string') loc.blockId = node.id;
      }
    }
    prevSeg = seg;
  }
  return loc;
}

/** A compact one-line location, e.g. `Chapter 2 › image/hero`. */
export function formatLocation(loc: KeyLocation): string {
  const left = loc.lessonTitle ?? loc.lessonType ?? '?';
  const right =
    loc.family && loc.variant ? `${loc.family}/${loc.variant}` : 'block';
  return `${left} › ${right}`;
}
