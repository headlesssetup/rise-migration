// Rise to Docx view (v0.9.0) — three course sources, one document out:
//   · From archive  — a course already exported to the connected folder
//   · From account  — searched live in the account (one paced page per click)
//   · Current tab   — the course open in the active Rise editor tab
// Live sources are TRANSIENT: fetched in memory, rendered, downloaded,
// discarded — the archive is never written. `busy` is LIFTED into App
// (setBusy): a live fetch must gate navigation, or backing out mid-fetch
// orphans a paced job with no log and no button state (plan W3).
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Storage } from '@/core/storage/storage';
import type { AssetManifest } from '@/core/assets/manifest';
import {
  renderCourseModel,
  writeStoryboardDocx,
  writeStoryboardDocxProse,
  type ResolvedImage,
  type SbCourse,
} from '@/core/storyboard';
import type { SessionState } from '@/shared/messaging';
import type { SearchResultItem } from '@/shared/types/rise';
import {
  parseManifestCourses,
  type ManifestCourseEntry,
} from '../archive-merge';
import {
  DOCX_SEARCH_PAGE_SIZE,
  fetchCourseForDocx,
  MAX_EMBED_PX,
  pinRiseTabForDocx,
  resolveImagesFromCdn,
  searchCoursesPage,
  shrinkForEmbed,
} from '../orchestrator/docx';
import { unwrap } from '../orchestrator/shared';
import type { ProgressEvent } from '../orchestrator';

type DocxFormat = 'prose' | 'storyboard';
type DocxSource = 'archive' | 'account' | 'tab';

function sanitizeFileName(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|]/g, '·')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'course'
  );
}

