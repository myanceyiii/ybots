import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { Client, NeedsItem } from './api';

/**
 * The Needs you board on Android (server/src/needs-you.ts; the web's lib/needsYou.ts): everything waiting on
 * the person across every bot, shown at the top of Home. Loaded with the bots and again a moment after
 * something that could change it (a card in any chat, a task, a bot starting or stopping to wait), and once
 * a minute while the app is open, for tasks going stale. It only reads: a row opens the chat at its card.
 */
let items: NeedsItem[] = [];
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const useNeedsYou = (): NeedsItem[] => useSyncExternalStore(subscribe, () => items);
export const clearNeedsYou = () => { items = []; notify(); };
/** The screen preview's demo rows (preview/Preview.tsx). */
export const showNeedsYou = (list: NeedsItem[]) => { items = list; notify(); };

let timer: ReturnType<typeof setTimeout> | null = null;
let ticking: ReturnType<typeof setInterval> | null = null;
let client: Client | null = null;
async function load() {
  const api = client;
  if (!api) return;
  try {
    const r = await api.needsYou();
    if (api !== client) return;
    items = Array.isArray(r.items) ? r.items : [];
    notify();
  } catch { /* keep what is shown; the next change or the minute tick asks again */ }
}

/** Ask again shortly (many changes in a row are one request). */
export function refreshNeedsYou(api: Client, delay = 700) {
  if (client !== api) { client = api; items = []; notify(); }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void load(); }, delay);
  if (!ticking) ticking = setInterval(() => { if (AppState.currentState === 'active') void load(); }, 60_000);
}
