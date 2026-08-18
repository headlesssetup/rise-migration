// Log store for the side panel — split out of App.tsx (v0.9.0 restructure).
// The hook is called by App so the log survives view navigation; views only
// receive the returned handles.
import { useCallback, useEffect, useRef, useState } from 'react';
import { appendLogLines } from './log-lines';

export function useLog() {
  const [log, setLog] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  // Only auto-scroll the log to the bottom when the user is already there — if
  // they've scrolled up to read, leave their position alone.
  const stickToBottomRef = useRef(true);
  const onLogScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  const copyLog = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(log.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }, [log]);

  const addLog = useCallback((message: string) => {
    setLog((l) => appendLogLines(l, [message]));
  }, []);

  // Visually separate each new user-launched operation in the log: drop a blank
  // line before it (never as the very first line), then an optional bold ▶ header.
  const logBreak = useCallback((label?: string) => {
    setLog((l) =>
      appendLogLines(l, [
        ...(l.length === 0 ? [] : ['']),
        ...(label ? [`▶ ${label}`] : []),
      ]),
    );
  }, []);

  const clearLog = useCallback(() => setLog([]), []);

  useEffect(() => {
    if (stickToBottomRef.current) {
      logRef.current?.scrollTo(0, logRef.current.scrollHeight);
    }
  }, [log]);

  return {
    log,
    copied,
    logRef,
    onLogScroll,
    copyLog,
    addLog,
    logBreak,
    clearLog,
  };
}
