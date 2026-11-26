import { AppState } from 'react-native';
import { background } from '../modules/cleft-background/src';

/**
 * Ways into the app from outside it, for both apps:
 *  - Share from another app (text or a link): the words land in a chat's message box.
 *  - App-icon shortcuts (hold the icon) and links: `<scheme>://ask?text=…[&bot=<id>]`, `<scheme>://hub?tab=today|reminders|ideas`,
 *    `<scheme>://tasks`, `<scheme>://call`, `<scheme>://assist`.
 *  - The phone's assistant gesture, when the app is the default digital assistant (Settings › Assistant):
 *    opens the assistant bot's chat (src/assist.ts) and, if that setting is on, starts dictation.
 * Nothing here sends a message: the person always presses Send themselves.
 */
export type Quick =
  | { kind: 'ask'; text: string; botId?: string }
  | { kind: 'hub'; tab: 'today' | 'reminders' | 'ideas' }
  | { kind: 'tasks' }
  | { kind: 'call' }
  | { kind: 'assist' };

const MAX_TEXT = 8000;

export function parseQuickLink(url: string | null | undefined): Quick | null {
  const m = url ? /^[a-z]+:\/\/(ask|hub|tasks|call|assist)(?:\?(.*))?$/i.exec(url) : null;
  if (!m) return null;
  // Read by hand: React Native's URLSearchParams lacks get() on some versions.
  const q: Record<string, string> = {};
  for (const part of (m[2] ?? '').split('&')) {
    if (!part) continue;
    const [k, v = ''] = part.split('=');
    try { q[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { /* skip a broken part */ }
  }
  switch (m[1].toLowerCase()) {
    case 'ask': return { kind: 'ask', text: String(q.text ?? '').slice(0, MAX_TEXT), ...(q.bot ? { botId: q.bot } : {}) };
    case 'hub': return { kind: 'hub', tab: q.tab === 'reminders' || q.tab === 'ideas' ? q.tab : 'today' };
    case 'tasks': return { kind: 'tasks' };
    case 'call': return { kind: 'call' };
    case 'assist': return { kind: 'assist' };
    default: return null;
  }
}

/** Words shared from another app since the last ask, or null. Android only; null in an app built before sharing. */
export function takeShared(): string | null {
  const t = background.takeShared();
  return t && t.trim() ? t.trim().slice(0, MAX_TEXT) : null;
}

/** Calls `onShare` with shared words, and `onAssist` after the assistant gesture, when the app opens and each time it comes back to the front. */
export function watchShares(onShare: (text: string) => void, onAssist?: () => void): () => void {
  const look = () => {
    if (onAssist && background.takeAssist()) onAssist();
    const t = takeShared(); if (t) onShare(t);
  };
  look();
  const sub = AppState.addEventListener('change', (s) => { if (s === 'active') setTimeout(look, 50); });
  return () => sub.remove();
}
