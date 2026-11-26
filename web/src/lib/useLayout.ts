import { useSyncExternalStore } from 'react';

/**
 * How much room the window has:
 * - `compact`: a phone (portrait, or landscape with little height). One pane at a time.
 * - `medium`: a tablet or small window. Sidebar and chat side by side, details slide over the chat.
 * - `wide`: a laptop or desktop. Sidebar, chat and details side by side.
 */
export type Layout = 'compact' | 'medium' | 'wide';

const COMPACT = '(max-width: 760px), (max-height: 500px) and (max-width: 1000px)';
const MEDIUM = '(max-width: 1180px)';

const mq = (q: string) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null);
const compactQ = mq(COMPACT);
const mediumQ = mq(MEDIUM);

export function currentLayout(): Layout {
  if (compactQ?.matches) return 'compact';
  if (mediumQ?.matches) return 'medium';
  return 'wide';
}

function subscribe(cb: () => void) {
  compactQ?.addEventListener('change', cb);
  mediumQ?.addEventListener('change', cb);
  return () => { compactQ?.removeEventListener('change', cb); mediumQ?.removeEventListener('change', cb); };
}

export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, currentLayout, () => 'wide');
}
