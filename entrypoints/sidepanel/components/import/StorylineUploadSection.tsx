// Step D · Storyline → Review 360 — split out of ImportView.tsx (v0.9.0).

import { useCallback, useState } from 'react';
import type { Storage } from '@/core/storage/storage';
import { renameReviewItemsToBlockTitles, uploadStorylineToReview360, type ProgressEvent } from '../../orchestrator';
import { CollapsibleStep, type SectionProps } from './step-shared';

/** Stage C — upload the locally staged Storyline packages to the TARGET account's
 *  Review 360 (records each review/items/{leaf} prefix into the course manifest,
 *  ready for the course-import attach). A write to the target, so it rides the
 *  same target-confirmation gate. */
export function StorylineUploadSection({
  storage,
  liveOk,
  running,
  setRunning,
  onEvent,
  logBreak,
  selected,
}: {
  storage: Storage | null;
  liveOk: boolean;
  running: boolean;
  setRunning: (b: boolean) => void;
  onEvent: (e: ProgressEvent) => void;
  logBreak: (label?: string) => void;
  /** The step-C course selection — scopes this upload the same way. */
  selected: Set<string>;
}) {
  // Force re-upload: creates NEW Review items for packages already uploaded and
  // re-points the manifest's upload record at them. Deliberately only offered
  // with a selection — never a silent mass re-upload of every staged package.
  const [force, setForce] = useState(false);
  const rename = useCallback(async () => {
    if (!storage) return;
    logBreak('Rename uploaded Review 360 items → block titles');
    setRunning(true);
    try {
      const onlyCourseIds = selected.size > 0 ? new Set(selected) : undefined;
      await renameReviewItemsToBlockTitles(storage, onEvent, { onlyCourseIds });
    } catch (e) {
      onEvent({ kind: 'log', message: `FAILED — rename: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setRunning(false);
    }
  }, [storage, onEvent, logBreak, setRunning, selected]);

  const go = useCallback(async () => {
    if (!storage) return;
    logBreak('Upload storyline packages → Review 360');
    setRunning(true);
    try {
      // Scope to the courses picked in C so the operator can test 1-2 of many;
      // with nothing selected this stays the previous "every staged manifest".
      const onlyCourseIds = selected.size > 0 ? new Set(selected) : undefined;
      const s = await uploadStorylineToReview360(storage, onEvent, {
        onlyCourseIds,
        force: force && selected.size > 0,
      });
      onEvent({
        kind: 'log',
        message: `${s.failed || s.aborted ? '⚠' : '✓'} Done: ${s.uploaded} uploaded, ${s.skipped} skipped, ${s.failed} failed${s.notAttempted ? `, ${s.notAttempted} not attempted` : ''}.`,
      });
    } catch (e) {
      onEvent({
        kind: 'log',
        message: `FAILED — storyline upload: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setRunning(false);
    }
  }, [storage, onEvent, logBreak, setRunning, selected, force]);

  return (
    <CollapsibleStep title="D · Storyline → Review 360" defaultOpen={false}>
      <p className="hint">
        Uploads the staged packages (storyline/&lt;courseId&gt;/&lt;leaf&gt;.zip) for the
        courses <b>selected in C</b> — or every staged package if none are selected — to the
        <b> target</b> account's Review 360 over socket.io, then records each
        review/items/&lt;leaf&gt; prefix back into the course manifest — the join key the course
        import uses to attach Storyline blocks. Run on the target tab. Resumable (skips packages
        already uploaded).
      </p>
      {selected.size > 0 && (
        <label className="hint" style={{ display: 'block', marginBottom: 6 }}>
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />{' '}
          Re-upload even if already uploaded (creates NEW Review items for the selected courses; the
          manifest will point at the new items)
        </label>
      )}
      <button onClick={go} disabled={!liveOk || running}>
        {running
          ? 'Uploading…'
          : selected.size > 0
            ? `Upload staged packages (${selected.size} selected)`
            : 'Upload staged packages (ALL staged)'}
      </button>{' '}
      <button onClick={rename} disabled={!liveOk || running} title="Items uploaded before v0.9.14e show the package's internal project title (often “Untitled1”). This renames them to the Rise block's title; already-named items are skipped.">
        {selected.size > 0
          ? `Rename uploaded Review items (${selected.size} selected)`
          : 'Rename uploaded Review items (ALL uploaded)'}
      </button>
    </CollapsibleStep>
  );
}

// --- Shared bits --------------------------------------------------------------

