// The Export Data view (steps A through D + result reports) — split out of
// App.tsx (v0.9.0 restructure). Props-only: all run state lives in App via
// useExportRuns, so this component can unmount without touching a live run.
import type { SessionState } from '@/shared/messaging';
import { PAGE, type ExportRuns } from '../use-export-runs';
import { AssetsView } from './AssetsView';
import { BanksView } from './BanksView';
import { CensusView } from './CensusView';
import { NoveltyView } from './NoveltyView';

interface Props {
  session: SessionState | null;
  hasStorage: boolean;
  busy: boolean;
  totalCount: number | null;
  runs: ExportRuns;
}

export function ArchiveView({
  session,
  hasStorage,
  busy,
  totalCount,
  runs,
}: Props) {
  const {
    phase,
    listLimit,
    setListLimit,
    searchTerm,
    setSearchTerm,
    courses,
    selected,
    allSelected,
    toggle,
    toggleAll,
    list,
    runExport,
    runBanks,
    runAssets,
    runStoryline,
    runAccount,
    progress,
    census,
    novelty,
    banks,
    assets,
    storyline,
  } = runs;
  const atAll = totalCount !== null && listLimit >= totalCount;

  return (
    <>
      <section className="card">
        <h2>A · Account Data</h2>
        <button
          onClick={runAccount}
          disabled={busy || !hasStorage || !session?.risePresent}
        >
          {phase === 'exporting' ? 'Working…' : 'Export account data'}
        </button>
        <p className="hint">
          Block templates and custom typefaces (+ font files). Raw → account/,
          reports → _metadata/.
        </p>
      </section>

      <section className="card">
        <h2>B · Question banks</h2>
        <button
          onClick={runBanks}
          disabled={busy || !hasStorage || !session?.risePresent}
        >
          {phase === 'exporting' ? 'Working…' : 'Fetch question banks (paced)'}
        </button>
        <p className="hint">
          Reusable banks referenced by draw-from-bank blocks — saved to
          question-banks/, profiled in question-banks-catalog.csv/json.
        </p>
        {banks && <BanksView banks={banks} />}
      </section>

      <section className="card">
        <h2>C · Courses</h2>
        <input
          type="text"
          placeholder="Search by name…"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          disabled={busy}
          style={{ width: '100%', boxSizing: 'border-box', marginBottom: 6 }}
        />
        <div className="row">
          <label>
            List{' '}
            <input
              type="number"
              min={PAGE}
              step={PAGE}
              value={listLimit}
              disabled={busy}
              onChange={(e) =>
                setListLimit(Math.max(PAGE, Number(e.target.value) || PAGE))
              }
              style={{ width: 72 }}
            />{' '}
            courses
          </label>
          <button
            onClick={() => totalCount !== null && setListLimit(totalCount)}
            disabled={busy || totalCount === null || atAll}
          >
            All{totalCount !== null ? ` (${totalCount})` : ''}
          </button>
        </div>
        <button onClick={list} disabled={busy}>
          {phase === 'listing'
            ? 'Listing…'
            : `List ${atAll ? 'all' : listLimit} course(s) (paced)`}
        </button>

        {courses.length > 0 && (
          <>
            <div className="row">
              <label>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                />{' '}
                Select all ({selected.size}/{courses.length})
              </label>
              <button
                onClick={runExport}
                disabled={
                  busy ||
                  !hasStorage ||
                  selected.size === 0 ||
                  !session?.risePresent
                }
              >
                {phase === 'exporting'
                  ? 'Fetching…'
                  : `Fetch ${selected.size} course(s) →`}
              </button>
            </div>
            <ul className="course-list">
              {courses.map((c) => (
                <li key={c.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={() => toggle(c.id)}
                    />{' '}
                    {c.title ?? c.id}
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card">
        <h2>C2 · Assets</h2>
        <button onClick={runAssets} disabled={busy || !hasStorage}>
          {phase === 'exporting' ? 'Working…' : 'Download assets'}
        </button>
        <p className="hint">
          Downloads uploaded media (image/video/audio) for every saved course +
          bank from the public CDN (parallel — no pacing). Stored content-addressed
          in assets/ with per-owner *.assets.json. Storyline bundles, cdn.articulate.com,
          and YouTube/Vimeo embeds are kept as references. No Rise tab required.
        </p>
        {assets && <AssetsView summary={assets} />}
      </section>

      <section className="card">
        <h2>D · Embeds (Storyline)</h2>
        <button onClick={runStoryline} disabled={busy || !hasStorage || !session?.risePresent}>
          {phase === 'exporting'
            ? 'Working…'
            : selected.size > 0
              ? `Export storyline packages (${selected.size} selected)`
              : 'Export storyline packages (ALL saved)'}
        </button>
        <p className="hint">
          For the courses <b>selected above</b> (or all saved courses if none selected) that
          contain Storyline/Mighty blocks: triggers a Rise web export (paced), downloads the zip,
          and repackages modern bundles into Review-360 upload zips →
          storyline/&lt;courseId&gt;/&lt;leaf&gt;.zip. Legacy bundles are preserved unchanged and
          quarantined under storyline-legacy/&lt;courseId&gt;/&lt;leaf&gt;.zip; they are never uploaded.
          A per-course manifest records both. Select 1–2 courses in C to test without exporting
          everything. Re-runnable (skips only when all required artifacts already exist).
        </p>
        {storyline && (
          <p className="hint">
            {storyline.packaged} packaged · {storyline.skipped} skipped · {storyline.failed} failed
            {' '}of {storyline.courses} storyline course(s) · {storyline.legacySaved} legacy zip(s)
            preserved.
          </p>
        )}
      </section>

      {progress && (
        <section className="card">
          <h2>Progress</h2>
          <p>
            {progress.done} / {progress.total}
          </p>
        </section>
      )}

      {novelty && (
        <section className="card">
          <h2>Novelty</h2>
          <NoveltyView novelty={novelty} />
        </section>
      )}

      {census && (
        <details className="card">
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            Census — {census.courseCount} course(s) · {census.variants.length}{' '}
            variants · {census.refs.length} ref shapes
          </summary>
          <CensusView census={census} />
        </details>
      )}
    </>
  );
}
