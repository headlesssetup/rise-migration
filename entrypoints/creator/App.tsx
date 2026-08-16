// Rise Creator tab — the AI-paste flow (docs/creator-ai-design.md):
//   1 · copy the prompt pack into an external AI chat together with the source
//       deck (PPTX/DOCX/PDF) — the provider interprets the source;
//   2 · paste the returned Course Blueprint JSON here → strict closed-schema
//       validation (unknown fields/kinds fail; the error report is written to
//       be pasted back into the chat);
//   3 · review the pseudo-Rise preview — the ONLY gate to import; unresolved
//       material must be explicitly acknowledged;
//   4 · approve → deterministic compiler → ready-to-import package in the
//       archive folder → normal side-panel Import.
// No auth, no network: this page never contacts Rise.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  blueprintErrorReport,
  compileCourseBlueprint,
  creatorPrompt,
  validateBlueprint,
  type BlueprintValidation,
} from '@/core/creator';
import { registryWarnings as templateRegistryWarnings } from '@/core/rise-format';
import { FileSystemStorage } from '@/core/storage/fs';
import {
  loadDirHandle,
  saveDirHandle,
  verifyPermission,
} from '../sidepanel/folder-store';
import { Preview } from './Preview';
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

function useCopy(): [copied: boolean, copy: (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);
  return [copied, copy];
}

function PromptStep() {
  const [deckInstructions, setDeckInstructions] = useState('');
  const [copied, copy] = useCopy();
  const prompt = useMemo(() => creatorPrompt(deckInstructions), [deckInstructions]);
  return (
    <section className="card">
      <h2>1 · Prompt for the AI chat</h2>
      <p className="hint">
        Open your AI chat, attach the source document (PPTX / DOCX / PDF), paste this prompt, and
        send. The AI returns one JSON block — that is the input for step 2.
      </p>
      <label className="field-label" htmlFor="deck-instructions">
        Instructions for this document (optional — appended to the copied prompt)
      </label>
      <textarea
        id="deck-instructions"
        className="deck-instructions"
        rows={2}
        placeholder='e.g. "Slides 4–6 are decorative, skip them. Speaker notes contain block choices."'
        value={deckInstructions}
        onChange={(e) => setDeckInstructions(e.target.value)}
      />
      <div className="row">
        <button className="approve" onClick={() => copy(prompt)}>
          {copied ? 'Copied ✓' : 'Copy prompt'}
        </button>
      </div>
      <details>
        <summary>Show the full prompt</summary>
        <pre>{prompt}</pre>
      </details>
    </section>
  );
}

export function App() {
  const [pasted, setPasted] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [validation, setValidation] = useState<BlueprintValidation | null>(null);
  const [reportCopied, copyReport] = useCopy();

  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [folderNeedsGrant, setFolderNeedsGrant] = useState(false);
  const [folderBuildWarning, setFolderBuildWarning] = useState<string | null>(null);
  const [ackUnresolved, setAckUnresolved] = useState(false);
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
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
      } else {
        setFolder(handle);
        setFolderNeedsGrant(true);
      }
    })();
  }, []);

  const parse = useCallback((text: string) => {
    setWritten(null);
    setWriteError(null);
    setAckUnresolved(false);
    setValidation(validateBlueprint(text));
  }, []);

  const pickJsonFile = useCallback(
    async (file: File) => {
      const text = await file.text();
      setFileName(file.name);
      setPasted(text);
      parse(text);
    },
    [parse],
  );

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
        throw new Error('No write permission for the archive folder.');
      }
      const generatedAt = new Date().toISOString();
      const built = compileCourseBlueprint(blueprint, generatedAt);
      const storage = new FileSystemStorage(folder);
      const files = await writeBuiltCourse(
        storage,
        built,
        generatedAt,
        browser.runtime.getManifest().version,
        blueprint.source.originalFileName ?? fileName ?? 'pasted blueprint',
      );
      setFolderBuildWarning(null);
      setWritten({
        ...files,
        courseId: built.courseId,
        title: blueprint.title,
        registryWarnings: built.registryWarnings,
      });
    } catch (e) {
      setWriteError(errText(e));
    } finally {
      setWriting(false);
    }
  }, [blueprint, folder, writing, fileName]);

  const errors = validation?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = validation?.issues.filter((i) => i.severity === 'warning') ?? [];
  const canApprove =
    !!blueprint &&
    !!folder &&
    !folderNeedsGrant &&
    !writing &&
    (blueprint.unresolved.length === 0 || ackUnresolved);

  return (
    <div className="app">
      <h1>Rise Creator</h1>
      <p className="hint">
        Source document + AI chat → Course Blueprint JSON → preview → ready-to-import package.
        Everything on this page is local; the course is created later via the normal Import flow
        (side panel → Import → C · Courses).
      </p>

      <PromptStep />

      <section className="card">
        <h2>2 · Paste the AI's JSON</h2>
        <textarea
          className="paste-box"
          rows={8}
          placeholder="Paste the blueprint JSON (or the AI's whole message — fences and prose are stripped automatically)…"
          value={pasted}
          onChange={(e) => {
            setPasted(e.target.value);
            setFileName(null);
          }}
        />
        <div className="row">
          <button className="approve" disabled={pasted.trim() === ''} onClick={() => parse(pasted)}>
            Validate
          </button>
          <label className="file-alt">
            or pick a .json file:{' '}
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pickJsonFile(f);
              }}
            />
          </label>
        </div>
        {fileName && <p className="hint">Loaded: {fileName}</p>}

        {validation && errors.length > 0 && (
          <div className="issues">
            <p className="error">
              ✗ {errors.length} validation error(s) — nothing is imported until the JSON is valid.
            </p>
            <ul className="issue-list">
              {errors.map((i, n) => (
                <li key={n}>
                  <code>{i.path}</code> — {i.message}
                </li>
              ))}
            </ul>
            <button onClick={() => copyReport(blueprintErrorReport(validation.issues))}>
              {reportCopied ? 'Copied ✓' : 'Copy error report for the AI chat'}
            </button>
          </div>
        )}
        {validation && warnings.length > 0 && (
          <ul className="notes">
            {warnings.map((i, n) => (
              <li key={n}>
                <code>{i.path}</code> — {i.message}
              </li>
            ))}
          </ul>
        )}
        {blueprint && <p className="ok">✓ Valid blueprint.</p>}
      </section>

      {blueprint && stats && (
        <>
          <section className="card">
            <h2>3 · Preview</h2>
            <p className="hint">
              {blueprint.lessons.length} lessons · {stats.blocks} blocks · {stats.kcs} knowledge
              checks · {stats.placeholders} placeholders ·{' '}
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
            <h2>4 · Approve and write to archive</h2>
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
              {writing ? 'Writing…' : 'Approve → write to archive'}
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
                  <li>{written.productionFile} — narration scripts for production</li>
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
                  Next: open the side panel → Import (write) → C · Courses — the new course is in
                  the list. Placeholders (video, Storyline/Mighty, attachments) must be filled in
                  manually after import.
                </p>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
