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
  type BlockIntent,
  type PlannedBlock,
  type PlannedCourse,
  type SbCourse,
} from '@/core/storyboard';
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
  text: 'Teksts',
  list: 'Saraksts',
  accordion: 'Accordion',
  tabs: 'Tabs',
  flashcards: 'Flipcards',
  process: 'Process',
  timeline: 'Timeline',
  sorting: 'Kārtošana',
  'knowledge-check': 'Zināšanu pārbaude',
  note: 'Note',
  links: 'Pogu saraksts (saites)',
  'video-placeholder': 'Video — aizvietotājs',
  'storyline-placeholder': 'Storyline/Mighty — aizvietotājs',
  continue: 'Turpināt (poga)',
  'attachment-placeholder': 'Pielikums — aizvietotājs',
};

function IntentSummary({ intent }: { intent: BlockIntent }) {
  switch (intent.kind) {
    case 'text':
      return <p className="summary">{intent.heading ?? '(bez virsraksta)'} · {intent.paragraphs.length} rindkopa(s)</p>;
    case 'list':
      return <p className="summary">{intent.heading ?? ''} · {intent.items.length} punkti ({intent.ordered ? 'numurēts' : 'aizzīmes'})</p>;
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
          {intent.piles.length} kategorijas · {intent.cards.length} kartītes ({intent.piles.join(' / ')})
        </p>
      );
    case 'knowledge-check':
      return (
        <div className="summary">
          {intent.questions.map((q, i) => (
            <p key={i}>
              J{i + 1}: {q.stem.replace(/<[^>]+>/g, '').slice(0, 80)} — {q.options.length} varianti,{' '}
              {q.options.filter((o) => o.correct).length} pareizi{q.feedback ? ', ar atgriezenisko saiti' : ''}
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
            <summary>Avota teksts (SD šūna)</summary>
            <pre>{provenance.rawScreenText}</pre>
            {provenance.comments && <p className="hint">Komentāri: {provenance.comments}</p>}
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
  // Only the FIRST block of an SD row carries the source-cell toggle — the
  // follow-up blocks (continue gates, placeholders) share the same cell.
  let lastRow = -1;
  return (
    <table className="plan-table">
      <thead>
        <tr>
          <th className="col-slide">Slaids</th>
          <th className="col-kind">Bloka tips</th>
          <th className="col-content">Saturs</th>
          <th className="col-notes">Brīdinājumi</th>
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

  // Restore the archive folder the panel already uses (shared IndexedDB handle).
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
        setError('File System Access API nav pieejams šajā pārlūkā.');
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
        throw new Error('Arhīva mapei nav rakstīšanas atļaujas.');
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
        INTEA scenārija dokuments (.docx) → rediģējams Rise kurss. Parsēšana notiek lokāli;
        pēc apstiprināšanas kurss nonāk arhīva mapē un to importē parastā Import plūsma
        (side panel → Import → C · Courses).
      </p>

      <section className="card">
        <h2>1 · Scenārija dokuments</h2>
        <input
          type="file"
          accept=".docx"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pickDocx(f);
          }}
        />
        {fileName && <p className="hint">Ielasīts: {fileName}</p>}
        {error && <p className="error">⚠ {error}</p>}
      </section>

      {planned && stats && (
        <>
          <section className="card">
            <h2>2 · Pārskats</h2>
            <p>
              <b>{planned.title}</b>
            </p>
            <p className="hint">
              {planned.lessons.length} nodarbības · {stats.rows} atpazītas rindas ·{' '}
              {stats.placeholders} aizvietotāji (video / Storyline) · {planned.production.length}{' '}
              filmēšanas skripti · <b className={planned.unparsed.length ? 'error' : ''}>{planned.unparsed.length} neatpazītas rindas</b>
            </p>
          </section>

          {planned.unparsed.length > 0 && (
            <section className="card card-danger">
              <h2>⚠ Neatpazītas rindas — netiks importētas</h2>
              <table className="plan-table">
                <thead>
                  <tr>
                    <th className="col-slide">Slaids</th>
                    <th className="col-kind">Bloka tips</th>
                    <th className="col-content">Saturs (avots)</th>
                    <th className="col-notes">Brīdinājumi</th>
                  </tr>
                </thead>
                <tbody>
                  {planned.unparsed.map((u, i) => (
                    <tr key={i}>
                      <td className="col-slide">
                        {u.provenance.slideNo != null ? u.provenance.slideNo : `r${u.provenance.tableRow}`}
                      </td>
                      <td className="col-kind">
                        <span className="chip chip-unparsed">Neatpazīts</span>
                      </td>
                      <td className="col-content">
                        <p className="summary">{u.provenance.experience.replace(/\s+/g, ' ')}</p>
                        <details>
                          <summary>Avota teksts</summary>
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
                <p className="hint">(nav bloku)</p>
              )}
            </section>
          ))}

          <section className="card">
            <h2>3 · Apstiprināt un ierakstīt arhīvā</h2>
            {!folder && (
              <p className="hint">
                Arhīva mape nav pievienota — izvēlies to pašu mapi, ko lieto side panel.
              </p>
            )}
            {folder && folderNeedsGrant && (
              <p className="hint">Mape “{folder.name}” atcerēta, bet vajag atļauju.</p>
            )}
            {(!folder || folderNeedsGrant) && (
              <button onClick={connectFolder}>
                {folder ? `Atjaunot piekļuvi: ${folder.name}` : 'Pievienot arhīva mapi…'}
              </button>
            )}
            {folder && !folderNeedsGrant && <p className="hint">Arhīva mape: {folder.name}</p>}
            {planned.unparsed.length > 0 && (
              <label className="ack">
                <input
                  type="checkbox"
                  checked={ackUnparsed}
                  onChange={(e) => setAckUnparsed(e.target.checked)}
                />{' '}
                Apzinos: {planned.unparsed.length} neatpazītā(s) rinda(s) netiks importēta(s) un
                būs jāpievieno ar roku.
              </label>
            )}
            <button className="approve" onClick={approve} disabled={!canApprove}>
              {writing ? 'Raksta…' : 'Apstiprināt → ierakstīt arhīvā'}
            </button>
            {written && (
              <div className="done">
                <p>
                  ✔ Ierakstīts: <b>{written.title}</b> ({written.courseId})
                </p>
                <ul>
                  <li>{written.courseFile}</li>
                  <li>{written.planFile}</li>
                  <li>{written.productionFile} — filmēšanas skripti ekspertiem</li>
                </ul>
                <p className="hint">
                  Tālāk: atver side panel → Import (write) → C · Courses — jaunais kurss ir
                  sarakstā. Aizvietotāji (video, Storyline/Mighty) pēc importa jāaizpilda ar roku.
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

function sanitizeFileName(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|]/g, '·').replace(/\s+/g, ' ').trim();
  return clean === '' ? 'kurss' : clean.slice(0, 120);
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

function ExportDocxView() {
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [folderNeedsGrant, setFolderNeedsGrant] = useState(false);
  const [courses, setCourses] = useState<ManifestCourseEntry[] | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState<{ model: SbCourse; fileName: string } | null>(null);

  // Same shared archive-folder handle the panel and the import mode use.
  useEffect(() => {
    void (async () => {
      const handle = await loadDirHandle();
      if (!handle) return;
      setFolder(handle);
      setFolderNeedsGrant(!(await verifyPermission(handle, false)));
    })();
  }, []);

  // Course list: manifest first (has titles), saved course files as fallback.
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
        setError('File System Access API nav pieejams šajā pārlūkā.');
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
      if (!raw) throw new Error(`courses/${selected}.json nav atrasts arhīvā.`);
      const doc = JSON.parse(raw) as GetCourseDocument;
      const { model, bytes } = renderStoryboardDocx(doc, {
        generatedAt: new Date().toISOString(),
        toolVersion: browser.runtime.getManifest().version,
      });
      const fileName = `${sanitizeFileName(model.title)} — storyboard.docx`;
      downloadDocx(fileName, bytes);
      setRendered({ model, fileName });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, [folder, selected, busy]);

  const stats = useMemo(() => {
    if (!rendered) return null;
    const rows = rendered.model.lessons.flatMap((l) => l.rows);
    return {
      edit: rows.filter((r) => r.fidelity === 'edit').length,
      ro: rows.filter((r) => r.fidelity === 'ro').length,
    };
  }, [rendered]);

  return (
    <>
      <p className="hint">
        Arhivēts Rise kurss → SBDOC storyboard (.docx) klienta pārskatīšanai un rediģēšanai
        ārpus Rise (formāts: docs/rise-storyboard-format.md). Tikai lasa arhīvu — dokuments
        lejupielādējas, arhīvā nekas netiek rakstīts. Kurss vispirms jāeksportē ar parasto
        Export plūsmu.
      </p>

      <section className="card">
        <h2>1 · Arhīva mape</h2>
        {(!folder || folderNeedsGrant) && (
          <>
            {folder && folderNeedsGrant && (
              <p className="hint">Mape “{folder.name}” atcerēta, bet vajag atļauju.</p>
            )}
            <button onClick={connectFolder}>
              {folder ? `Atjaunot piekļuvi: ${folder.name}` : 'Pievienot arhīva mapi…'}
            </button>
          </>
        )}
        {folder && !folderNeedsGrant && <p className="hint">Arhīva mape: {folder.name}</p>}
      </section>

      {folder && !folderNeedsGrant && (
        <section className="card">
          <h2>2 · Kurss</h2>
          {courses === null && <p className="hint">Lasa arhīvu…</p>}
          {courses !== null && courses.length === 0 && (
            <p className="hint">Arhīvā nav neviena kursa — vispirms eksportē (side panel → Export).</p>
          )}
          {courses !== null && courses.length > 0 && (
            <>
              <select value={selected} onChange={(e) => setSelected(e.target.value)}>
                <option value="">— izvēlies kursu —</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {typeof c.title === 'string' && c.title !== '' ? c.title : c.id}
                  </option>
                ))}
              </select>{' '}
              <button className="approve" onClick={generate} disabled={!selected || busy}>
                {busy ? 'Ģenerē…' : 'Ģenerēt .docx'}
              </button>
            </>
          )}
          {error && <p className="error">⚠ {error}</p>}
        </section>
      )}

      {rendered && stats && (
        <section className="card">
          <h2>3 · Rezultāts</h2>
          <p>
            ✔ Lejupielādēts: <b>{rendered.fileName}</b>
          </p>
          <p className="hint">
            {rendered.model.lessons.length} nodarbības · {rendered.model.blockCount} bloki ·{' '}
            {stats.edit} rediģējami · {stats.ro} tikai skatīšanai
            {rendered.model.locale ? ` · valoda: ${rendered.model.locale}` : ''}
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
          SD → Rise (imports)
        </button>
        <button className={mode === 'export' ? 'mode-active' : ''} onClick={() => setMode('export')}>
          Rise → docx (storyboard)
        </button>
      </nav>
      {mode === 'import' ? <ImportView /> : <ExportDocxView />}
    </div>
  );
}
