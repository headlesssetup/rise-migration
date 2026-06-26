// Stage (A) — trigger a Rise "Publish to Web / raw" export and learn its job id.
//
// The export page issues a single authoring write:
//   POST /api/rise-runtime/build/{courseId}/raw  {exportType:"raw", format:"zip",
//        identifier:"{courseId}_rise", title, bundles{…SHAs}, lmsDriverVersion,
//        riseDistributor:true, websocketSessionId:"<uuid>"}  → {jobId, riseDistributor}
// Capture-confirmed verbatim against `008212ae-mitmzip.txt` (QUIC-disabled run).
//
// The `{jobId}` response only acknowledges the job; the finished zip's download
// URL arrives later over the ws.eu JSON-RPC socket (see `ws-export.ts`), keyed by
// the `websocketSessionId` we send here. So the caller must open that socket and
// `identify` with this same sessionId BEFORE (or around) issuing this request.
//
// Pure: returns a WriteSpec the background relays inside the live Rise tab (the
// build is an authoring write → paced like every other ducks/manage call).

import type { WriteSpec } from '@/core/import/envelopes';

/**
 * Frontend bundle SHAs + LMS driver version baked into the export request.
 *
 * These are Rise-version-specific (they pin which runtime the server packages)
 * and WILL drift as Rise ships. They are config, not UI (per operator): update
 * the defaults here — or pass `bundles`/`lmsDriverVersion` to
 * {@link buildRawExportRequest} — when a capture shows new values. Defaults are
 * the capture-confirmed values from `008212ae-mitmzip.txt` (2026-06-24, EU).
 *
 * A drifted value is not silent: if the server rejects the build the relay
 * surfaces the non-2xx body (loud-fail), pointing here.
 */
export const DEFAULT_EXPORT_BUNDLES = {
  rise_frontend: 'a3be93ae6a5f99327fc1fc6a1e88bb908c9ce360',
  learn_distribution_frontend: '3cc01a2801faab66e9c0d2994afec237bb448c2e',
  mondrian: '3b2e1f565719af1c648b50a07707814090dd2792',
  sandbox: '42753f3391b109fa3788c525c22880445ab48325',
} as const;

export const DEFAULT_LMS_DRIVER_VERSION = '7.12.0.a.1.6.2';

export interface ExportBundles {
  rise_frontend: string;
  learn_distribution_frontend: string;
  mondrian: string;
  sandbox: string;
}

export interface BuildRawExportArgs {
  courseId: string;
  /** Course title — copied into the zip's manifest; cosmetic to us. */
  title: string;
  /** The session id we also `identify` on the ws.eu socket. Defaults to a fresh
   *  uuid; pass one explicitly to share it with an already-open socket. */
  websocketSessionId?: string;
  bundles?: ExportBundles;
  lmsDriverVersion?: string;
}

/** A fresh websocketSessionId (uuid v4). `crypto.randomUUID` exists in the
 *  service worker and Node ≥ 16; the param lets tests inject a fixed id. */
export function newWebsocketSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Build the `POST …/build/{courseId}/raw` write. Field order/values mirror the
 * captured request exactly (`exportType:"raw"`, `format:"zip"`, the fixed
 * defaults Rise sends regardless of course, and the version-pinned bundles).
 * Returns the spec plus the `websocketSessionId` it embedded so the caller can
 * tie the ws.eu completion notify back to this job.
 */
export function buildRawExportRequest(
  args: BuildRawExportArgs,
): { spec: WriteSpec; websocketSessionId: string } {
  const websocketSessionId = args.websocketSessionId ?? newWebsocketSessionId();
  const payload = {
    exportType: 'raw',
    isRemotePackage: false,
    format: 'zip',
    completionPercentage: 100,
    disableCoverPage: false,
    enableExitCourse: false,
    enableTelemetryCollection: false,
    identifier: `${args.courseId}_rise`,
    loadOnlyInLMS: false,
    quizId: null,
    reporting: 'passed-incomplete',
    storylineId: null,
    title: args.title,
    bundles: args.bundles ?? { ...DEFAULT_EXPORT_BUNDLES },
    lmsDriverVersion: args.lmsDriverVersion ?? DEFAULT_LMS_DRIVER_VERSION,
    riseDistributor: true,
    websocketSessionId,
  };
  return {
    websocketSessionId,
    spec: {
      url: `/api/rise-runtime/build/${encodeURIComponent(args.courseId)}/raw`,
      method: 'POST',
      body: JSON.stringify(payload),
      // build/raw is cookie-authed: the editor sends NO Authorization header
      // (capture-confirmed). Attaching a (possibly stale) bearer makes it 403.
      omitBearer: true,
      label: `build raw export ${args.courseId}`,
    },
  };
}

export interface BuildAck {
  jobId: string;
  riseDistributor?: boolean;
}

/**
 * Parse the `{jobId, riseDistributor}` acknowledgement. Throws on malformed JSON
 * or a missing `jobId` — the caller loud-fails (a build with no job can never be
 * awaited on the socket).
 */
export function parseBuildAck(text: string): BuildAck {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`build/raw response was not valid JSON: ${text.slice(0, 200)}`);
  }
  if (typeof doc !== 'object' || doc === null) {
    throw new Error('build/raw response was not an object');
  }
  const rec = doc as Record<string, unknown>;
  const jobId = rec.jobId;
  // Rise returns jobId as a string ("8797"); accept a number defensively.
  if (typeof jobId !== 'string' && typeof jobId !== 'number') {
    throw new Error(`build/raw response had no jobId: ${text.slice(0, 200)}`);
  }
  return {
    jobId: String(jobId),
    riseDistributor: typeof rec.riseDistributor === 'boolean' ? rec.riseDistributor : undefined,
  };
}
