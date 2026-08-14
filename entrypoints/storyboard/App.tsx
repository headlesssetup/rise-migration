// Storyboard ⇄ Rise tab — two modes:
//   SD → Rise (docs/rise-storyboard-plan.md phase 3): full-page REVIEW is the
//   only gate to import — pick the SD .docx → parse locally (no auth, no
//   network) → review every planned block beside its source cell → approve →
//   the synthetic archive course lands in the archive folder for the normal
//   Import flow. Unparsed rows must be explicitly acknowledged.
//   Rise → docx (docs/rise-storyboard-format.md): render an ARCHIVED course as
//   an SBDOC storyboard docx for client review / out-of-Rise editing. Pure
//   read of the archive; the .docx downloads, nothing else is written.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileSystemStorage } from '@/core/storage/fs';
import {
  buildArchiveCourse,
  parseSdDocx,
  parseStoryboard,
  renderStoryboardDocx,
  renderStoryboardDocxV2,
  writeStoryboardDocxProse,
  type BlockIntent,
  type PlannedBlock,
  type PlannedCourse,
  type ResolvedImage,
  type SbCourse,
} from '@/core/storyboard';
import type { AssetManifest } from '@/core/assets/manifest';
import type { GetCourseDocument } from '@/shared/types/rise';
import {
  loadDirHandle,
  saveDirHandle,
  verifyPermission,
} from '../sidepanel/folder-store';
import {
  parseManifestCourses,
  type ManifestCourseEntry,
} from '../sidepanel/archive-merge';
import { writeBuiltCourse, type WrittenFiles } from './write';

type DirPicker = (opts?: {
  mode?: 'read' | 'readwrite';
}) => Promise<FileSystemDirectoryHandle>;

type DocxFormat = 'prose' | 'storyboard';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Placeholder kinds land amber in review; everything else is auto-built. */
function chipClass(kind: BlockIntent['kind']): string {
  return kind === 'video-placeholder' ||
    kind === 'storyline-placeholder' ||
    kind === 'attachment-placeholder'
    ? 'chip chip-placeholder'
    : 'chip chip-auto';
}

const KIND_LABEL: Record<BlockIntent['kind'], string> = {
  text: 'Text',
  list: 'List',
  accordion: 'Accordion',
  tabs: 'Tabs',
  flashcards: 'Flashcards',
  process: 'Process',
  timeline: 'Timeline',
  sorting: 'Sorting',
  'knowledge-check': 'Knowledge check',
  note: 'Note',
  links: 'Buttons (links)',
  'video-placeholder': 'Video — placeholder',
  'storyline-placeholder': 'Storyline/Mighty — placeholder',
  continue: 'Continue (button)',
  'attachment-placeholder': 'Attachment — placeholder',
};

function IntentSummary({ intent }: { intent: BlockIntent }) {
  switch (intent.kind) {
    case 'text':
      return <p className="summary">{intent.heading ?? '(no heading)'} · {intent.paragraphs.length} paragraph(s)</p>;
    case 'list':
      return <p className="summary">{intent.heading ?? ''} · {intent.items.length} items ({intent.ordered ? 'numbered' : 'bullets'})</p>;
    case 'accordion':
    case 'tabs':
    case 'flashcards':
    case 'process':
      return (
        <div className="summary">
          {intent.heading && <p>{intent.heading}</p>}
          <ul>
            {intent.items.map((it, i) => (
              <li key={i}>{it.title}</li>
            ))}
          </ul>
        </div>
      );
    case 'timeline':
      return (
        <div className="summary">
          <ul>
            {intent.events.map((e, i) => (
              <li key={i}>
                <b>{e.date}</b> — {e.title}
                {e.body && ` (${e.body.replace(/<[^>]+>/g, '')})`}
              </li>
            ))}
          </ul>
        </div>
      );
    case 'sorting':
      return (
        <p className="summary">
          {intent.piles.length} categories · {intent.cards.length} cards ({intent.piles.join(' / ')})
        </p>
      );
    case 'knowledge-check':
      return (
        <div className="summary">
          {intent.questions.map((q, i) => (
            <p key={i}>
              Q{i + 1}: {q.stem.replace(/<[^>]+>/g, '').slice(0, 80)} — {q.options.length} options,{' '}
              {q.options.filter((o) => o.correct).length} correct{q.feedback ? ', with feedback' : ''}
            </p>
          ))}
        </div>
      );
    case 'note':
      return <p className="summary">{intent.paragraphs.join(' ').replace(/<[^>]+>/g, '').slice(0, 120)}</p>;
    case 'links':
      return (
        <div className="summary">
          {intent.heading && <p>{intent.heading}</p>}
          <ul>
            {intent.buttons.map((b, i) => (
              <li key={i}>
                {b.label} → {b.destination}
              </li>
            ))}
          </ul>
        </div>
      );
    case 'video-placeholder':
    case 'storyline-placeholder':
    case 'attachment-placeholder':
      return <p className="summary">{intent.label}</p>;
    case 'continue':
      return <p className="summary">[{intent.label}]</p>;
  }
}

