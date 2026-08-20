// Rise AI Creator — ENTRY page of the two-page flow (docs/creator-ai-design.md):
//   1 · copy the prompt pack into an external AI chat together with the source
//       deck (PPTX/DOCX/PDF) — the provider interprets the source;
//   2 · paste the returned Course Blueprint JSON here → strict closed-schema
//       validation (unknown fields/kinds fail; the error report is written to
//       be pasted back into the chat);
//   → on a valid blueprint, "Review blueprint" stages the RAW text in a
//     chrome.storage.session slot (shared/creator-handoff.ts) and opens the
//     REVIEW page (/review.html?b=<id>) in a NEW TAB — preview, unresolved
//     acknowledgement, and the write-to-archive step live THERE. This page
//     stays open as the paste/fix surface.
// No auth, no network: this page never contacts Rise.

import { useCallback, useMemo, useState } from 'react';
import {
  blueprintErrorReport,
  creatorPrompt,
  validateBlueprint,
  type BlueprintValidation,
} from '@/core/creator';
import { putPendingBlueprint } from '@/shared/creator-handoff';

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
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [reviewOpened, setReviewOpened] = useState(false);

  const parse = useCallback((text: string) => {
    setHandoffError(null);
    setReviewOpened(false);
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

  const blueprint = validation?.ready ? validation.blueprint : null;

  const stats = useMemo(() => {
    if (!blueprint) return null;
    const blocks = blueprint.lessons.flatMap((l) => l.blocks);
    return {
      blocks: blocks.length,
      unresolved: blueprint.unresolved.length,
    };
  }, [blueprint]);

  // Stage the RAW pasted text (the review page re-validates) and open the
  // review tab. This page keeps the paste, so a fix round stays one tab away.
  const openReview = useCallback(async () => {
    if (!blueprint) return;
    setHandoffError(null);
    try {
      const id = await putPendingBlueprint(pasted, fileName);
      await browser.tabs.create({
        url: browser.runtime.getURL(`/review.html?b=${id}` as '/review.html'),
      });
      setReviewOpened(true);
    } catch (e) {
      setHandoffError(errText(e));
    }
  }, [blueprint, pasted, fileName]);

  const errors = validation?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = validation?.issues.filter((i) => i.severity === 'warning') ?? [];

  return (
    <div className="app">
      <h1>Rise AI Creator</h1>
      <p className="hint">
        Source document + AI chat → Course Blueprint JSON → review → ready-to-import package.
        Everything on this page is local; the review and the write-to-disk step open in a new
        tab, and the course is created later via the normal Import flow (side panel → Import
        Data → C · Courses).
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

        {blueprint && stats && (
          <>
            <p className="ok">
              ✓ Valid blueprint — <b>{blueprint.title}</b>: {blueprint.lessons.length} lesson(s) ·{' '}
              {stats.blocks} block(s) ·{' '}
              <b className={stats.unresolved ? 'error' : ''}>
                {stats.unresolved} unresolved item(s)
              </b>
            </p>
            <button className="approve" onClick={() => void openReview()}>
              Review blueprint →
            </button>
            {reviewOpened && (
              <p className="hint">
                Review opened in a new tab. This page keeps your pasted JSON for fix rounds.
              </p>
            )}
            {handoffError && <p className="error">⚠ {handoffError}</p>}
          </>
        )}
      </section>
    </div>
  );
}
