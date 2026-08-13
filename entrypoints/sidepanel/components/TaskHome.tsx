import type { SessionState } from '@/shared/messaging';
import type { Storage } from '@/core/storage/storage';

export type View = 'home' | 'archive' | 'import' | 'export-docx';

interface TaskCardProps {
  title: string;
  subtitle: string;
  onClick?: () => void;
  disabled?: boolean;
  badge?: string;
  badgeKind?: 'ready' | 'pending' | 'count';
  external?: boolean;
}

function TaskCard({
  title,
  subtitle,
  onClick,
  disabled,
  badge,
  badgeKind,
  external,
}: TaskCardProps) {
  return (
    <button className="task-card" onClick={onClick} disabled={disabled}>
      <div className="task-card-text">
        <span className="task-card-title">
          {title}
          {external ? ' ↗' : ''}
        </span>
        <span className="task-card-sub">{subtitle}</span>
      </div>
      {badge && (
        <span className={`task-badge task-badge-${badgeKind ?? 'ready'}`}>
          {badge}
        </span>
      )}
    </button>
  );
}

interface Props {
  session: SessionState | null;
  storage: Storage | null;
  folderName: string | null;
  busy: boolean;
  onNavigate: (view: View) => void;
}

export function TaskHome({
  session,
  storage,
  folderName,
  busy,
  onNavigate,
}: Props) {
  const hasRise = !!session?.risePresent && !!session?.hasToken;

  return (
    <>
      <h3 className="section-title">Storyboard</h3>

      <TaskCard
        title="Export course to docx"
        subtitle="Rise course → storyboard for review"
        onClick={() => onNavigate('export-docx')}
        disabled={busy || !storage}
      />

      <TaskCard
        title="Create course from docx"
        subtitle="Storyboard or SD document → new Rise course"
        onClick={() =>
          void browser.tabs.create({
            url: browser.runtime.getURL('/storyboard.html'),
          })
        }
        external
      />

      <TaskCard
        title="Update course from docx"
        subtitle="Diff, review, and apply text changes"
        disabled
        badge="Stage 3"
        badgeKind="pending"
      />

      <h3 className="section-title">Migration</h3>

      <TaskCard
        title="Archive account"
        subtitle="Export courses, banks, assets to disk"
        onClick={() => onNavigate('archive')}
        disabled={busy}
      />

      <TaskCard
        title="Import to account"
        subtitle="Rebuild archived courses in target"
        onClick={() => onNavigate('import')}
        disabled={busy || !hasRise || !storage}
      />

      <div className="context-bar">
        <div className="context-row">
          <span className="context-label">Archive</span>
          <span className="context-value">
            {folderName ?? 'not connected'}
          </span>
        </div>
        <div className="context-row">
          <span className="context-label">Rise tab</span>
          <span className="context-value">
            {session?.risePresent
              ? session.accountName ??
                session.identity?.email ??
                'connected'
              : 'no Rise tab detected'}
          </span>
        </div>
      </div>
    </>
  );
}
