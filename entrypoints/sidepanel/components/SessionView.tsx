import type { SessionState } from '@/shared/messaging';

export function SessionView({
  session,
  sessionError,
  totalCount,
  onRefreshCount,
  refreshDisabled,
}: {
  session: SessionState | null;
  /** Why the background hasn't answered yet — replaces eternal "Connecting…". */
  sessionError?: string | null;
  totalCount: number | null;
  /** Re-ask for the course count — the auto-fetch gives up after a few tries. */
  onRefreshCount?: () => void;
  refreshDisabled?: boolean;
}) {
  if (!session) {
    if (sessionError) {
      return (
        <p className="hint" style={{ color: '#b00' }}>
          Background not answering: {sessionError}
        </p>
      );
    }
    return <p className="hint">Connecting…</p>;
  }
  const id = session.identity;
  const who = session.accountName ?? id?.email ?? id?.name;
  return (
    <ul className="kv">
      <li>
        Rise tab: <b>{session.risePresent ? 'detected' : 'not detected'}</b>
      </li>
      <li>
        Token: <b>{session.hasToken ? 'captured' : 'none yet'}</b>
      </li>
      <li>
        Logged in as: <b>{who ?? id?.sub ?? '—'}</b>
        {!who && id?.sub && <span className="hint"> (user id)</span>}
      </li>
      <li>
        Courses: <b>{totalCount ?? '—'}</b>
        {onRefreshCount && (
          <>
            {' '}
            <button
              className="copy-btn"
              onClick={onRefreshCount}
              disabled={refreshDisabled}
              title="Re-read the account's course count"
            >
              Refresh
            </button>
          </>
        )}
      </li>
    </ul>
  );
}
