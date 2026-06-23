// Phase 3 — typed WRITE request builders (the import counterpart of
// core/rise-client). Pure: each returns a WriteSpec the background relays inside
// the live Rise tab (first-party cookies + bearer). Endpoints/payloads come from
// docs/rise-import-protocol.md — never inferred. URLs to rise.articulate.com are
// RELATIVE so they ride whichever plane (US/EU) the tab is on; the S3 upload uses
// the ABSOLUTE presigned url returned by GET_YURL (server-dictated host).

/** A write request. Superset of the read-side RequestSpec: adds PUT/DELETE,
 *  cross-origin S3 (absolute url, no auth), and binary (base64) bodies. */
export interface WriteSpec {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** JSON string body (rise.articulate.com calls). */
  body?: string;
  /** Base64-encoded raw bytes (S3 upload PUT). Mutually exclusive with `body`. */
  base64Body?: string;
  /** Content-Type to send (defaults to application/json when `body` is set). */
  contentType?: string;
  /** Omit the bearer Authorization header (presigned S3 PUT carries its own). */
  noAuth?: boolean;
  /** Human label for the dry-run plan + loud-fail reports. */
  label: string;
}

const DUCKS = '/api/rise-runtime/ducks/rise';

/** Build a ducks RPC spec: POST .../ducks/rise/<domain>/<ACTION> {type,payload}. */
function ducks(domain: string, action: string, payload: unknown): WriteSpec {
  const type = `rise/${domain}/${action}`;
  return {
    url: `${DUCKS}/${domain}/${action}`,
    method: 'POST',
    body: JSON.stringify({ type, payload }),
    label: type,
  };
}

// --- Course shell + theme (protocol §7) -------------------------------------

/** POST /manage/api/content — create the course shell → {id}. Capture-confirmed:
 *  this single call creates a fully-materialized course (GET_COURSE returns it 200
 *  immediately, with the classic theme + a random built-in cover). `type` is sent
 *  for non-standard courses — `"onePage"` for a microlearning (capture); a standard
 *  course omits it (source `course.type` is null). */
export function createCourseShell(
  folderId: string | null = 'all',
  type?: string | null,
): WriteSpec {
  return {
    url: '/manage/api/content',
    method: 'POST',
    body: JSON.stringify({
      createBookmark: false,
      folderId,
      ...(typeof type === 'string' && type ? { type } : {}),
    }),
    label: 'POST /manage/api/content (create course)',
  };
}

/** GET_COURSE — read the full course document. Used as the post-create HANDSHAKE
 *  (mirror the editor, which always GET_COURSEs a new course before any write) to
 *  confirm the shell materialized, and for read-back parity. A read, but it rides
 *  the write relay. */
export function getCourse(courseId: string): WriteSpec {
  return ducks('courses', 'GET_COURSE', { courseId });
}

/** UPDATE_COURSE {id, theme} — theme round-trips verbatim. */
export function updateCourseTheme(
  courseId: string,
  theme: unknown,
): WriteSpec {
  return ducks('courses', 'UPDATE_COURSE', { id: courseId, theme });
}

/** Set the course title. ✅ Confirmed against an EU capture: the action is
 *  `UPDATE_COURSE_FIELD_THROTTLE` (the plain `UPDATE_COURSE_FIELD` route 404s)
 *  and the payload nests the field under `course` — `{course:{id, title}}`. The
 *  same envelope sets `description` (and other scalar course fields). */
export function updateCourseTitle(courseId: string, title: string): WriteSpec {
  return ducks('courses', 'UPDATE_COURSE_FIELD_THROTTLE', {
    course: { id: courseId, title },
  });
}

/** Set a single scalar course field (title/description/…) via the confirmed
 *  `UPDATE_COURSE_FIELD_THROTTLE` envelope. */
export function updateCourseFieldThrottle(
  courseId: string,
  field: string,
  value: unknown,
): WriteSpec {
  return ducks('courses', 'UPDATE_COURSE_FIELD_THROTTLE', {
    course: { id: courseId, [field]: value },
  });
}

/** UPDATE_COURSE with the top-level typeface ids (heading/body/ui) + theme. ✅
 *  Confirmed in the theming capture: changing fonts sends the typeface ids at
 *  the TOP LEVEL of the payload (authoritative), not only inside `theme`. Send
 *  both so the course renders with the intended fonts. */
export function updateCourseThemeAndTypefaces(args: {
  courseId: string;
  theme: unknown;
  headingTypefaceId?: string;
  bodyTypefaceId?: string;
  uiTypefaceId?: string;
}): WriteSpec {
  return ducks('courses', 'UPDATE_COURSE', {
    id: args.courseId,
    ...(args.headingTypefaceId ? { headingTypefaceId: args.headingTypefaceId } : {}),
    ...(args.bodyTypefaceId ? { bodyTypefaceId: args.bodyTypefaceId } : {}),
    ...(args.uiTypefaceId ? { uiTypefaceId: args.uiTypefaceId } : {}),
    theme: args.theme,
  });
}

