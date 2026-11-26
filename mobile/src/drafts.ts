/**
 * Unsent text in each chat's composer, kept per chat (as on the web), so leaving a chat and coming back
 * keeps it, and another bot's chat never shows it. Saved on the phone per account, so closing the app
 * or a restart does not lose it. Cleared from memory when another account signs in.
 */
import { useEffect, useState } from 'react';
import { accountKey, readJson, writeJsonSoon } from './disk';

const drafts = new Map<string, string>();
let account = '';
const listeners = new Set<() => void>();
const tell = () => { for (const fn of listeners) fn(); };
const file = () => `drafts-${accountKey(account)}.json`;

export function setDraftAccount(next: string) {
  if (next === account) return;
  drafts.clear();
  account = next;
  tell();
  if (!next) return;
  void readJson<Record<string, string>>(file(), {}).then((saved) => {
    if (account !== next) return;
    // Anything typed since the app opened wins over what was saved.
    for (const [id, text] of Object.entries(saved ?? {})) if (typeof text === 'string' && text && !drafts.has(id)) drafts.set(id, text);
    tell();
  });
}
export const getDraft = (botId: string) => drafts.get(botId) ?? '';
export function setDraft(botId: string, text: string) {
  if (text) drafts.set(botId, text.slice(0, 200_000)); else drafts.delete(botId);
  if (account) writeJsonSoon(file(), () => Object.fromEntries(drafts));
  tell();
}
/** Every chat's unsent text, for the "Draft:" line in the bot list. */
export function useDrafts(): Map<string, string> {
  const [, bump] = useState(0);
  useEffect(() => { const fn = () => bump((n) => n + 1); listeners.add(fn); return () => { listeners.delete(fn); }; }, []);
  return drafts;
}
