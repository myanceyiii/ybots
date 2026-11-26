import type { Bot } from '@shared/types';
import { listenIn } from './compose';
import { useStore } from '../store';

/**
 * "Talk to a Bot": the closest the web and Windows apps get to the phone's assistant gesture (on Android the
 * app can be the default digital assistant). Opens the talk Bot's chat and starts dictation; nothing is sent
 * until you press Send. The Bot is Leonard if there is one, else the main Bot (the phone lets you pick).
 * Ways in: the Windows app's Talk shortcut and tray item (0.13.0+ open a small popup with the quick-ask card;
 * 0.12.x asked the main window to do this), and a `/?talk` link (or `/?talk=<bot id>`), for a bookmark or a
 * home-screen shortcut, which shows the quick-ask card on its own.
 */
export function talkBot(bots: Bot[], wanted?: string | null): Bot | undefined {
  const agents = bots.filter((b) => (b.kind ?? 'agent') !== 'room' && !b.outside);
  return (wanted ? agents.find((b) => b.id === wanted) : undefined)
    ?? agents.find((b) => /^leonard$/i.test(b.name.trim()))
    ?? agents.find((b) => b.isPrimary) ?? agents[0];
}

export function startTalk(wanted?: string | null): boolean {
  const bot = talkBot(useStore.getState().bots, wanted);
  if (!bot) return false;
  useStore.getState().openChat(bot.id);
  listenIn(bot.id);
  return true;
}

/**
 * A `/?talk` link (`/?talk=<bot id>` picks the Bot; `&popup=1` is the Windows app's Talk popup): the page shows
 * only the quick-ask card (components/QuickAsk.tsx) instead of the whole app. Null: no link.
 */
export interface TalkLink { wanted: string | null; popup: boolean }
let link: TalkLink | null | undefined;
export function talkLink(): TalkLink | null {
  if (link !== undefined) return link;
  try {
    const u = new URL(window.location.href);
    link = u.searchParams.has('talk') ? { wanted: u.searchParams.get('talk') || null, popup: u.searchParams.get('popup') === '1' } : null;
  } catch { link = null; }
  return link;
}
/** Going on in the whole app ("Open in app", or closing the card in a browser): the link is tidied away. */
export function leaveTalk() {
  link = null;
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete('talk');
    u.searchParams.delete('popup');
    window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
  } catch { /* leave the address as it is */ }
}
