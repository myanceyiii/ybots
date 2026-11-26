/**
 * Asks again every `ms`, but only while the app is open in front: a screen left open in a pocket stops
 * using the battery and the network, and catches up the moment the app comes back.
 */
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

export function usePoll(fn: () => void, ms: number, deps: unknown[] = []) {
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => { if (!timer) timer = setInterval(() => f.current(), ms); };
    const stop = () => { if (timer) { clearInterval(timer); timer = undefined; } };
    f.current();
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') { f.current(); start(); } else stop(); });
    return () => { stop(); sub.remove(); };
  /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ms, ...deps]);
}
