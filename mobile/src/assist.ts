// The phone's assistant gesture (Settings › Assistant). Kept on this phone only, like the theme.
//  - Which Bot it opens: the one picked here, else Leonard, else the main Bot.
//  - Whether dictation starts on its own once the chat is open ("Start listening"). Nothing is ever sent by itself.
import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';
import type { Bot } from './api';

const BOT_KEY = 'cleftbot.assistantBot';
const LISTEN_KEY = 'cleftbot.assistantListen';
const read = (k: string) => { try { return SecureStore.getItem(k); } catch { return null; } };

type State = { botId: string | null; listen: boolean };
let state: State = { botId: read(BOT_KEY) || null, listen: read(LISTEN_KEY) !== 'off' };
const listeners = new Set<(s: State) => void>();
const tell = () => { for (const fn of listeners) fn(state); };

export function setAssistantBot(id: string | null) {
  state = { ...state, botId: id };
  (id ? SecureStore.setItemAsync(BOT_KEY, id) : SecureStore.deleteItemAsync(BOT_KEY)).catch(() => {});
  tell();
}
export function setAssistantListen(on: boolean) {
  state = { ...state, listen: on };
  SecureStore.setItemAsync(LISTEN_KEY, on ? 'on' : 'off').catch(() => {});
  tell();
}
export const assistantPrefs = () => state;
export function useAssistantPrefs(): State {
  const [s, setS] = useState(state);
  useEffect(() => { listeners.add(setS); return () => { listeners.delete(setS); }; }, []);
  return s;
}

/** Bots the gesture can open: one-to-one chats only (not groups or Bots that live outside the app). */
export const assistantChoices = (bots: Bot[]) => bots.filter((b) => (b.kind ?? 'agent') !== 'room' && !b.outside);

/** The Bot the assistant gesture opens: the one picked, else Leonard, else the main Bot, else the first. */
export function assistantBot(bots: Bot[]): Bot | undefined {
  const agents = assistantChoices(bots);
  return (state.botId ? agents.find((b) => b.id === state.botId) : undefined)
    ?? agents.find((b) => /^leonard$/i.test(b.name.trim()))
    ?? agents.find((b) => b.isPrimary) ?? agents[0];
}

// "Start listening": App asks, the chat that opens takes it. Kept until that chat is on screen.
let pendingListen: string | null = null;
const listenWaiters = new Set<(botId: string) => void>();
export function requestListen(botId: string) {
  pendingListen = botId;
  for (const fn of listenWaiters) fn(botId);
}
/** True once for the Bot whose chat should start dictating now. */
export function takeListen(botId: string): boolean {
  if (pendingListen !== botId) return false;
  pendingListen = null;
  return true;
}
export function onListen(fn: (botId: string) => void): () => void {
  listenWaiters.add(fn);
  return () => { listenWaiters.delete(fn); };
}