function BlockRow({ block, showSource }: { block: PlannedBlock; showSource: boolean }) {
  const { intent, provenance, notes } = block;
  return (
    <tr>
      <td className="col-slide">
        {provenance.slideNo != null ? provenance.slideNo : `r${provenance.tableRow}`}
      </td>
      <td className="col-kind">
        <span className={chipClass(intent.kind)}>{KIND_LABEL[intent.kind]}</span>
      </td>
      <td className="col-content">
        <IntentSummary intent={intent} />
        {showSource && (
          <details>
            <summary>Source text (SD cell)</summary>
            <pre>{provenance.rawScreenText}</pre>
            {provenance.comments && <p className="hint">Comments: {provenance.comments}</p>}
          </details>
        )}
      </td>
      <td className="col-notes">
        {notes.length > 0 && (
          <ul className="notes">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

function LessonTable({ blocks }: { blocks: PlannedBlock[] }) {
  let lastRow = -1;
  return (
    <table className="plan-table">
      <thead>
        <tr>
          <th className="col-slide">Slide</th>
          <th className="col-kind">Block type</th>
          <th className="col-content">Content</th>
          <th className="col-notes">Warnings</th>
        </tr>
      </thead>
      <tbody>
        {blocks.map((b, j) => {
          const showSource = b.provenance.tableRow !== lastRow;
          lastRow = b.provenance.tableRow;
          return <BlockRow block={b} showSource={showSource} key={j} />;
        })}
      </tbody>
    </table>
  );
}

function ImportView() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [planned, setPlanned] = useState<PlannedCourse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [folderNeedsGrant, setFolderNeedsGrant] = useState(false);
  const [ackUnparsed, setAckUnparsed] = useState(false);
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState<(WrittenFiles & { courseId: string; title: string }) | null>(null);

  useEffect(() => {
    void (async () => {
      const handle = await loadDirHandle();
      if (!handle) return;
      if (await verifyPermission(handle, false)) setFolder(handle);
      else {
        setFolder(handle);
        setFolderNeedsGrant(true);
      }
    })();
  }, []);

  const pickDocx = useCallback(async (file: File) => {
    setError(null);
    setPlanned(null);
    setWritten(null);
    setAckUnparsed(false);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sd = parseSdDocx(bytes);
      const plan = parseStoryboard(sd);
      setFileName(file.name);
      setPlanned(plan);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  const connectFolder = useCallback(async () => {
    try {
      if (folder && folderNeedsGrant) {
        if (await verifyPermission(folder, true)) {
          setFolderNeedsGrant(false);
          return;
        }
      }
      const picker = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;
      if (!picker) {
        setError('File System Access API is not available in this browser.');
        return;
      }
      const handle = await picker({ mode: 'readwrite' });
      await saveDirHandle(handle);
      setFolder(handle);
      setFolderNeedsGrant(false);
    } catch {
      /* user cancelled */
    }
  }, [folder, folderNeedsGrant]);

  const approve = useCallback(async () => {
    if (!planned || !folder || writing) return;
    setWriting(true);
    setError(null);
    try {
      if (!(await verifyPermission(folder, true))) {
        throw new Error('No write permission for the archive folder.');
      }
      const generatedAt = new Date().toISOString();
      const built = buildArchiveCourse(planned, generatedAt);
      const storage = new FileSystemStorage(folder);
      const files = await writeBuiltCourse(storage, built, generatedAt);
      setWritten({ ...files, courseId: built.courseId, title: planned.title });
    } catch (e) {
      setError(errText(e));
    } finally {
      setWriting(false);
    }
  }, [planned, folder, writing]);

  const stats = useMemo(() => {
    if (!planned) return null;
    const rows = planned.lessons.reduce((s, l) => s + l.blocks.length, 0);
    const placeholders = planned.lessons.reduce(
      (s, l) =>
        s +
        l.blocks.filter(
          (b) => b.intent.kind === 'video-placeholder' || b.intent.kind === 'storyline-placeholder',
        ).length,
      0,
    );
    return { rows, placeholders };
  }, [planned]);

  const canApprove =
    !!planned &&
    !!folder &&
    !folderNeedsGrant &&
    !writing &&
    planned.lessons.length > 0 &&
    (planned.unparsed.length === 0 || ackUnparsed);

  return (
    <>
      <p className="hint">
        INTEA storyboard document (.docx) → editable Rise course. Parsing happens locally;
        after approval the course is written to the archive folder and imported via the normal
        Import flow (side panel → Import → C · Courses).
      </p>

      <section className="card">
        <h2>1 · Storyboard document</h2>
        <input
          type="file"
          accept=".docx"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pickDocx(f);
          }}
        />
        {fileName && <p className="hint">Loaded: {fileName}</p>}
        {error && <p className="error">⚠ {error}</p>}
      </section>

      {planned && stats && (
        <>
          <section className="card">
            <h2>2 · Review</h2>
            <p>
              <b>{planned.title}</b>
            </p>
            <p className="hint">
              {planned.lessons.length} lessons · {stats.rows} recognized rows ·{' '}
              {stats.placeholders} placeholders (video / Storyline) · {planned.production.length}{' '}
              production scripts · <b className={planned.unparsed.length ? 'error' : ''}>{planned.unparsed.length} unrecognized rows</b>
            </p>
          </section>

          {planned.unparsed.length > 0 && (
            <section className="card card-danger">
              <h2>⚠ Unrecognized rows — will not be imported</h2>
              <table className="plan-table">
                <thead>
                  <tr>
                    <th className="col-slide">Slide</th>
                    <th className="col-kind">Block type</th>
                    <th className="col-content">Content (source)</th>
                    <th className="col-notes">Warnings</th>
                  </tr>
                </thead>
                <tbody>
                  {planned.unparsed.map((u, i) => (
                    <tr key={i}>
                      <td className="col-slide">
                        {u.provenance.slideNo != null ? u.provenance.slideNo : `r${u.provenance.tableRow}`}
                      </td>
                      <td className="col-kind">
                        <span className="chip chip-unparsed">Unrecognized</span>
                      </td>
                      <td className="col-content">
                        <p className="summary">{u.provenance.experience.replace(/\s+/g, ' ')}</p>
                        <details>
                          <summary>Source text</summary>
                          <pre>{u.provenance.rawScreenText}</pre>
                        </details>
                      </td>
                      <td className="col-notes">
                        <ul className="notes">
                          <li className="error">{u.reason}</li>
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {planned.lessons.map((l, i) => (
            <section className="card" key={i}>
              <h2>
                {i + 1} / {planned.lessons.length} · {l.title}
              </h2>
              {l.blocks.length > 0 ? (
                <LessonTable blocks={l.blocks} />
              ) : (
                <p className="hint">(no blocks)</p>
              )}
            </section>
          ))}

          <section className="card">
            <h2>3 · Approve and write to archive</h2>
            {!folder && (
              <p className="hint">
                Archive folder not connected — select the same folder the side panel uses.
              </p>
            )}
            {folder && folderNeedsGrant && (
              <p className="hint">Folder "{folder.name}" remembered, but permission needed.</p>
            )}
            {(!folder || folderNeedsGrant) && (
              <button onClick={connectFolder}>
                {folder ? `Restore access: ${folder.name}` : 'Connect archive folder…'}
              </button>
            )}
            {folder && !folderNeedsGrant && <p className="hint">Archive folder: {folder.name}</p>}
            {planned.unparsed.length > 0 && (
              <label className="ack">
                <input
                  type="checkbox"
                  checked={ackUnparsed}
                  onChange={(e) => setAckUnparsed(e.target.checked)}
                />{' '}
                Acknowledged: {planned.unparsed.length} unrecognized row(s) will not be imported and
                must be added manually.
              </label>
            )}
            <button className="approve" onClick={approve} disabled={!canApprove}>
              {writing ? 'Writing…' : 'Approve → write to archive'}
            </button>
            {written && (
              <div className="done">
                <p>
                  ✔ Written: <b>{written.title}</b> ({written.courseId})
                </p>
                <ul>
                  <li>{written.courseFile}</li>
                  <li>{written.planFile}</li>
                  <li>{written.productionFile} — production scripts for experts</li>
                </ul>
                <p className="hint">
                  Next: open the side panel → Import (write) → C · Courses — the new course is
                  in the list. Placeholders (video, Storyline/Mighty) must be filled in manually after import.
                </p>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------- Rise → docx ---

const RASTER_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

function sanitizeFileName(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|]/g, '·').replace(/\s+/g, ' ').trim();
  return clean === '' ? 'course' : clean.slice(0, 120);
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

async function resolveImages(
  model: SbCourse,
  storage: FileSystemStorage,
  courseId: string,
): Promise<Map<string, ResolvedImage>> {
  const images = new Map<string, ResolvedImage>();
  const manifestJson = await storage.readAssetManifest('courses', courseId);
  if (!manifestJson) return images;
  const manifest: AssetManifest = JSON.parse(manifestJson);
  const keyToEntry = new Map(manifest.assets.map((a) => [a.key, a]));
  const needed = new Set<string>();
  for (const lesson of model.lessons) {
    for (const row of lesson.rows) {
      if (row.image?.key) needed.add(row.image.key);
    }
  }
  for (const key of needed) {
    const entry = keyToEntry.get(key);
    if (!entry || !RASTER_EXTS.has(entry.ext)) continue;
    const bytes = await storage.readAsset(`${entry.hash}.${entry.ext}`);
    if (!bytes) continue;
    const row = model.lessons
      .flatMap((l) => l.rows)
      .find((r) => r.image?.key === key);
    images.set(key, {
      key,
      bytes,
      ext: entry.ext === 'jpeg' ? 'jpg' : entry.ext,
      width: row?.image?.width ?? 800,
      height: row?.image?.height ?? 600,
    });
  }
  return images;
}

function ExportDocxView() {
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [folderNeedsGrant, setFolderNeedsGrant] = useState(false);
  const [courses, setCourses] = useState<ManifestCourseEntry[] | null>(null);
  const [selected, setSelected] = useState('');
  const [format, setFormat] = useState<DocxFormat>('prose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState<{ model: SbCourse; fileName: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const handle = await loadDirHandle();
      if (!handle) return;
      setFolder(handle);
      setFolderNeedsGrant(!(await verifyPermission(handle, false)));
    })();
  }, []);

  useEffect(() => {
    if (!folder || folderNeedsGrant) return;
    void (async () => {
      try {
        const storage = new FileSystemStorage(folder);
        const fromManifest = parseManifestCourses(await storage.readManifest());
        if (fromManifest.length > 0) {
          setCourses(fromManifest);
          return;
        }
        setCourses((await storage.listSaved()).map((id) => ({ id })));
      } catch (e) {
        setError(errText(e));
        setCourses([]);
      }
    })();
  }, [folder, folderNeedsGrant]);

  const connectFolder = useCallback(async () => {
    try {
      if (folder && folderNeedsGrant && (await verifyPermission(folder, false))) {
        setFolderNeedsGrant(false);
        return;
      }
      const picker = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;
      if (!picker) {
        setError('File System Access API is not available in this browser.');
        return;
      }
      const handle = await picker({ mode: 'read' });
      await saveDirHandle(handle);
      setFolder(handle);
      setFolderNeedsGrant(false);
    } catch {
      /* user cancelled */
    }
  }, [folder, folderNeedsGrant]);

  const generate = useCallback(async () => {
    if (!folder || !selected || busy) return;
    setBusy(true);
    setError(null);
    setRendered(null);
    try {
      const storage = new FileSystemStorage(folder);
      const raw = await storage.readCourse(selected);
      if (!raw) throw new Error(`courses/${selected}.json not found in archive.`);
      const doc = JSON.parse(raw) as GetCourseDocument;
      const opts = {
        generatedAt: new Date().toISOString(),
        toolVersion: browser.runtime.getManifest().version,
      };

      let model: SbCourse;
      let bytes: Uint8Array;
      if (format === 'prose') {
        const result = renderStoryboardDocxV2(doc, opts);
        model = result.model;
        const images = await resolveImages(model, storage, selected);
        bytes = writeStoryboardDocxProse(model, images);
      } else {
        const result = renderStoryboardDocx(doc, opts);
        model = result.model;
        bytes = result.bytes;
      }

      const suffix = format === 'prose' ? 'prose' : 'storyboard';
      const fileName = `${sanitizeFileName(model.title)} — ${suffix}.docx`;
      downloadDocx(fileName, bytes);
      setRendered({ model, fileName });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [folder, selected, format, busy]);

  const stats = useMemo(() => {
    if (!rendered) return null;
    const rows = rendered.model.lessons.flatMap((l) => l.rows);
    return {
      edit: rows.filter((r) => r.fidelity === 'edit').length,
      ro: rows.filter((r) => r.fidelity === 'ro').length,
      images: rows.filter((r) => r.image).length,
    };
  }, [rendered]);

  return (
    <>
      <p className="hint">
        Archived Rise course → docx for client review and editing outside Rise.
        Read-only — the document downloads, nothing is written to the archive.
        The course must be exported first via the normal Export flow.
      </p>

      <section className="card">
        <h2>1 · Archive folder</h2>
        {(!folder || folderNeedsGrant) && (
          <>
            {folder && folderNeedsGrant && (
              <p className="hint">Folder "{folder.name}" remembered, but permission needed.</p>
            )}
            <button onClick={connectFolder}>
              {folder ? `Restore access: ${folder.name}` : 'Connect archive folder…'}
            </button>
          </>
        )}
        {folder && !folderNeedsGrant && <p className="hint">Archive folder: {folder.name}</p>}
      </section>

      {folder && !folderNeedsGrant && (
        <section className="card">
          <h2>2 · Course</h2>
          {courses === null && <p className="hint">Reading archive…</p>}
          {courses !== null && courses.length === 0 && (
            <p className="hint">No courses in the archive — export courses first (side panel → Export).</p>
          )}
          {courses !== null && courses.length > 0 && (
            <>
              <select value={selected} onChange={(e) => setSelected(e.target.value)}>
                <option value="">— select a course —</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {typeof c.title === 'string' && c.title !== '' ? c.title : c.id}
                  </option>
                ))}
              </select>{' '}
              <select value={format} onChange={(e) => setFormat(e.target.value as DocxFormat)}>
                <option value="prose">Prose (flowing document)</option>
                <option value="storyboard">Storyboard (table)</option>
              </select>{' '}
              <button className="approve" onClick={generate} disabled={!selected || busy}>
                {busy ? 'Generating…' : 'Generate .docx'}
              </button>
            </>
          )}
          {error && <p className="error">⚠ {error}</p>}
        </section>
      )}

      {rendered && stats && (
        <section className="card">
          <h2>3 · Result</h2>
          <p>
            ✔ Downloaded: <b>{rendered.fileName}</b>
          </p>
          <p className="hint">
            {rendered.model.lessons.length} lessons · {rendered.model.blockCount} blocks ·{' '}
            {stats.edit} editable · {stats.ro} read-only · {stats.images} with images
            {rendered.model.locale ? ` · language: ${rendered.model.locale}` : ''}
          </p>
          {rendered.model.flags.length > 0 && (
            <ul className="notes">
              {rendered.model.flags.map((f, i) => (
                <li key={i} className="error">
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

export function App() {
  const [mode, setMode] = useState<'import' | 'export'>('import');
  return (
    <div className="app">
      <h1>Storyboard ⇄ Rise</h1>
      <nav className="mode-nav">
        <button className={mode === 'import' ? 'mode-active' : ''} onClick={() => setMode('import')}>
          SD → Rise (import)
        </button>
        <button className={mode === 'export' ? 'mode-active' : ''} onClick={() => setMode('export')}>
          Rise → docx (export)
        </button>
      </nav>
      {mode === 'import' ? <ImportView /> : <ExportDocxView />}
    </div>
  );
}
