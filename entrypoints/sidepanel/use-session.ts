// Session polling + header course count — split out of App.tsx (v0.9.0
// restructure). Called by App so the state survives view navigation.
import { useCallback, useEffect, useState } from 'react';
import type { SessionState } from '@/shared/messaging';
import { countCourses } from './orchestrator';
import { rpc } from './rpc';

// The header course count is fetched once a Rise tab + token exist, but the very
// first attempt can still lose the race (or hit a transient 403). Retry on a
// bounded, human-paced backoff — never a tight loop, and after the last attempt
// the operator's Refresh is the only trigger.
const COUNT_RETRY_MS = [0, 4_000, 15_000, 45_000];

export function useSession() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [countAttempt, setCountAttempt] = useState(0);

  // Poll session state (identity + token + Rise tab presence + account name).
  // Failures used to be silent — a dead service worker left "Connecting…" forever.
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const resp = await rpc({ type: 'GET_SESSION_STATE' });
        if (!alive) return;
        if (resp.type === 'SESSION_STATE') {
          setSession(resp.state);
          setSessionError(null);
        } else if (resp.type === 'ERROR') {
          setSessionError(resp.error);
        } else {
          setSessionError(`Unexpected reply: ${resp.type}`);
        }
      } catch (e) {
        if (alive) setSessionError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // The account on the tab drives the count — refresh it when it changes.
  const accountName = session?.accountName ?? null;
  useEffect(() => {
    setTotalCount(null);
    setCountAttempt(0);
  }, [accountName]);

  /** Ask for the course count again (header affordance + after a failed run). */
  const refreshCount = useCallback(() => {
    setTotalCount(null);
    setCountAttempt(0);
  }, []);

  // Auto-fetch the total course count once a Rise tab AND a token are present.
  // A null answer used to wedge the header at "Courses: —" forever: the effect
  // could fire before the token was captured, and its deps never changed again.
  const risePresent = session?.risePresent ?? false;
  const hasToken = session?.hasToken ?? false;
  useEffect(() => {
    if (!risePresent || !hasToken || totalCount !== null) return;
    const delay = COUNT_RETRY_MS[countAttempt];
    if (delay === undefined) return; // attempts spent — Refresh is the retry
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        const n = await countCourses().catch(() => null);
        if (!alive) return;
        if (n !== null) setTotalCount(n);
        else setCountAttempt((a) => a + 1);
      })();
    }, delay);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [risePresent, hasToken, totalCount, countAttempt]);

  return { session, sessionError, totalCount, refreshCount };
}
