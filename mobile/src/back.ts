/**
 * The Android back button, for things inside a screen that should close before the screen itself does
 * (an open search box, a picker). A screen registers a handler while that thing is open; App.tsx asks
 * here first and only then walks back through its screens. The newest handler wins.
 */
import { useEffect, useRef } from 'react';

const handlers: (() => boolean)[] = [];

/** True when something inside the screen took the back press. */
export function runBack(): boolean {
  for (let i = handlers.length - 1; i >= 0; i--) {
    try { if (handlers[i]()) return true; } catch { /* a broken handler never blocks Back */ }
  }
  return false;
}

/** While `active`, the back button calls `onBack` instead of leaving the screen. */
export function useBack(active: boolean, onBack: () => void) {
  const fn = useRef(onBack);
  fn.current = onBack;
  useEffect(() => {
    if (!active) return;
    const h = () => { fn.current(); return true; };
    handlers.push(h);
    return () => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); };
  }, [active]);
}
