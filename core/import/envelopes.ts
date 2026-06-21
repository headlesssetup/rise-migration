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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
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

/** POST /manage/api/content — create the course shell → {id}. */
export function createCourseShell(folderId: string | null = 'all'): WriteSpec {
  return {
    url: '/manage/api/content',
    method: 'POST',
    body: JSON.stringify({ createBookmark: false, folderId }),
    label: 'POST /manage/api/content (create course)',
  };
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

/** UPDATE_COURSE {id, jobs} — register transcode job ids on the course (§8). */
export function registerJobs(courseId: string, jobs: string[]): WriteSpec {
  return ducks('courses', 'UPDATE_COURSE', { id: courseId, jobs });
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
}): WriteSpec {
  return ducks('uploads', 'GET_YURL', {
    assetPath: `courses/${args.courseId}`,
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

export function crushImage(courseId: string, original: string): WriteSpec {
  return ducks('uploads', 'CRUSH_IMAGE', { courseId, original });
}

export function transcodeAsset(payload: {
  courseId: string;
  key: string; // URL-encoded
  lessonId: string;
  mediaType: 'audio' | 'video';
  original: string;
  refs: string;
  uploadId: string;
}): WriteSpec {
  return ducks('uploads', 'TRANSCODE_ASSET', payload);
}

export function checkStatus(courseId: string, jobs: string[]): WriteSpec {
  return ducks('uploads', 'CHECK_STATUS', { jobs, courseId });
}

/** RESOLVE_ASSET — resolve a transcoded key after CHECK_STATUS reports done.
 *  ⚠️ Payload shape not fully captured — confirm on a live a/v import. */
export function resolveAsset(courseId: string, key: string): WriteSpec {
  return ducks('uploads', 'RESOLVE_ASSET', { courseId, key });
}

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

/** POST /api/rise-authoring/locks — acquire an authoring edit lock (best-effort). */
export function postAuthoringLock(body: unknown): WriteSpec {
  return {
    url: '/api/rise-authoring/locks',
    method: 'POST',
    body: JSON.stringify(body),
    label: 'POST /api/rise-authoring/locks',
  };
}
