// Review blueprint — SECOND page of the two-page Creator flow (v0.9.0):
// reads the staged raw text (`?b=<slot id>` → shared/creator-handoff.ts),
// RE-VALIDATES it (storage is never trusted as pre-validated), and hosts the
// pieces moved from the entry page: stats, registry warnings, unresolved
// acknowledgement, the pseudo-Rise <Preview>, the Creator-folder card, and
// "Approve → save package to disk" (compile + writeBuiltCourse, with the
// creator-manifest merge/refuse guard).
//
// The folder handle is the CREATOR key (folder-store CREATOR_FOLDER_KEY) — a
// dedicated staging folder, never silently the panel's archive. The panel's
// folder can be adopted with an explicit one-click seed.
//
// Future slot (deliberate): a second "Create in Rise account…" action lands
// HERE — rpc works from any extension page; this tab's lifetime would then be
// that job's lifetime.
// A missing/expired slot renders a dead-end card, never a guess.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  compileCourseBlueprint,
  validateBlueprint,
  type BlueprintValidation,
} from '@/core/creator';
import { registryWarnings as templateRegistryWarnings } from '@/core/rise-format';
import { FileSystemStorage } from '@/core/storage/fs';
import {
  getPendingBlueprint,
  removePendingBlueprint,
  type PendingBlueprint,
} from '@/shared/creator-handoff';
import {
  CREATOR_FOLDER_KEY,
  loadDirHandle,
  saveDirHandle,
  verifyPermission,
} from '../sidepanel/folder-store';
import { Preview } from '../creator/Preview';
import {
  readCreatorBuildWarning,
  writeBuiltCourse,
  type WrittenFiles,
} from '../creator/write';

type DirPicker = (opts?: {
  mode?: 'read' | 'readwrite';
}) => Promise<FileSystemDirectoryHandle>;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function slotIdFromLocation(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('b');
  } catch {
    return null;
  }
}

