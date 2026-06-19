import type { AssetsSummary } from '../orchestrator';

export function AssetsView({ summary }: { summary: AssetsSummary }) {
  return (
    <div className="census">
      <p>
        {summary.owners} owner(s){summary.skipped ? ` · ${summary.skipped} skipped` : ''} ·{' '}
        {summary.written} written · {summary.deduped} deduped · {summary.failed}{' '}
        failed
      </p>
      {summary.complete ? (
        <p className="hint">
          All uploaded media downloaded — archive is self-sufficient.
        </p>
      ) : (
        <>
          <p style={{ color: '#b00', fontWeight: 600 }}>
            ⚠ {summary.undownloaded.reduce((n, o) => n + o.keys.length, 0)} key(s)
            across {summary.undownloaded.length} owner(s) did NOT download.
          </p>
          <table>
            <thead>
              <tr>
                <th>owner</th>
                <th>type</th>
                <th>missing keys</th>
              </tr>
            </thead>
            <tbody>
              {summary.undownloaded.map((o) => (
                <tr key={`${o.ownerType}:${o.ownerId}`}>
                  <td>{o.ownerId}</td>
                  <td>{o.ownerType}</td>
                  <td>{o.keys.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
