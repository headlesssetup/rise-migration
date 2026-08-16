import type { AssetsSummary } from '../orchestrator';

function ownerTable(rows: AssetsSummary['orphaned']): React.ReactElement {
  return (
    <table>
      <thead>
        <tr>
          <th>course / bank</th>
          <th>keys</th>
          <th>first location</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((o) => (
          <tr key={`${o.ownerType}:${o.ownerId}`}>
            <td>{o.title ?? o.ownerId}</td>
            <td>{o.keys.length}</td>
            <td>{o.keys[0]?.location ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AssetsView({ summary }: { summary: AssetsSummary }) {
  const orphanCount = summary.orphaned.reduce((n, o) => n + o.keys.length, 0);
  const optionalCount = (summary.optionalUnavailable ?? []).reduce(
    (n, o) => n + o.keys.length,
    0,
  );
  const failCount = summary.undownloaded.reduce((n, o) => n + o.keys.length, 0);
  return (
    <div className="census">
      <p>
        {summary.owners} owner(s){summary.skipped ? ` · ${summary.skipped} skipped` : ''} ·{' '}
        {summary.written} written · {summary.deduped} deduped · {summary.reused}{' '}
        reused · {summary.failed} failed
      </p>
      {summary.complete ? (
        <p className="hint">
          {orphanCount > 0
            ? `Export pass complete, but ${orphanCount} active asset(s) are unavailable at source — see below.`
            : 'All active rendering media resolved — archive is self-sufficient.'}
        </p>
      ) : (
        <p style={{ color: '#b00', fontWeight: 600 }}>
          ⚠ {failCount} key(s) across {summary.undownloaded.length} owner(s) failed
          (non-403/404) and may be retryable — click Download assets again.
        </p>
      )}
      {Object.keys(summary.statusHistogram).length > 0 && (
        <p className="hint">
          statuses:{' '}
          {Object.entries(summary.statusHistogram)
            .map(([code, n]) => `${code}:${n}`)
            .join(' · ')}
        </p>
      )}
      {summary.undownloaded.length > 0 && (
        <>
          <h3>failed (retryable)</h3>
          {ownerTable(summary.undownloaded)}
        </>
      )}
      {summary.orphaned.length > 0 && (
        <>
          <h3>active media unavailable at source (403/404)</h3>
          <p className="hint">
            Referenced by the course but gone from the CDN — flag for manual
            handling at import. Full list + per-key locations in assets-summary.json.
          </p>
          {ownerTable(summary.orphaned)}
        </>
      )}
      {optionalCount > 0 && (
        <>
          <h3>optional source/provenance media unavailable</h3>
          <p className="hint">
            These are superseded inputs, temporary media, original crop sources,
            or inactive image variants. Rise does not use them to render the
            current course; import removes their stale source keys.
          </p>
          {ownerTable(summary.optionalUnavailable)}
        </>
      )}
    </div>
  );
}
