// Step D · Storyline → Review 360 — split out of ImportView.tsx (v0.9.0).

import { useCallback, useState } from 'react';
import type { Storage } from '@/core/storage/storage';
import { uploadStorylineToReview360, type ProgressEvent } from '../../orchestrator';
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
  const go = useCallback(async () => {
    if (!storage) return;
    logBreak('Upload storyline packages → Review 360');
    setRunning(true);
    try {
      // Scope to the courses picked in C so the operator can test 1-2 of many;
      // with nothing selected this stays the previous "every staged manifest".
      const onlyCourseIds = selected.size > 0 ? new Set(selected) : undefined;
      const s = await uploadStorylineToReview360(storage, onEvent, { onlyCourseIds });
      onEvent({
        kind: 'log',
        message: `Done: ${s.uploaded} uploaded, ${s.skipped} skipped, ${s.failed} failed${s.notAttempted ? `, ${s.notAttempted} not attempted` : ''}.`,
      });
    } catch (e) {
      onEvent({
        kind: 'log',
        message: `FAILED — storyline upload: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setRunning(false);
    }
  }, [storage, onEvent, logBreak, setRunning, selected]);

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
      <button onClick={go} disabled={!liveOk || running}>
        {running
          ? 'Uploading…'
          : selected.size > 0
            ? `Upload staged packages (${selected.size} selected)`
            : 'Upload staged packages (ALL staged)'}
      </button>
    </CollapsibleStep>
  );
}

// --- Shared bits --------------------------------------------------------------

