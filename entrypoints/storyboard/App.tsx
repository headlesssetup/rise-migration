// Rise Creator tab — local source review and package creation only:
//   SD → Rise (docs/rise-storyboard-plan.md phase 3): full-page REVIEW is the
//   only gate to import — pick the SD .docx → parse locally (no auth, no
//   network) → review every planned block beside its source cell → approve →
//   the synthetic archive course lands in the archive folder for the normal
//   Import flow. Unparsed rows must be explicitly acknowledged.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileSystemStorage } from '@/core/storage/fs';
import { registryWarnings as templateRegistryWarnings } from '@/core/rise-format';
import {
  buildArchiveCourse,
  parseSdDocx,
  parseStoryboard,
  type BlockIntent,
  type PlannedBlock,
  type PlannedCourse,
} from '@/core/storyboard';
import {
  loadDirHandle,
  saveDirHandle,
  verifyPermission,
} from '../sidepanel/folder-store';
import {
  readCreatorBuildWarning,
  writeBuiltCourse,
  type WrittenFiles,
} from './write';

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
  const [folderBuildWarning, setFolderBuildWarning] = useState<string | null>(null);
  const [ackUnparsed, setAckUnparsed] = useState(false);
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState<
    (WrittenFiles & { courseId: string; title: string; registryWarnings: string[] }) | null
  >(null);

  useEffect(() => {
    void (async () => {
      const handle = await loadDirHandle();
      if (!handle) return;
      if (await verifyPermission(handle, false)) {
        setFolder(handle);
        setFolderBuildWarning(
          await readCreatorBuildWarning(new FileSystemStorage(handle)),
        );
      }
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
          setFolderBuildWarning(
            await readCreatorBuildWarning(new FileSystemStorage(folder)),
          );
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
      setFolderBuildWarning(
        await readCreatorBuildWarning(new FileSystemStorage(handle)),
      );
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
      const built = buildArchiveCourse(
        planned,
        generatedAt,
        undefined,
        undefined,
        fileName ?? undefined,
      );
      const storage = new FileSystemStorage(folder);
      const files = await writeBuiltCourse(
        storage,
        built,
        generatedAt,
        browser.runtime.getManifest().version,
        fileName ?? undefined,
      );
      setFolderBuildWarning(null);
      setWritten({
        ...files,
        courseId: built.courseId,
        title: planned.title,
        registryWarnings: built.registryWarnings,
      });
    } catch (e) {
      setError(errText(e));
    } finally {
      setWriting(false);
    }
  }, [planned, folder, writing, fileName]);

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
    const registryWarnings = templateRegistryWarnings(
      planned.lessons.flatMap((lesson) =>
        lesson.blocks.map((block) => block.intent.kind),
      ),
    );
    return { rows, placeholders, registryWarnings };
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
            {stats.registryWarnings.length > 0 && (
              <details>
                <summary className="hint">
                  {stats.registryWarnings.length} template(s) are compiler-tested but not yet
                  marked live-verified
                </summary>
                <ul className="notes">
                  {stats.registryWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
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
            {folderBuildWarning && <p className="error">⚠ {folderBuildWarning}</p>}
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
                  <li>{written.manifestFile}</li>
                  <li>{written.planFile}</li>
                  <li>{written.productionFile} — production scripts for experts</li>
                </ul>
                {written.priorBuildWarning && (
                  <p className="error">⚠ {written.priorBuildWarning}</p>
                )}
                {written.registryWarnings.length > 0 && (
                  <p className="hint">
                    Registry status: {written.registryWarnings.length} used template(s) are
                    compiler-tested but not yet marked live-verified. Details are in the blueprint artifact.
                  </p>
                )}
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

export function App() {
  return (
    <div className="app">
      <h1>Rise Creator</h1>
      <ImportView />
    </div>
  );
}
