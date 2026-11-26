import type { Bot } from './api';

/** Resolve a notification against the current account's roster. */
export function notificationChat(list: Bot[], id: string | null): string | null {
  if (!id) return null;
  const bot = list.find((b) => b.id === id);
  return bot?.id === id ? id : null;
}