/** UPDATE_COURSE setting user-uploaded course images (after upload+crush).
 *  Capture-confirmed shapes (docs/rise-api-reference.md):
 *   - `coverImage`/`cardImage`: `{media:{image:{key,crushedKey,…}}}` or `{}`
 *   - `media`: the cover-page LOGO — `{image:{key,crushedKey,isSkipCrush,
 *     sourcedFrom,useCrushedKey,originalUrl}}` (note: NO `media` wrapper).
 *  The editor sends only the changed field(s); we mirror that. */
export function setCourseImages(args: {
  courseId: string;
  coverImage?: unknown;
  cardImage?: unknown;
  media?: unknown;
}): WriteSpec {
  return ducks('courses', 'UPDATE_COURSE', {
    id: args.courseId,
    ...(args.coverImage !== undefined ? { coverImage: args.coverImage } : {}),
    ...(args.cardImage !== undefined ? { cardImage: args.cardImage } : {}),
    ...(args.media !== undefined ? { media: args.media } : {}),
  });
}

/** FETCH_TYPEFACES — list the target account's typefaces (id ↔ name) so fonts
 *  can be matched by name (dedup) instead of by account-specific id. Payload is
 *  a courseId context (any course on the account works). A read, but it rides
 *  the same write relay. */
export function fetchTypefaces(courseId: string): WriteSpec {
  return ducks('typefaces', 'FETCH_TYPEFACES', courseId);
}

/** CREATE_TYPEFACE — register a custom font on the target account from uploaded
 *  `.woff` files. `fonts` is keyed by `typeface-<style>` (regular/bold/italic/…).
 *  Returns the new server-assigned typeface id. */
export function createTypeface(args: {
  name: string;
  fonts: Record<string, unknown>;
}): WriteSpec {
  return ducks('typefaces', 'CREATE_TYPEFACE', {
    name: args.name,
    fonts: args.fonts,
  });
}

// --- Lessons + locks (protocol §2) ------------------------------------------

export function createLesson(args: {
  author: string;
  courseId: string;
  position: number;
  title: string;
  type?: string | null;
}): WriteSpec {
  return ducks('lessons', 'CREATE_LESSON', {
    author: args.author,
    selectedAuthorId: args.author,
    courseId: args.courseId,
    position: args.position,
    title: args.title,
    type: args.type ?? null,
  });
}

export function updateLesson(args: {
  id: string;
  courseId: string;
  type: string;
  icon?: string | null;
  updatedAt?: string;
  /** Extra copy-faithful lesson fields (headerImage, description, settings, media). */
  extra?: Record<string, unknown>;
}): WriteSpec {
  return ducks('lessons', 'UPDATE_LESSON', {
    id: args.id,
    courseId: args.courseId,
    type: args.type,
    ...(args.icon !== undefined ? { icon: args.icon } : {}),
    ...(args.updatedAt ? { updatedAt: args.updatedAt } : {}),
    ...(args.extra ?? {}),
    bulkUpdateBlocks: { deletes: [], creates: [], updates: [], moves: [] },
  });
}

export function putLock(lessonId: string, courseId: string): WriteSpec {
  return ducks('locks', 'PUT_LOCK', { id: lessonId, courseId });
}

export function delLock(lessonId: string, courseId: string): WriteSpec {
  return ducks('locks', 'DEL_LOCK', { id: lessonId, courseId });
}

// --- Blocks (protocol §3/§4/§8) ---------------------------------------------

export function createBlocks(args: {
  courseId: string;
  lessonId: string;
  previousBlockId: string | null;
  blocks: unknown[];
}): WriteSpec {
  return ducks('lessons', 'CREATE_BLOCKS', {
    courseId: args.courseId,
    lessonId: args.lessonId,
    previousBlockId: args.previousBlockId,
    blocks: args.blocks,
  });
}

export function updateBlockDebounce(args: {
  id: string;
  courseId: string;
  lessonId: string;
  item: unknown;
}): WriteSpec {
  return ducks('lessons', 'UPDATE_BLOCK_DEBOUNCE', {
    id: args.id,
    courseId: args.courseId,
    lessonId: args.lessonId,
    item: args.item,
  });
}

/** INSERT_QUESTION_BANK_QUESTIONS — bind a draw-from-bank block to a bank (§4b). */
export function insertQuestionBankQuestions(payload: {
  lesson: unknown;
  blockOrItemId: string;
  pendingItemId: string;
  mode: string;
  drawCount: number;
  questionDrawType: string;
  questionBankId: string;
  questionList: string[];
  courseId: string;
}): WriteSpec {
  return ducks('lessons', 'INSERT_QUESTION_BANK_QUESTIONS', payload);
}

// --- Asset upload chain (protocol §8) ---------------------------------------

export function getYurl(args: {
  courseId: string;
  filename: string;
  /** Upload namespace. Default `courses/<courseId>` (block/cover media);
   *  custom fonts use `fonts/` (→ a `rise/fonts/<key>` server key). */
  assetPath?: string;
}): WriteSpec {
  return ducks('uploads', 'GET_YURL', {
    assetPath: args.assetPath ?? `courses/${args.courseId}`,
    courseId: args.courseId,
    filename: args.filename,
  });
}

