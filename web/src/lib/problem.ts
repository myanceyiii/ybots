// The problem line above the message box: says what failed (dictation, sending, stopping...), offers
// Try again where that makes sense, and goes away by itself once the server answers again after a
// connection problem.
//
// No browser- or phone-only code: web/src/lib/problem.ts and mobile/src/problem.ts are the same file;
// keep them so.
import { useCallback, useEffect, useRef, useState } from 'react';

export type ProblemArea = 'Dictation' | 'Message' | 'Stop' | 'Voice call' | 'Slack link' | 'New conversation' | 'Reaction' | 'Attachment' | 'Conversation';

export interface Problem {
  area: ProblemArea;
  text: string;
  /** Try again: the same action once more. */
  retry?: () => void;
  /** A connection problem: watched, and cleared once the server answers again. */
  network?: boolean;
}

const PROBE_MS = 4000;

/** True for a failure to reach the server at all (no answer, not an error answer). */
export function isNetworkFailure(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (status === 0) return true;
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return /reach the server|failed to fetch|network request failed|networkerror|load failed/i.test(msg);
}

/** What `e` says, as a short sentence. */
export function problemText(e: unknown, fallback: string): string {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return msg.trim() || fallback;
}

/**
 * `probe` is a cheap call to the server. While a connection problem shows, it is tried every few seconds;
 * once it answers after having failed, the problem is cleared. If it answers at once, the server was
 * reachable all along, so the line stays (the cause was something else) until dismissed or retried.
 */
export function useProblem(probe: () => Promise<unknown>) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [offline, setOffline] = useState(false);
  const probeRef = useRef(probe);
  probeRef.current = probe;

  useEffect(() => {
    setOffline(false);
    if (!problem?.network) return;
    let stopped = false;
    let failed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        await probeRef.current();
        if (stopped) return;
        if (failed) setProblem((cur) => (cur === problem ? null : cur));
        return;
      } catch (e) {
        if (stopped) return;
        // Only a failure to reach the server counts; an error answer means it is up.
        if (!isNetworkFailure(e)) { if (failed) setProblem((cur) => (cur === problem ? null : cur)); return; }
        failed = true;
        setOffline(true);
      }
      timer = setTimeout(() => { void tick(); }, PROBE_MS);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [problem]);

  const show = useCallback((p: Problem | null) => setProblem(p), []);
  /** Shows what went wrong with `area`, from an error, a connection failure is watched. */
  const fail = useCallback((area: ProblemArea, e: unknown, fallback: string, retry?: () => void) => {
    setProblem({ area, text: problemText(e, fallback), retry, network: isNetworkFailure(e) });
  }, []);
  const clear = useCallback(() => setProblem(null), []);
  const retry = useCallback(() => {
    const r = problem?.retry;
    setProblem(null);
    r?.();
  }, [problem]);

  return { problem, offline, show, fail, clear, retry };
}
