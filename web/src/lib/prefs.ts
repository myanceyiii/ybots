import { create } from 'zustand';
import { lsGet, lsSet } from './storage';

/** Settings that belong to this browser or Windows app (not the account): text size and what Enter does. */

export type TextSize = 'small' | 'default' | 'large' | 'xl';
export const TEXT_SIZES: { id: TextSize; label: string; zoom: number }[] = [
  { id: 'small', label: 'Small', zoom: 0.9 },
  { id: 'default', label: 'Default', zoom: 1 },
  { id: 'large', label: 'Large', zoom: 1.15 },
  { id: 'xl', label: 'Extra large', zoom: 1.3 },
];
export type ListFilter = 'all' | 'unread' | 'needs';

interface Prefs {
  textSize: TextSize;
  /** true: Enter sends and Shift+Enter adds a line. false: Enter adds a line and Ctrl/⌘+Enter sends. */
  enterSends: boolean;
  /** Which chats the list shows. Not saved: the list opens on All. */
  listFilter: ListFilter;
  setTextSize(t: TextSize): void;
  setEnterSends(v: boolean): void;
  setListFilter(f: ListFilter): void;
}

const readSize = (): TextSize => { const v = lsGet('textSize'); return TEXT_SIZES.some((t) => t.id === v) ? (v as TextSize) : 'default'; };

export function applyTextSize(t: TextSize) {
  const zoom = TEXT_SIZES.find((x) => x.id === t)?.zoom ?? 1;
  document.documentElement.style.setProperty('--chat-zoom', String(zoom));
}

export const usePrefs = create<Prefs>((set) => ({
  textSize: readSize(),
  enterSends: lsGet('enterSends') !== '0',
  listFilter: 'all',
  setTextSize: (textSize) => { lsSet('textSize', textSize); applyTextSize(textSize); set({ textSize }); },
  setEnterSends: (enterSends) => { lsSet('enterSends', enterSends ? '1' : '0'); set({ enterSends }); },
  setListFilter: (listFilter) => set({ listFilter }),
}));

if (typeof document !== 'undefined') applyTextSize(readSize());
