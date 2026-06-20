import type { SessionState } from '@/shared/messaging';

export function SessionView({
  session,
  totalCount,
}: {
  session: SessionState | null;
  totalCount: number | null;
}) {
  if (!session) return <p className="hint">Connecting…</p>;
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
      </li>
    </ul>
  );
}
