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
  return (
    <>
      <TaskCard
        title="Export from Rise"
        subtitle="Save courses, banks, assets, and account data to a folder"
        onClick={() => onNavigate('archive')}
        disabled={busy}
      />

      <TaskCard
        title="Import into Rise"
        subtitle="Create courses from a validated local package"
        onClick={() => onNavigate('import')}
        disabled={busy || !storage}
      />

      <TaskCard
        title="Save course to document"
        subtitle="Create either prose or storyboard .docx from an exported course"
        onClick={() => onNavigate('export-docx')}
        disabled={busy || !storage}
      />

      <TaskCard
        title="Launch Rise Creator"
        subtitle="Review a source document and build a ready-to-import package"
        onClick={() =>
          void browser.tabs.create({
            url: browser.runtime.getURL('/storyboard.html'),
          })
        }
        external
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
