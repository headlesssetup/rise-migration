interface Props {
  folderName: string | null;
  pendingName: string | null;
  connected: boolean;
  busy: boolean;
  onPick: () => void;
  onReconnect: () => void;
  onForget: () => void;
}

/**
 * One folder-control surface shared by Home and the task setup views. Keeping
 * all three exits together prevents a remembered handle from trapping the
 * operator on a reconnect-only screen.
 */
export function FolderControls({
  folderName,
  pendingName,
  connected,
  busy,
  onPick,
  onReconnect,
  onForget,
}: Props) {
  return (
    <>
      <div className="row" style={{ marginTop: 6 }}>
        {pendingName && !connected && (
          <button onClick={onReconnect} disabled={busy}>
            Reconnect: {pendingName}
          </button>
        )}
        <button onClick={onPick} disabled={busy}>
          {folderName ? 'Choose different folder…' : 'Pick archive folder…'}
        </button>
        {folderName && (
          <button onClick={onForget} disabled={busy}>
            Forget folder
          </button>
        )}
      </div>
      {pendingName && !connected && (
        <p className="hint">The remembered folder needs access again, or choose a different one.</p>
      )}
    </>
  );
}
