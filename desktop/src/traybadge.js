'use strict';
// The tray icon and the taskbar button: both show when a bot needs you. The tray icon gets a dot (red
// when a bot is waiting on an answer, blue for something unread), its tooltip says how many, and its
// menu lists those bots so one click opens the chat. The taskbar button gets a count and flashes once.
//
// The count comes from the web app's own window title ("(3) YBots"); the names come from the same
// GET /api/bots the app uses. Read only: nothing here can answer an approval.

const { Menu, Tray, nativeImage } = require('electron');
const path = require('node:path');
const { countFromTitle, summarize, botLine, tooltip, EMPTY } = require('./attention');
const { badgeBitmap, withDot } = require('./badge');
const { notificationsPaused, tomorrowMorning } = require('./prefs');

function createTrayBadge({ assets, getWin, getSettings, update, api, showWindow, openChat, log, extraItems }) {
  let tray = null;
  let count = 0;
  let att = EMPTY;
  let timer = null;
  let fetching = false;
  let again = false;
  const icons = {};

  function icon(kind) {
    if (icons[kind]) return icons[kind];
    const base = nativeImage.createFromPath(path.join(assets, 'tray-32.png'));
    if (kind === 'plain' || base.isEmpty()) return (icons[kind] = base.resize({ width: 16, height: 16 }));
    try {
      const dotted = withDot(base.toBitmap(), base.getSize().width, kind);
      icons[kind] = nativeImage.createFromBitmap(dotted.data, { width: dotted.width, height: dotted.height, scaleFactor: dotted.width / 16 });
    } catch (e) {
      log.warn('tray dot could not be drawn', e);
      icons[kind] = base.resize({ width: 16, height: 16 });
    }
    return icons[kind];
  }

  function paint() {
    const s = getSettings();
    const n = Math.max(count, 0);
    const kind = !n ? 'plain' : att.waiting ? 'waiting' : 'unread';
    if (tray && !tray.isDestroyed()) {
      tray.setImage(icon(kind));
      const paused = notificationsPaused(s);
      tray.setToolTip(`${tooltip(att, n)}${paused ? ' (notifications paused)' : ''}`.slice(0, 127));
      // Windows builds the menu when it is opened (right-click below); elsewhere the tray needs one set.
      if (process.platform !== 'win32') tray.setContextMenu(menu());
    }
    const win = getWin();
    if (win && !win.isDestroyed() && process.platform === 'win32') {
      const b = s.notifications.badge ? badgeBitmap(n) : null;
      try {
        win.setOverlayIcon(b ? nativeImage.createFromBitmap(b.data, { width: b.width, height: b.height, scaleFactor: 2 }) : null, b ? (n === 1 ? '1 chat needs you' : `${n} chats need you`) : '');
      } catch (e) { log.warn('taskbar badge failed', e); }
    }
  }

  async function refresh() {
    if (fetching) { again = true; return; }
    fetching = true;
    try {
      att = summarize(await api('/api/bots'));
      // The list is the truth when it is newer than the title (a chat read on another device).
      if (!att.total && count) count = 0;
      else if (att.total > count) count = att.total;
    } catch { /* offline or signed out: keep the count from the title */ }
    fetching = false;
    paint();
    if (again) { again = false; refresh(); }
  }

  function schedule(ms = 700) {
    clearTimeout(timer);
    timer = setTimeout(refresh, ms);
  }

  /** The window's title changed: "(3) YBots" means three chats need you. */
  function onTitle(title) {
    const n = countFromTitle(title);
    if (n === count) return;
    const more = n > count;
    count = n;
    if (!n) att = EMPTY;
    paint();
    if (n) schedule();
    const win = getWin();
    if (more && win && !win.isDestroyed() && !win.isFocused() && getSettings().notifications.flash && !notificationsPaused(getSettings())) {
      win.flashFrame(true);
      // Windows keeps flashing until the window is focused; a few seconds is enough to be seen.
      setTimeout(() => { if (!win.isDestroyed()) win.flashFrame(false); }, 6000);
    }
  }

  /** The page went away (offline, signed out, another address): nothing is known to need you. */
  function reset() { count = 0; att = EMPTY; clearTimeout(timer); paint(); }

  function pauseItems() {
    const s = getSettings();
    const paused = s.notifications.pausedUntil > Date.now();
    const until = paused ? new Date(s.notifications.pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    const pause = (ms) => () => { update({ notifications: { pausedUntil: ms } }); paint(); };
    return {
      label: paused ? `Notifications paused until ${until}` : 'Pause notifications',
      submenu: [
        ...(paused ? [{ label: 'Turn notifications back on', click: pause(0) }, { type: 'separator' }] : []),
        { label: 'For 30 minutes', click: () => pause(Date.now() + 30 * 60_000)() },
        { label: 'For 1 hour', click: () => pause(Date.now() + 60 * 60_000)() },
        { label: 'For 2 hours', click: () => pause(Date.now() + 120 * 60_000)() },
        { label: 'Until tomorrow morning', click: () => pause(tomorrowMorning())() },
      ],
    };
  }

  function menu() {
    const needs = att.bots.map((b) => ({ label: botLine(b), click: () => openChat(b.id) }));
    const more = Math.max(count, att.total) - att.bots.length;
    return Menu.buildFromTemplate([
      { label: 'Open YBots', click: showWindow },
      ...(needs.length ? [{ type: 'separator' }, ...needs, ...(more > 0 ? [{ label: `and ${more} more`, enabled: false }] : [])] : count ? [{ type: 'separator' }, { label: count === 1 ? '1 chat needs you' : `${count} chats need you`, click: showWindow }] : []),
      { type: 'separator' },
      ...extraItems({ pauseItems }),
    ]);
  }

  function create() {
    tray = new Tray(icon('plain'));
    tray.setToolTip('YBots');
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    // Built when it is opened, so it always lists who needs you right now.
    tray.on('right-click', () => { tray.popUpContextMenu(menu()); if (count) schedule(50); });
    paint();
    // While something is waiting and the window is not in front, keep the names fresh.
    setInterval(() => { const w = getWin(); if (count && w && !w.isDestroyed() && !w.isFocused()) refresh(); }, 60_000).unref?.();
    return tray;
  }

  return {
    create,
    onTitle,
    reset,
    paint,
    refresh,
    menu,
    get tray() { return tray; },
    get state() { return { count, attention: att }; },
  };
}

module.exports = { createTrayBadge };