export function App() {
  const [slotId] = useState<string | null>(slotIdFromLocation);
  const [pending, setPending] = useState<PendingBlueprint | 'loading' | 'missing'>(
    'loading',
  );
  const [validation, setValidation] = useState<BlueprintValidation | null>(null);

  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [folderNeedsGrant, setFolderNeedsGrant] = useState(false);
  const [folderBuildWarning, setFolderBuildWarning] = useState<string | null>(null);
  /** The PANEL's archive folder, offered as an explicit one-click seed only. */
  const [panelFolder, setPanelFolder] = useState<FileSystemDirectoryHandle | null>(
    null,
  );
  const [ackUnresolved, setAckUnresolved] = useState(false);
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [written, setWritten] = useState<
    (WrittenFiles & { courseId: string; title: string; registryWarnings: string[] }) | null
  >(null);

  // Load the staged text and re-validate it.
  useEffect(() => {
    void (async () => {
      if (!slotId) {
        setPending('missing');
        return;
      }
      const p = await getPendingBlueprint(slotId);
      if (!p) {
        setPending('missing');
        return;
      }
      setPending(p);
      setValidation(validateBlueprint(p.pastedText));
    })();
  }, [slotId]);

  // Restore the Creator folder handle; surface the panel folder as a seed.
  useEffect(() => {
    void (async () => {
      const handle = await loadDirHandle(CREATOR_FOLDER_KEY);
      if (handle) {
        setFolder(handle);
        if (await verifyPermission(handle, false)) {
          setFolderBuildWarning(
            await readCreatorBuildWarning(new FileSystemStorage(handle)),
          );
        } else {
          setFolderNeedsGrant(true);
        }
        return;
      }
      setPanelFolder(await loadDirHandle());
    })();
  }, []);

  const adoptFolder = useCallback(async (handle: FileSystemDirectoryHandle) => {
    await saveDirHandle(handle, CREATOR_FOLDER_KEY);
    setFolder(handle);
    setFolderNeedsGrant(false);
    setFolderBuildWarning(
      await readCreatorBuildWarning(new FileSystemStorage(handle)),
    );
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
        setWriteError('File System Access API is not available in this browser.');
        return;
      }
      const handle = await picker({ mode: 'readwrite' });
      await adoptFolder(handle);
    } catch {
      /* user cancelled */
    }
  }, [folder, folderNeedsGrant, adoptFolder]);

  const usePanelFolder = useCallback(async () => {
    if (!panelFolder) return;
    try {
      if (!(await verifyPermission(panelFolder, true))) {
        setWriteError('No write permission for the panel folder.');
        return;
      }
      await adoptFolder(panelFolder);
    } catch (e) {
      setWriteError(errText(e));
    }
  }, [panelFolder, adoptFolder]);

  const blueprint = validation?.ready ? validation.blueprint : null;

  const stats = useMemo(() => {
    if (!blueprint) return null;
    const blocks = blueprint.lessons.flatMap((l) => l.blocks);
    const kinds = blocks.map((b) => b.intent.kind);
    return {
      blocks: blocks.length,
      kcs: kinds.filter((k) => k === 'knowledge-check').length,
      placeholders: kinds.filter((k) => k.endsWith('-placeholder')).length,
      suggested: blocks.filter((b) => b.origin === 'suggested').length,
      registryWarnings: templateRegistryWarnings(kinds),
    };
  }, [blueprint]);

  const approve = useCallback(async () => {
    if (!blueprint || !folder || writing) return;
    setWriting(true);
    setWriteError(null);
    try {
      if (!(await verifyPermission(folder, true))) {
        throw new Error('No write permission for the Creator folder.');
      }
      const generatedAt = new Date().toISOString();
      const built = compileCourseBlueprint(blueprint, generatedAt);
      const storage = new FileSystemStorage(folder);
      const manifest = browser.runtime.getManifest();
      const files = await writeBuiltCourse(
        storage,
        built,
        generatedAt,
        manifest.version_name ?? manifest.version,
        blueprint.source.originalFileName ??
          (pending !== 'loading' && pending !== 'missing' ? pending.fileName : null) ??
          'pasted blueprint',
      );
      setFolderBuildWarning(null);
      setWritten({
        ...files,
        courseId: built.courseId,
        title: blueprint.title,
        registryWarnings: built.registryWarnings,
      });
      // The slot is consumed; a re-review starts from the entry page.
      if (slotId) await removePendingBlueprint(slotId);
    } catch (e) {
      setWriteError(errText(e));
    } finally {
      setWriting(false);
    }
  }, [blueprint, folder, writing, pending, slotId]);

  const errors = validation?.issues.filter((i) => i.severity === 'error') ?? [];
  const canApprove =
    !!blueprint &&
    !!folder &&
    !folderNeedsGrant &&
    !writing &&
    (blueprint.unresolved.length === 0 || ackUnresolved);

  if (pending === 'loading') {
    return (
      <div className="app">
        <h1>Review blueprint</h1>
        <p className="hint">Loading the staged blueprint…</p>
      </div>
    );
  }

  if (pending === 'missing') {
    return (
      <div className="app">
        <h1>Review blueprint</h1>
        <section className="card">
          <p className="error">
            This review link has expired — the staged blueprint is gone (slots live for the
            browser session).
          </p>
          <p className="hint">
            Go back to Rise AI Creator, validate the JSON again, and click "Review blueprint".
          </p>
          <button
            onClick={() =>
              void browser.tabs.create({ url: browser.runtime.getURL('/creator.html') })
            }
          >
            Open Rise AI Creator
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="app">
      <h1>Review blueprint</h1>
      {pending.fileName && <p className="hint">Source: {pending.fileName}</p>}

      {/* The staged text is re-validated here; a failure is a dead end, not a
          fix surface — fixes happen on the entry page. */}
      {validation && !blueprint && (
        <section className="card card-danger">
          <h2>✗ The staged JSON does not validate</h2>
          <ul className="issue-list">
            {errors.map((i, n) => (
              <li key={n}>
                <code>{i.path}</code> — {i.message}
              </li>
            ))}
          </ul>
          <p className="hint">
            Fix the JSON on the Rise AI Creator page and open a fresh review.
          </p>
        </section>
      )}

      {blueprint && stats && (
        <>
          <section className="card">
            <h2>Preview</h2>
            <p className="hint">
              <b>{blueprint.title}</b> — {blueprint.lessons.length} lessons · {stats.blocks}{' '}
              blocks · {stats.kcs} knowledge checks · {stats.placeholders} placeholders ·{' '}
              <b className={stats.suggested ? 'suggested-count' : ''}>
                {stats.suggested} AI-suggested block(s)
              </b>{' '}
              ·{' '}
              <b className={blueprint.unresolved.length ? 'error' : ''}>
                {blueprint.unresolved.length} unresolved item(s)
              </b>
            </p>
            {stats.registryWarnings.length > 0 && (
              <details>
                <summary className="hint">
                  {stats.registryWarnings.length} template(s) are compiler-tested but not yet
                  marked live-verified
                </summary>
                <ul className="notes">
                  {stats.registryWarnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          {blueprint.unresolved.length > 0 && (
            <section className="card card-danger">
              <h2>⚠ Unresolved material — will NOT be imported</h2>
              <ul className="issue-list">
                {blueprint.unresolved.map((u, i) => (
                  <li key={i}>
                    <b>
                      {u.sourceRef.slideNo != null ? `Slide ${u.sourceRef.slideNo}` : u.sourceRef.label}
                    </b>{' '}
                    — {u.reason}
                    {u.sourceRef.excerpt && <pre>{u.sourceRef.excerpt}</pre>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <Preview blueprint={blueprint} />

          <section className="card">
            <h2>Approve and save the package</h2>
            {!folder && (
              <>
                <p className="hint">
                  Creator folder not connected — pick a dedicated staging folder for Creator
                  packages (a rise-export archive folder is refused).
                </p>
                <div className="row">
                  <button onClick={connectFolder}>Connect Creator folder…</button>
                  {panelFolder && (
                    <button onClick={() => void usePanelFolder()}>
                      Use panel folder: {panelFolder.name}
                    </button>
                  )}
                </div>
              </>
            )}
            {folder && folderNeedsGrant && (
              <>
                <p className="hint">Folder "{folder.name}" remembered, but permission needed.</p>
                <button onClick={connectFolder}>Restore access: {folder.name}</button>
              </>
            )}
            {folder && !folderNeedsGrant && (
              <p className="hint">Creator folder: {folder.name}</p>
            )}
            {folderBuildWarning && <p className="error">⚠ {folderBuildWarning}</p>}
            {blueprint.unresolved.length > 0 && (
              <label className="ack">
                <input
                  type="checkbox"
                  checked={ackUnresolved}
                  onChange={(e) => setAckUnresolved(e.target.checked)}
                />{' '}
                Acknowledged: {blueprint.unresolved.length} unresolved item(s) will not be imported
                and must be added manually.
              </label>
            )}
            <button className="approve" onClick={approve} disabled={!canApprove}>
              {writing ? 'Writing…' : 'Approve → save package to disk'}
            </button>
            {writeError && <p className="error">⚠ {writeError}</p>}
            {written && (
              <div className="done">
                <p>
                  ✔ Written: <b>{written.title}</b> ({written.courseId})
                </p>
                <ul>
                  <li>{written.courseFile}</li>
                  <li>{written.manifestFile}</li>
                  <li>{written.planFile} — the pasted blueprint, verbatim</li>
                  {written.productionFile && (
                    <li>{written.productionFile} — narration scripts for production</li>
                  )}
                </ul>
                {written.priorBuildWarning && (
                  <p className="error">⚠ {written.priorBuildWarning}</p>
                )}
                {written.registryWarnings.length > 0 && (
                  <p className="hint">
                    Registry status: {written.registryWarnings.length} used template(s) are
                    compiler-tested but not yet marked live-verified. Details are in the blueprint
                    artifact.
                  </p>
                )}
                <p className="hint">
                  Next: side panel → <b>Import Data</b> — point the archive folder at this
                  Creator folder; the course appears in C · Courses. Placeholders (video,
                  Storyline/Mighty, attachments) must be filled in manually after import.
                </p>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
