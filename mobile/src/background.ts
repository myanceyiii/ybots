import { AppState, PermissionsAndroid, Platform } from 'react-native';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { background } from '../modules/cleft-background/src';
import type { Client } from './api';

export { background };

export const APP_NAME = 'YBots';

/** Ask once for notifications (Android 13+), from a tap that starts slow work. Never asked on launch. */
export async function askForNotifications(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (Number(Platform.Version) < 33) return true;
  try {
    const p = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    if (await PermissionsAndroid.check(p)) return true;
    return (await PermissionsAndroid.request(p)) === PermissionsAndroid.RESULTS.GRANTED;
  } catch { return false; }
}

const active = () => AppState.currentState === 'active';

/**
 * Wait for a picture run, also while the app is in the background: a foreground service follows it
 * ("Drawing pictures for Leonard…") so Android keeps the app running, and says when it is done if the
 * person has left the app. The run is marked shown once the caller has it.
 */
export async function followLookRun(api: Client, bot: { id: string; name: string }, run: string): Promise<{ candidates: string[] }> {
  const { url, headers } = api.lookRunWatch(bot.id, run);
  background.watchJob({
    id: run, url, headers,
    working: `Drawing pictures for ${bot.name}…`,
    doneTitle: `${bot.name}'s pictures are ready`,
    doneBody: `Open ${APP_NAME} to pick one.`,
    failTitle: `${bot.name}'s pictures could not be drawn`,
  });
  try {
    const out = await api.waitLookRun(bot.id, run, active);
    api.lookRunSeen(bot.id, run).catch(() => {});
    return out;
  } catch (e) {
    if (active()) api.lookRunSeen(bot.id, run).catch(() => {});
    throw e;
  } finally {
    // Done while in front: no note needed. Done in the background: the service has already posted it.
    if (active()) background.stopWatch(run);
  }
}

// ---------- notifications (modules/cleft-background NotifyService, server/src/notify.ts) ----------

const OFF_KEY = 'cleftbot.notify.off';
const ASKED_KEY = 'cleftbot.notify.asked';

/** Which notices this app gets (server/src/notify.ts profiles). */
export const NOTIFY_PROFILE = 'main' as const;

/** Whether the person turned the notification link off on this phone (it is on unless they did). */
export async function notifyTurnedOff(): Promise<boolean> {
  try { return (await SecureStore.getItemAsync(OFF_KEY)) === '1'; } catch { return false; }
}

/**
 * Open the notification link for this session. Asked for Android's notification permission once,
 * the first time after this feature arrived (the person asked for notifications); never again after
 * a "no": the switch in Background and notifications asks from then on.
 */
export async function startNotifications(api: Client, opts: { ask?: boolean; account?: string } = {}): Promise<boolean> {
  if (!background.notifyAvailable) return false;
  if (await notifyTurnedOff()) return false;
  let allowed = background.status().notificationsAllowed;
  if (opts.ask && !allowed) {
    let asked = false;
    try { asked = (await SecureStore.getItemAsync(ASKED_KEY)) === '1'; } catch { /* ask */ }
    if (!asked) {
      allowed = await askForNotifications();
      try { await SecureStore.setItemAsync(ASKED_KEY, '1'); } catch { /* asked again next time */ }
    }
  }
  // No link (and no sign-in handed to the service) while Android blocks notifications.
  if (!allowed) return false;
  return background.notifyStart({
    server: api.server, headers: api.authHeader as Record<string, string>, profile: NOTIFY_PROFILE,
    scheme: 'cleftbot', appName: APP_NAME, account: opts.account ?? currentAccount,
  });
}

/** Who is signed in (the session's address), so the service can tell a different account from the same one. */
let currentAccount = '';
export function setNotifyAccount(account: string) { currentAccount = account; }

/** The switch: saved as the person's choice; the link starts only once Android allows notifications. */
export async function setNotificationsOn(api: Client, on: boolean): Promise<{ allowed: boolean; started: boolean }> {
  try { if (on) await SecureStore.deleteItemAsync(OFF_KEY); else await SecureStore.setItemAsync(OFF_KEY, '1'); } catch { /* best effort */ }
  if (!on) { background.notifyStop(); return { allowed: background.status().notificationsAllowed, started: false }; }
  const allowed = await askForNotifications();
  const started = allowed ? await startNotifications(api) : false;
  return { allowed, started };
}

/** Signed out: close the link and forget the sign-in it kept. */
export function stopNotifications() { background.notifyStop(); }

/** A notification tap: `cleftbot://open?bot=<id>&seq=<row>`, with `&chat=<id>` for one of the bot's side chats. */
export function parseOpenLink(url: string | null | undefined): { botId: string; seq?: number; chatId?: string } | null {
  const m = url ? /^[a-z]+:\/\/open\?(.*)$/i.exec(url) : null;
  if (!m) return null;
  // Read by hand: React Native's URLSearchParams lacks get() on some versions.
  const q: Record<string, string> = {};
  for (const part of m[1].split('&')) {
    const [k, v = ''] = part.split('=');
    try { q[decodeURIComponent(k)] = decodeURIComponent(v); } catch { /* skip a broken part */ }
  }
  const botId = q.bot;
  if (!botId) return null;
  const seq = Number(q.seq);
  return { botId, ...(seq > 0 ? { seq } : {}), ...(q.chat ? { chatId: q.chat } : {}) };
}
