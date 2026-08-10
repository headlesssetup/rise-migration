// Storyboard → Rise converter tab (docs/rise-storyboard-plan.md phase 3).
//
// Full-page REVIEW is the only gate to import: pick the SD .docx → parse
// locally (no auth, no network) → review every planned block beside its source
// cell → approve → the synthetic archive course is written into the operator's
// archive folder, where the normal Import flow picks it up. Unparsed rows are
// surfaced loudly and must be explicitly acknowledged before approval.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileSystemStorage } from '@/core/storage/fs';
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
import { writeBuiltCourse, type WrittenFiles } from './write';

type DirPicker = (opts?: {
  mode?: 'read' | 'readwrite';
}) => Promise<FileSystemDirectoryHandle>;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Placeholder kinds land amber in review; everything else is auto-built. */
function chipClass(kind: BlockIntent['kind']): string {
  return kind === 'video-placeholder' || kind === 'storyline-placeholder'
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
                <b>{e.date}</b> — {e.body.replace(/<[^>]+>/g, '')}
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
      return <p className="summary">{intent.label}</p>;
  }
}

function BlockCard({ block }: { block: PlannedBlock }) {
  const { intent, provenance, notes } = block;
  return (
    <div className="block-card">
      <div className="block-head">
        <span className={chipClass(intent.kind)}>{KIND_LABEL[intent.kind]}</span>
        <span className="slide">
          {provenance.slideNo != null ? `Slaids ${provenance.slideNo}` : `Rinda ${provenance.tableRow}`}
        </span>
        <span className="exp">{provenance.experience.replace(/\s+/g, ' ').slice(0, 80)}</span>
      </div>
      <IntentSummary intent={intent} />
      {notes.length > 0 && (
        <ul className="notes">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <details>
        <summary>Avota teksts (SD šūna)</summary>
        <pre>{provenance.rawScreenText}</pre>
        {provenance.comments && <p className="hint">Komentāri: {provenance.comments}</p>}
      </details>
    </div>
  );
}

export function App() {
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
    <div className="app">
      <h1>Storyboard → Rise</h1>
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
              {planned.unparsed.map((u, i) => (
                <div className="block-card" key={i}>
                  <div className="block-head">
                    <span className="chip chip-unparsed">Neatpazīts</span>
                    <span className="slide">
                      {u.provenance.slideNo != null ? `Slaids ${u.provenance.slideNo}` : `Rinda ${u.provenance.tableRow}`}
                    </span>
                    <span className="exp">{u.provenance.experience.replace(/\s+/g, ' ').slice(0, 80)}</span>
                  </div>
                  <p className="error">{u.reason}</p>
                  <details>
                    <summary>Avota teksts</summary>
                    <pre>{u.provenance.rawScreenText}</pre>
                  </details>
                </div>
              ))}
            </section>
          )}

          {planned.lessons.map((l, i) => (
            <section className="card" key={i}>
              <h2>
                {i + 1} / {planned.lessons.length} · {l.title}
              </h2>
              {l.blocks.map((b, j) => (
                <BlockCard block={b} key={j} />
              ))}
              {l.blocks.length === 0 && <p className="hint">(nav bloku)</p>}
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
    </div>
  );
}