function downloadDocx(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const RASTER_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

/** Archive-backed image resolution (the original path): bytes come from the
 *  folder's content-addressed assets via the course's asset manifest. */
async function resolveImagesFromArchive(
  model: SbCourse,
  storage: Storage,
  courseId: string,
  addLog: (msg: string) => void,
): Promise<Map<string, ResolvedImage>> {
  const images = new Map<string, ResolvedImage>();

  const manifestJson = await storage.readAssetManifest('courses', courseId);
  if (!manifestJson) {
    addLog('No asset manifest found — images will be skipped.');
    return images;
  }
  const manifest: AssetManifest = JSON.parse(manifestJson);
  const keyToEntry = new Map(manifest.assets.map((a) => [a.key, a]));

  const needed = new Set<string>();
  for (const lesson of model.lessons) {
    for (const row of lesson.rows) {
      if (row.image?.key) needed.add(row.image.key);
    }
  }

  let resolved = 0;
  let skipped = 0;
  let shrunk = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  for (const key of needed) {
    const entry = keyToEntry.get(key);
    if (!entry || !RASTER_EXTS.has(entry.ext)) {
      skipped++;
      continue;
    }
    const fileName = `${entry.hash}.${entry.ext}`;
    const bytes = await storage.readAsset(fileName);
    if (!bytes) {
      skipped++;
      continue;
    }
    const row = model.lessons
      .flatMap((l) => l.rows)
      .find((r) => r.image?.key === key);
    const ext = entry.ext === 'jpeg' ? 'jpg' : entry.ext;
    // Same thumbnail cap as the live path — archived originals are full-size.
    const small = await shrinkForEmbed(bytes, ext);
    bytesIn += bytes.length;
    bytesOut += small ? small.bytes.length : bytes.length;
    if (small) shrunk++;
    images.set(key, {
      key,
      bytes: small ? small.bytes : bytes,
      ext: small ? small.ext : ext,
      width: small ? small.width : row?.image?.width ?? 800,
      height: small ? small.height : row?.image?.height ?? 600,
    });
    resolved++;
  }
  if (resolved > 0 || skipped > 0) {
    const mb = (n: number): string => (n / 1e6).toFixed(1);
    addLog(
      `Images: ${resolved} embedded, ${skipped} skipped (SVG/missing)` +
        (shrunk > 0
          ? ` — ${shrunk} downscaled to ≤${MAX_EMBED_PX}px (${mb(bytesIn)} MB → ${mb(bytesOut)} MB)`
          : ''),
    );
  }
  return images;
}

const SOURCE_LABEL: Record<DocxSource, string> = {
  archive: 'From archive',
  account: 'From account',
  tab: 'Current tab',
};

interface Props {
  storage: Storage | null;
  session: SessionState | null;
  addLog: (msg: string) => void;
  logBreak: (label?: string) => void;
  busy: boolean;
  /** Lifts the live-fetch latch into App so navigation stays gated (W3). */
  setBusy: (b: boolean) => void;
}

export function DocxView({
  storage,
  session,
  addLog,
  logBreak,
  busy,
  setBusy,
}: Props) {
  const [source, setSource] = useState<DocxSource>('archive');
  const [format, setFormat] = useState<DocxFormat>('prose');
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState<{
    model: SbCourse;
    fileName: string;
  } | null>(null);

  // From archive: dropdown of the connected folder's courses.
  const [archiveCourses, setArchiveCourses] = useState<
    ManifestCourseEntry[] | null
  >(null);
  const [archiveSelected, setArchiveSelected] = useState('');

  // From account: one paced search page per click.
  const [acctTerm, setAcctTerm] = useState('');
  const [acctResults, setAcctResults] = useState<SearchResultItem[] | null>(
    null,
  );
  const [acctTotal, setAcctTotal] = useState<number | null>(null);
  const [acctPage, setAcctPage] = useState(0);
  const [acctSelected, setAcctSelected] = useState('');

  const liveReady = !!session?.risePresent && !!session?.hasToken;
  const editorCourseId = session?.editorCourseId ?? null;

  const onEvent = useCallback(
    (e: ProgressEvent) => {
      if (e.kind === 'log') addLog(e.message);
    },
    [addLog],
  );

  useEffect(() => {
    if (!storage) {
      setArchiveCourses(null);
      return;
    }
    void (async () => {
      try {
        const fromManifest = parseManifestCourses(
          await storage.readManifest(),
        );
        if (fromManifest.length > 0) {
          setArchiveCourses(fromManifest);
          return;
        }
        setArchiveCourses(
          (await storage.listSaved()).map((id) => ({ id })),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setArchiveCourses([]);
      }
    })();
  }, [storage]);

  const search = useCallback(
    async (page: number) => {
      setBusy(true);
      setError(null);
      try {
        const { items, totalCount } = await searchCoursesPage(
          page,
          acctTerm.trim() || undefined,
          onEvent,
        );
        setAcctResults((prev) =>
          page === 0 ? items : [...(prev ?? []), ...items],
        );
        setAcctTotal(totalCount);
        setAcctPage(page);
        addLog(
          `Search: ${items.length} course(s) on page ${page}${
            totalCount !== null ? ` of ${totalCount} total` : ''
          } — ${session?.accountName ?? 'account'} (${session?.plane?.toUpperCase() ?? 'plane unknown'}).`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [acctTerm, onEvent, addLog, session, setBusy],
  );

  /** The course id the Generate button acts on, per source. */
  const courseId =
    source === 'archive'
      ? archiveSelected
      : source === 'account'
        ? acctSelected
        : editorCourseId ?? '';

  const generate = useCallback(async () => {
    if (!courseId || busy) return;
    setBusy(true);
    setError(null);
    setRendered(null);
    try {
      logBreak('Generate .docx');
      const opts = {
        generatedAt: new Date().toISOString(),
        toolVersion: browser.runtime.getManifest().version,
      };

      let model: SbCourse;
      let images = new Map<string, ResolvedImage>();
      if (source === 'archive') {
        if (!storage) throw new Error('Connect an archive folder first.');
        const raw = await storage.readCourse(courseId);
        if (!raw)
          throw new Error(`courses/${courseId}.json not found in archive.`);
        model = renderCourseModel(unwrap(raw), opts);
        if (format === 'prose') {
          images = await resolveImagesFromArchive(
            model,
            storage,
            courseId,
            addLog,
          );
        }
      } else {
        // Live sources: pin at generate-click so the target can't drift to
        // another Rise tab between search and generate (W5). One paced read.
        const pin = await pinRiseTabForDocx();
        const doc = await fetchCourseForDocx(courseId, onEvent, {
          pinnedTabId: pin.pinnedTabId,
          expectedPlane: pin.expectedPlane,
        });
        model = renderCourseModel(doc, opts);
        if (format === 'prose') {
          images = await resolveImagesFromCdn(
            model,
            pin.expectedPlane,
            onEvent,
          );
        }
      }

      const bytes =
        format === 'prose'
          ? writeStoryboardDocxProse(model, images)
          : writeStoryboardDocx(model);

      const suffix = format === 'prose' ? 'prose' : 'storyboard';
      const fileName = `${sanitizeFileName(model.title)} — ${suffix}.docx`;
      downloadDocx(fileName, bytes);
      setRendered({ model, fileName });
      addLog(
        `Exported: ${fileName} (${model.lessons.length} lessons, ${model.blockCount} blocks)`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [
    courseId,
    busy,
    source,
    storage,
    format,
    addLog,
    logBreak,
    onEvent,
    setBusy,
  ]);

  const stats = useMemo(() => {
    if (!rendered) return null;
    const rows = rendered.model.lessons.flatMap((l) => l.rows);
    return {
      edit: rows.filter((r) => r.fidelity === 'edit').length,
      ro: rows.filter((r) => r.fidelity === 'ro').length,
      images: rows.filter((r) => r.image).length,
    };
  }, [rendered]);

  const canLoadMore =
    acctResults !== null &&
    (acctTotal === null || acctResults.length < acctTotal) &&
    acctResults.length === (acctPage + 1) * DOCX_SEARCH_PAGE_SIZE;

  return (
    <>
      <section className="card">
        <h2>Course</h2>

        {/* Source selector */}
        <div className="row" role="tablist" style={{ gap: 4 }}>
          {(Object.keys(SOURCE_LABEL) as DocxSource[]).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={source === s}
              disabled={busy}
              onClick={() => {
                setSource(s);
                setError(null);
              }}
              style={
                source === s
                  ? { fontWeight: 600, borderColor: '#888' }
                  : undefined
              }
            >
              {SOURCE_LABEL[s]}
            </button>
          ))}
        </div>

        {/* From archive */}
        {source === 'archive' && !storage && (
          <p className="hint">
            Connect an archive folder on the home screen to use this source.
          </p>
        )}
        {source === 'archive' && storage && (
          <>
            {archiveCourses === null && <p className="hint">Reading archive…</p>}
            {archiveCourses !== null && archiveCourses.length === 0 && (
              <p className="hint">
                No courses in the archive — export courses first (Export Data →
                C).
              </p>
            )}
            {archiveCourses !== null && archiveCourses.length > 0 && (
              <select
                value={archiveSelected}
                onChange={(e) => setArchiveSelected(e.target.value)}
                disabled={busy}
                style={{ width: '100%', marginTop: 6 }}
              >
                <option value="">— select a course —</option>
                {archiveCourses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {typeof c.title === 'string' && c.title !== ''
                      ? c.title
                      : c.id}
                  </option>
                ))}
              </select>
            )}
          </>
        )}

        {/* From account */}
        {source === 'account' && !liveReady && (
          <p className="hint">Open a logged-in Rise tab to search the account.</p>
        )}
        {source === 'account' && liveReady && (
          <>
            <div className="row" style={{ marginTop: 6 }}>
              <input
                type="text"
                placeholder="Search by name…"
                value={acctTerm}
                onChange={(e) => setAcctTerm(e.target.value)}
                disabled={busy}
                style={{ flex: 1 }}
              />
              <button onClick={() => void search(0)} disabled={busy}>
                Search (paced)
              </button>
            </div>
            {acctResults !== null && acctResults.length === 0 && (
              <p className="hint">No courses matched.</p>
            )}
            {acctResults !== null && acctResults.length > 0 && (
              <>
                <p className="hint" style={{ margin: '6px 0 2px' }}>
                  {session?.accountName ?? 'Account'}
                  {session?.plane ? ` (${session.plane.toUpperCase()})` : ''} ·{' '}
                  {acctResults.length}
                  {acctTotal !== null ? ` of ${acctTotal}` : ''} listed
                </p>
                <ul className="course-list">
                  {acctResults.map((c) => (
                    <li key={c.id}>
                      <label>
                        <input
                          type="radio"
                          name="docx-account-course"
                          checked={acctSelected === c.id}
                          onChange={() => setAcctSelected(c.id)}
                          disabled={busy}
                        />{' '}
                        {c.title ?? c.id}
                      </label>
                    </li>
                  ))}
                </ul>
                {canLoadMore && (
                  <button
                    onClick={() => void search(acctPage + 1)}
                    disabled={busy}
                  >
                    More (paced)
                  </button>
                )}
              </>
            )}
          </>
        )}

        {/* Current tab */}
        {source === 'tab' && !liveReady && (
          <p className="hint">Open a logged-in Rise tab to use this source.</p>
        )}
        {source === 'tab' && liveReady && (
          <p className="hint" style={{ marginTop: 6 }}>
            {editorCourseId ? (
              <>
                Course open in the editor: <b>{editorCourseId}</b>
                {session?.plane ? ` (${session.plane.toUpperCase()})` : ''}
              </>
            ) : (
              <>
                No course editor open — open the course at
                rise…/authoring/… and it will appear here.
              </>
            )}
          </p>
        )}

        {/* Format + generate */}
        <select
          value={format}
          onChange={(e) => setFormat(e.target.value as DocxFormat)}
          disabled={busy}
          style={{ width: '100%', marginTop: 8 }}
        >
          <option value="prose">Prose (flowing document)</option>
          <option value="storyboard">Storyboard (table)</option>
        </select>
        <button
          onClick={() => void generate()}
          disabled={!courseId || busy || (source !== 'archive' && !liveReady)}
          style={{ marginTop: 8 }}
        >
          {busy
            ? source === 'archive'
              ? 'Generating…'
              : 'Fetching…'
            : 'Generate .docx'}
        </button>
        {source !== 'archive' && (
          <p className="hint">
            Fetched in memory and rendered — nothing is written to the archive.
            Use Export Data to archive a course.
          </p>
        )}
        {error && (
          <p className="hint" style={{ color: '#c00' }}>
            ⚠ {error}
          </p>
        )}
      </section>

      {rendered && stats && (
        <section className="card">
          <h2>Result</h2>
          <p>
            ✔ Downloaded: <b>{rendered.fileName}</b>
          </p>
          <p className="hint">
            {rendered.model.lessons.length} lessons ·{' '}
            {rendered.model.blockCount} blocks · {stats.edit} editable ·{' '}
            {stats.ro} read-only · {stats.images} with images
            {rendered.model.locale
              ? ` · language: ${rendered.model.locale}`
              : ''}
          </p>
          {rendered.model.flags.length > 0 && (
            <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 12 }}>
              {rendered.model.flags.map((f, i) => (
                <li key={i} style={{ color: '#c00' }}>
                  ⚠ {f}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
