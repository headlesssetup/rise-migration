import type { SessionState } from '@/shared/messaging';
import type { Storage } from '@/core/storage/storage';

export type View = 'home' | 'docx' | 'export' | 'import';

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

/** Gates a card can be disabled on. `busy` is any live paced run. */
interface CardGateCtx {
  busy: boolean;
  storage: Storage | null;
}

/**
 * The home screen is a data-driven card list: adding a fifth tool is one
 * entry here. `kind: 'view'` navigates inside the panel; `kind: 'page'`
 * opens a full extension page in a new tab (rendered with a trailing ↗).
 */
interface HomeCard {
  id: string;
  title: string;
  subtitle: string;
  kind: 'view' | 'page';
  view?: Exclude<View, 'home'>;
  url?: string;
  disabledWhen?: (ctx: CardGateCtx) => boolean;
}

const HOME_CARDS: HomeCard[] = [
  {
    id: 'docx',
    title: 'Rise to Docx',
    subtitle:
      'Save a course as .docx — from the archive, the account, or the open editor tab',
    kind: 'view',
    view: 'docx',
    // Live sources need no folder; the view gates per-source instead.
    disabledWhen: ({ busy }) => busy,
  },
  {
    id: 'creator',
    title: 'Rise AI Creator',
    subtitle:
      'Turn source material into a validated course blueprint via an AI chat, then review and save it',
    kind: 'page',
    url: '/creator.html',
  },
  {
    id: 'export',
    title: 'Export Data',
    subtitle:
      'Save courses, question banks, assets, and account data to the archive folder',
    kind: 'view',
    view: 'export',
    disabledWhen: ({ busy }) => busy,
  },
  {
    id: 'import',
    title: 'Import Data',
    subtitle:
      'Create courses in a Rise account from an export archive or a Creator package',
    kind: 'view',
    view: 'import',
    disabledWhen: ({ busy, storage }) => busy || !storage,
  },
];

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
  const gateCtx: CardGateCtx = { busy, storage };
  return (
    <>
      {HOME_CARDS.map((card) => (
        <TaskCard
          key={card.id}
          title={card.title}
          subtitle={card.subtitle}
          disabled={card.disabledWhen?.(gateCtx) ?? false}
          external={card.kind === 'page'}
          onClick={
            card.kind === 'view'
              ? () => onNavigate(card.view!)
              : () =>
                  void browser.tabs.create({
                    url: browser.runtime.getURL(
                      card.url! as '/creator.html',
                    ),
                  })
          }
        />
      ))}

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
