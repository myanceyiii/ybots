import type { Bot, Client } from './api';

/**
 * "New conversation" starts at once, without a confirm step; App.tsx shows an Undo bar for a few seconds
 * (the same pattern as the plugin switches and the web). Any screen can start one through here.
 */
export interface FreshUndo { botId: string; name: string; until: number }
const listeners = new Set<(u: FreshUndo) => void>();
export const onFresh = (fn: (u: FreshUndo) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export async function startFresh(api: Client, bot: Bot) {
  await api.fresh(bot.id);
  const u: FreshUndo = { botId: bot.id, name: bot.kind === 'room' ? `the ${bot.name} chat` : `${bot.name}'s chat`, until: Date.now() + 10_000 };
  for (const fn of listeners) { try { fn(u); } catch { /* ignore */ } }
}
