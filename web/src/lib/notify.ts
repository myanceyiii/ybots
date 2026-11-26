import type { Notice } from '@shared/types';

// Desktop notifications from the server's notices (server/src/notify.ts): replies, a bot waiting on
// you, finished work. Shown while the page is open but not in front (another tab, a minimised window,
// or the Windows app hidden in the tray). Browsers only show them after the person allows it, which is
// asked from a click (Settings, Notifications). A notification never answers anything: clicking it
// opens the chat, where the card is.

declare global {
  interface Window {
    cleftShell?: {
      show: () => void;
      /** `icon` (Windows app 0.7.7+): the bot's face as a round PNG data URL; older apps ignore it. */
      notify?: (title: string, body: string, opts?: { botId?: string; silent?: boolean; tag?: string; icon?: string }) => void;
      /** Windows app 0.7.4+: the theme picked here, for the app's own setup and offline pages. */
      setTheme?: (theme: 'system' | 'light' | 'dark') => void;
      /** Windows app 0.7.4+: withdraw notifications by tag. */
      clear?: (tags: string[]) => void;
      onOpenChat?: (fn: (botId: string) => void) => void;
      /** Windows app 0.12.1+: the Talk shortcut or tray item was used (lib/talk.ts). */
      onTalk?: (fn: () => void) => void;
      /** Windows app 0.13.0+, only in the Talk popup (the page /?talk&popup=1): its window (components/QuickAsk.tsx). */
      talkPopup?: {
        resize: (height: number) => Promise<boolean>;
        close: () => Promise<boolean>;
        openChat: (botId: string | null) => Promise<boolean>;
        /** A JPEG of the screen the popup is on, taken when the person presses Share screen. */
        captureScreen: () => Promise<{ name: string; type: string; data: string }>;
        /** The file picker is open: losing the focus to it must not put the popup away. */
        busy: (on: boolean) => Promise<boolean>;
        onStart: (fn: () => void) => void;
        onStop: (fn: () => void) => void;
      };
    };
  }
}

export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported' | 'app';

export function notifyPermission(): NotifyPermission {
  if (window.cleftShell?.notify) return 'app';
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/** Ask once whether notifications may be shown (call from a click, so the browser shows the prompt). */
export async function askToNotify(): Promise<NotifyPermission> {
  try {
    if (window.cleftShell?.notify) return 'app';
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  } catch { /* not supported */ }
  return notifyPermission();
}

const inFront = () => document.visibilityState === 'visible' && document.hasFocus();
const open = new Map<string, Notification>();

// ---- the bot's face on the notification ----
// The notice names who it is from (`sender`: the bot that wrote it, or a group's member) and, for a group,
// the group (`room`). Its `face` address changes when the bot gets a new picture, so a cache keyed by the
// address never shows an old face. The picture is fetched here, with the page's own sign-in, and drawn
// round as a PNG data URL: the browser and the Windows app can show that without signing in themselves.
// A bot with no picture, or one that fails to load, gets its initial on its colour.

const faces = new Map<string, Promise<string | null>>();

function initialFace(name: string, color: string): string | null {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    if (!g) return null;
    g.fillStyle = /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#3b6fd8';
    g.beginPath(); g.arc(64, 64, 64, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff';
    g.font = '600 64px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText((name.trim()[0] ?? '?').toUpperCase(), 64, 68);
    return c.toDataURL('image/png');
  } catch { return null; }
}

async function roundFace(url: string): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const res = await fetch(url, { credentials: 'same-origin', signal: ctl.signal });
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    if (!g) return null;
    g.beginPath(); g.arc(64, 64, 64, 0, Math.PI * 2); g.clip();
    // Cover: the middle square of the picture (the server already centred it on the face).
    const side = Math.min(bmp.width, bmp.height);
    g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 128, 128);
    return c.toDataURL('image/png');
  } catch { return null; } finally { clearTimeout(timer); }
}

/** The round face for a notice, or null (then the app's own icon shows). */
export function noticeFace(n: Notice): Promise<string | null> {
  const f = n.sender ?? n.room;
  if (!f) return Promise.resolve(null);
  const key = f.face ?? `initial:${f.name}:${f.color}`;
  let p = faces.get(key);
  if (!p) {
    p = (f.face ? roundFace(f.face) : Promise.resolve(null)).then((img) => {
      // A picture that failed to load is not remembered, so the next notice tries it again.
      if (!img && f.face) faces.delete(key);
      return img ?? initialFace(f.name, f.color);
    });
    faces.set(key, p);
    if (faces.size > 60) faces.delete(faces.keys().next().value as string);
  }
  return p;
}

/** Show a notice unless the page is in front. `onOpen` runs when it is clicked. */
export function showNotice(n: Notice, onOpen: (botId: string) => void) {
  try {
    if (inFront()) return;
    void noticeFace(n).catch(() => null).then((icon) => present(n, icon, onOpen));
  } catch { /* not supported (some mobile browsers) */ }
}

function present(n: Notice, icon: string | null, onOpen: (botId: string) => void) {
  try {
    if (inFront()) return;
    // In the Windows app the shell shows it (a Windows notification, or the tray balloon).
    if (window.cleftShell?.notify) { window.cleftShell.notify(n.title, n.body, { botId: n.botId, silent: !!n.silent, tag: n.tag, ...(icon ? { icon } : {}) }); return; }
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    open.get(n.tag)?.close();
    const note = new Notification(n.title, { body: n.body, tag: n.tag, icon: icon ?? '/icon-192.png', silent: !!n.silent, requireInteraction: n.channel === 'approvals' });
    open.set(n.tag, note);
    note.onclick = () => { window.cleftShell?.show(); window.focus(); onOpen(n.botId); note.close(); };
    note.onclose = () => { if (open.get(n.tag) === note) open.delete(n.tag); };
  } catch { /* not supported (some mobile browsers) */ }
}

/** Take down notices that no longer apply (an approval answered, a chat read elsewhere). */
export function clearNotices(tags: string[]) {
  for (const t of tags) { open.get(t)?.close(); open.delete(t); }
  try { window.cleftShell?.clear?.(tags); } catch { /* older Windows app */ }
}

/** Kept for the Look tab: a one-off note for slow work (the server's notice now covers picture runs). */
export function notifyIfHidden(title: string, body: string, tag?: string) {
  showNotice({ id: 0, channel: 'jobs', tag: tag ?? title, botId: '', title, body, createdAt: Date.now() }, () => {});
}