/** S3 PUT of raw bytes to the presigned url (no auth; Content-Type from GET_YURL). */
export function s3Put(args: {
  url: string;
  base64Body: string;
  contentType: string;
}): WriteSpec {
  return {
    url: args.url,
    method: 'PUT',
    base64Body: args.base64Body,
    contentType: args.contentType,
    noAuth: true,
    label: 'S3 PUT (upload bytes)',
  };
}

// NOTE: CRUSH_IMAGE / TRANSCODE_ASSET / CHECK_STATUS / RESOLVE_ASSET are
// intentionally NOT used — we upload the EXACT exported asset bytes (Rise already
// crushed/transcoded them at author time; re-processing would recompress + drift).
// The endpoints are documented in docs/rise-import-protocol.md §8 for reference.

// --- Question banks (protocol §4a) ------------------------------------------

export function postBank(args: {
  folderId: string | null;
  title: string;
}): WriteSpec {
  return {
    url: '/manage/api/question-banks',
    method: 'POST',
    body: JSON.stringify({ folderId: args.folderId, title: args.title }),
    label: 'POST /manage/api/question-banks (create bank)',
  };
}

export function putBank(args: {
  bankId: string;
  questions: unknown[];
  session: string;
  lockData: unknown;
}): WriteSpec {
  return {
    url: `/api/rise-authoring/question_banks/${encodeURIComponent(args.bankId)}`,
    method: 'PUT',
    body: JSON.stringify({
      id: args.bankId,
      questions: args.questions,
      session: args.session,
      lock_data: args.lockData,
      update_type: 'editor',
    }),
    label: `PUT question_banks/${args.bankId}`,
  };
}

// --- Folders (catalog, protocol §10b) --------------------------------------

/** GET /manage/api/folders — the target account's folder tree (to find roots). */
export function fetchFolders(): WriteSpec {
  return { url: '/manage/api/folders', method: 'GET', label: 'GET /manage/api/folders' };
}

/** POST /manage/api/folders — create a folder. We never send `permissions`: the
 *  owner principal would have to exist on the TARGET account, but the token's
 *  `sub` (global Okta subject) isn't a valid account-local user id, so an ACL is
 *  rejected "Invalid users" (400). Without one, the folder is owned by the
 *  authenticated admin — ownership/sharing is a manual post-migration step. See
 *  docs/rise-import-protocol.md §10b. */
export function createFolder(args: {
  name: string;
  parentFolderId: string;
  /** Owner ACL — REQUIRED for a valid folder. A folder created with no owner
   *  500s the dashboard's content query. Principal must be the account-local
   *  user id (see ownerPermissions). */
  permissions?: unknown[];
}): WriteSpec {
  return {
    url: '/manage/api/folders',
    method: 'POST',
    body: JSON.stringify({
      name: args.name,
      parentFolderId: args.parentFolderId,
      ...(args.permissions && args.permissions.length ? { permissions: args.permissions } : {}),
    }),
    label: 'POST /manage/api/folders (create folder)',
  };
}

/** POST /manage/api/content/soft-delete — move course(s) to the bin (protocol
 *  §10b). Used by the import's TRANSACTIONAL ROLLBACK: a course shell whose
 *  import fails (or never materializes) would otherwise strand a "never-born"
 *  phantom in the root folder, which 500s the dashboard's `content/search`. This
 *  endpoint is `manage/api` (cookie-authed), so it lands even when the failure was
 *  a stale-bearer 403 on the authoring API; on a never-materialized shell it may
 *  answer 500 yet still take effect (verified live), so callers treat it as
 *  best-effort + status-agnostic. */
export function softDeleteContent(ids: string[]): WriteSpec {
  return {
    url: '/manage/api/content/soft-delete',
    method: 'POST',
    body: JSON.stringify({ ids }),
    label: 'POST /manage/api/content/soft-delete (rollback)',
  };
}

// NOTE: the remaining deletion endpoints (content hard-delete, folder delete,
// DELETE_TYPEFACE) are intentionally NOT implemented here — full purge/cleanup is
// out of scope for this app and will be a separate tool. (Soft-delete above is the
// one exception: it's the import's own rollback, not a purge.) The endpoints are
// documented in docs/rise-import-protocol.md §10f for when that's built.

/** PATCH /manage/api/content/{courseId}/move — move a course into a folder. The
 *  body is the folder id as a BARE text/plain string (confirmed in capture). */
export function moveCourseToFolder(courseId: string, folderId: string): WriteSpec {
  return {
    url: `/manage/api/content/${encodeURIComponent(courseId)}/move`,
    method: 'PATCH',
    body: folderId,
    contentType: 'text/plain;charset=UTF-8',
    label: `move course → folder ${folderId}`,
  };
}

/** POST /api/rise-authoring/locks — acquire an authoring edit lock (best-effort). */
export function postAuthoringLock(body: unknown): WriteSpec {
  return {
    url: '/api/rise-authoring/locks',
    method: 'POST',
    body: JSON.stringify(body),
    label: 'POST /api/rise-authoring/locks',
  };
}
