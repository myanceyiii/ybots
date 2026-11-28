import { create } from 'zustand';
import type { NeedsItem } from '@shared/needs-you-types';
import { api } from './api';

/**
 * The Needs you board (server/src/needs-you.ts): everything waiting on the person across every bot, for the
 * web and Windows apps. Loaded when the app starts and again, a moment after something that could change
 * it (a card in any chat, a task, a bot starting or stopping to wait), and once a minute for tasks going
 * stale. It only reads; every row opens the chat at its card, where the answer goes the usual way.
 */
interface NeedsState {
  items: NeedsItem[];
  loaded: boolean;
  load(): Promise<void>;
}

export const useNeedsYou = create<NeedsState>((set) => ({
  items: [],
  loaded: false,
  async load() {
    try {
      const r = await api.needsYou();
      set({ items: Array.isArray(r.items) ? r.items : [], loaded: true });
    } catch { /* keep what was shown; the next change or the minute timer tries again */ }
  },
}));

let timer: ReturnType<typeof setTimeout> | null = null;
let ticking: ReturnType<typeof setInterval> | null = null;
/** Ask again shortly (many changes in a row are one request). */
export function refreshNeedsYou(delay = 700) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void useNeedsYou.getState().load(); }, delay);
  if (!ticking) ticking = setInterval(() => { if (document.visibilityState === 'visible') void useNeedsYou.getState().load(); }, 60_000);
}
