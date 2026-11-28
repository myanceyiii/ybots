import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { ServerEvent } from '@shared/types';
import { useStore } from './store';
import { lsGet, lsSet } from './lib/storage';

/** UI state for bot settings, app settings, the Tasks view and the theme. Kept apart from store.ts on purpose. */

export type Theme = 'system' | 'light' | 'dark';
export type BotSettingsTab = 'general' | 'members' | 'look' | 'skills' | 'memories' | 'routines' | 'helpers' | 'tools';
export type AppSection = 'general' | 'notifications' | 'computer' | 'pcs' | 'permissions' | 'connections' | 'activity' | 'usage' | 'system' | 'logins' | 'account';
/** The three pages Connections replaced; links that still name them open Connections. */
type OldSection = 'apps' | 'plugins' | 'connectors';

interface ConfigUI {
  botSettings: { botId: string; tab: BotSettingsTab } | null;
  appSettings: AppSection | null;
  view: 'chat' | 'tasks';
  theme: Theme;
  /** Answer views: 'rich' draws charts and blocks, 'simple' shows the same answer as plain text. */
  answerVisuals: 'rich' | 'simple';
  /** Bumped by server events (tasks, memories) so open views refetch. Keys: 'tasks', 'memories:<botId>'. */
  versions: Record<string, number>;
  openBotSettings(botId: string, tab?: BotSettingsTab): void;
  closeBotSettings(): void;
  openAppSettings(section?: AppSection | OldSection): void;
  closeAppSettings(): void;
  setView(v: 'chat' | 'tasks'): void;
  setTheme(t: Theme): void;
  setAnswerVisuals(v: 'rich' | 'simple'): void;
  bump(key: string): void;
}

const LS_THEME = 'theme';
const readTheme = (): Theme => {
  const t = lsGet(LS_THEME);
  return t === 'light' || t === 'dark' ? t : 'system';
};

const LS_VISUALS = 'answerVisuals';
const readVisuals = (): 'rich' | 'simple' => (lsGet(LS_VISUALS) === 'simple' ? 'simple' : 'rich');

const darkQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function applyTheme(t: Theme) {
  const resolved = t === 'system' ? (darkQuery?.matches ? 'dark' : 'light') : t;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  try { window.cleftShell?.setTheme?.(t); } catch { /* not the Windows app, or an older one */ }
}

export const useConfigUI = create<ConfigUI>((set, get) => ({
  botSettings: null,
  appSettings: null,
  view: 'chat',
  theme: readTheme(),
  answerVisuals: readVisuals(),
  versions: {},
  openBotSettings: (botId, tab = 'general') => set({ botSettings: { botId, tab } }),
  closeBotSettings: () => set({ botSettings: null }),
  openAppSettings: (section = 'general') => set({ appSettings: section === 'apps' || section === 'plugins' || section === 'connectors' ? 'connections' : section }),
  closeAppSettings: () => set({ appSettings: null }),
  setView: (view) => set({ view }),
  setTheme: (theme) => {
    lsSet(LS_THEME, theme);
    applyTheme(theme);
    set({ theme });
  },
  setAnswerVisuals: (answerVisuals) => { lsSet(LS_VISUALS, answerVisuals); set({ answerVisuals }); },
  bump: (key) => set({ versions: { ...get().versions, [key]: (get().versions[key] ?? 0) + 1 } }),
}));

/** True while the app is drawn dark (Dark, or System on a dark device). For pictures drawn in code, such as charts. */
export function useIsDark(): boolean {
  const theme = useConfigUI((s) => s.theme);
  const [system, setSystem] = useState(!!darkQuery?.matches);
  useEffect(() => {
    const f = () => setSystem(!!darkQuery?.matches);
    darkQuery?.addEventListener?.('change', f);
    return () => darkQuery?.removeEventListener?.('change', f);
  }, []);
  return theme === 'dark' || (theme === 'system' && system);
}

// Apply the saved theme as early as possible, and follow the OS while on "system".
applyTheme(readTheme());
// Opening a chat from a notification, search or the Windows app leaves Tasks for the chat (store.openChat).
if (typeof window !== 'undefined') window.addEventListener('cleftbot:open-chat', () => useConfigUI.getState().setView('chat'));
darkQuery?.addEventListener?.('change', () => { if (useConfigUI.getState().theme === 'system') applyTheme('system'); });

// store.ts forwards events it doesn't handle itself as a DOM event.
window.addEventListener('cleftbot:event', (e) => {
  const ev = (e as CustomEvent<ServerEvent>).detail;
  const { bump } = useConfigUI.getState();
  if (ev.type === 'tasks') { bump('tasks'); bump(`tasks:${ev.botId}`); }
  if (ev.type === 'memories') bump(`memories:${ev.botId}`);
});

// Picking a bot anywhere (sidebar, search) goes back to its chat.
useStore.subscribe((s, prev) => {
  if (s.selectedBotId !== prev.selectedBotId && useConfigUI.getState().view !== 'chat') useConfigUI.getState().setView('chat');
});

export const useVersion = (key: string) => useConfigUI((s) => s.versions[key] ?? 0);
