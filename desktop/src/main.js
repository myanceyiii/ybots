'use strict';
// YBots for Windows: one window that opens the YBots web app from the address the person gives
// on first run. What bots do happens in the web app and on the server. This shell keeps the window on
// that address, decides which browser permissions it gets, and adds what only a desktop app can: the
// tray and taskbar badge, notifications, Quick Chat on a global shortcut, a right-click menu, find on
// the page, downloads, and a window that remembers where it was.

const { app, BrowserWindow, Menu, clipboard, dialog, globalShortcut, ipcMain, nativeTheme, powerMonitor, screen, session, shell } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const qrcode = require('qrcode-generator');
const { normalizeAddress, signInUrl, navigationDecision, permissionAllowed, isRedirectError, sameOrigin, offlineHint, retryDelay, parseLaunch } = require('./policy');
const { cleanSettings, cleanPatch, mergeSettings, notificationsPaused } = require('./prefs');
const { readJson, writeJson } = require('./store');
const { fitBounds, MIN } = require('./winstate');
const { shellCommand, zoomStep } = require('./keys');
const log = require('./log');
const { attachContextMenu } = require('./contextmenu');
const { createFindBar } = require('./findbar');
const { createQuickChat } = require('./quickchat');
const { createTalkPopup } = require('./talkpopup');
const { createTrayBadge } = require('./traybadge');
const { createDownloads } = require('./downloads');
const { createRemote } = require('./remote');
const { createUpdater, handoffTarget, giveUp, FROM } = require('./updater');

// Tests point the app at a throwaway folder so they never touch a real install's settings.
if (process.env.CLEFT_USER_DATA) app.setPath('userData', process.env.CLEFT_USER_DATA);
// The app was called "Cleft Bot" until 0.8.0. Keep its settings, sign-in and Cloudflare cookie in the
// same folder (%APPDATA%\Cleft Bot) so the rename doesn't sign anyone out.
else app.setPath('userData', path.join(app.getPath('appData'), 'Cleft Bot'));

// A newer version that was downloaded and checked earlier takes over from here (updater.js). This copy
// only starts it and gets out of the way; nothing else has been set up yet.
const handoff = handoffTarget(app);

const PARTITION = 'persist:cleftbot';
const PAGES = path.join(__dirname, 'pages');
const ASSETS = path.join(__dirname, 'assets');
const PRELOAD = path.join(__dirname, 'preload.js');
const APP_ID = 'com.yancey.cleftbot.desktop';
const pageUrl = (name, query = '') => pathToFileURL(path.join(PAGES, name)).href + query;
const isLocal = (url) => String(url ?? '').startsWith(pathToFileURL(PAGES).href + '/');
const background = () => (nativeTheme.shouldUseDarkColors ? '#121212' : '#FAFAFA');
const ses = () => session.fromPartition(PARTITION);

let win = null;
let aux = null; // the app's own settings window ("Settings", "Let YBots use this PC")
let quitting = false;
let settings = cleanSettings(null);
let settingsWereBad = false;
let remote = null; // "Let YBots use this PC" (remote.js), off until turned on
let trayBadge = null;
let findBar = null;
let quick = null;
let talk = null;
let downloads = null;
let updater = null;
let toastsReady = false;
let quickShortcut = { registered: '', error: '' };
let talkShortcut = { registered: '', error: '' };
let offline = null; // why the offline page is showing, and how many tries in a row have failed
let lastAppUrl = null;
const launch = parseLaunch(process.argv);

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  const { value, bad } = readJson(settingsFile());
  settings = cleanSettings(value);
  settingsWereBad = bad;
}
function saveSettings() {
  try { writeJson(settingsFile(), settings); } catch (e) { log.error('settings could not be saved', e); }
}
function update(patch, { quiet = false } = {}) {
  settings = mergeSettings(settings, patch);
  saveSettings();
  if (!quiet) tellPrefs();
}

loadSettings();
log.init(path.join(app.getPath('userData'), 'logs'));
// Has to be decided before the app is ready. For a PC where the window shows blank or flickers.
if (!settings.hardwareAcceleration) app.disableHardwareAcceleration();

/** True when an IPC message comes from one of our own local pages (their top frame), never from the web app. */
function fromLocalPage(event) {
  const frame = event.senderFrame;
  return !!frame && frame === event.sender.mainFrame && isLocal(frame.url);
}
/** A message from the YBots web app itself (the signed-in address), not from another site. */
function fromAppPage(event) {
  const url = event.senderFrame?.url ?? '';
  return !!settings.address && sameOrigin(url, settings.address);
}
const onApp = () => !!win && !win.isDestroyed() && !!settings.address && sameOrigin(win.webContents.getURL(), settings.address);

/** A request to the YBots server with the main window's own sign-in. Throws a sentence a person can read. */
async function api(pathname, init = {}) {
  const address = settings.address;
  if (!address) throw new Error('Set the YBots address first.');
  let r;
  try {
    r = await ses().fetch(address + pathname, {
      credentials: 'include', redirect: 'manual', ...init,
      headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
  } catch (err) {
    if (isRedirectError(err)) throw new Error('Sign in to YBots in the main window first.');
    throw new Error("Couldn't reach YBots. Check the connection and try again.");
  }
  if (r.status === 401 || r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) throw new Error('Sign in to YBots in the main window first.');
  const json = (r.headers.get('content-type') ?? '').includes('application/json');
  const body = json ? await r.json().catch(() => ({})) : {};
  if (!r.ok) throw new Error(typeof body.error === 'string' && body.error ? body.error.slice(0, 300) : `YBots answered with an error (${r.status}).`);
  if (!json) throw new Error('Sign in to YBots in the main window first.');
  return body;
}

// ---------- notifications ----------
/**
 * Windows shows real notifications (toasts, kept in the Notification Centre) only for an app with a
 * Start Menu shortcut that carries its app id. The portable zip installs nothing, so the app makes that
 * shortcut itself (%APPDATA%\Microsoft\Windows\Start Menu\Programs\YBots.lnk), and fixes it if the
 * folder was moved. Without it, notifications fall back to the tray balloon.
 */
function setUpToasts() {
  if (process.platform !== 'win32') { toastsReady = true; return; }
  try {
    app.setAppUserModelId(APP_ID);
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'YBots.lnk');
    // The shortcut was "Cleft Bot.lnk", then "Yancey Bots.lnk" (0.8.0 and 0.8.1), then "YanceyBot.lnk" (0.8.2 to 0.11): drop old ones so Start shows one app.
    const fs = require('node:fs');
    for (const old of ['Cleft Bot.lnk', 'Yancey Bots.lnk', 'YanceyBot.lnk']) {
      try { fs.rmSync(path.join(path.dirname(lnk), old), { force: true }); } catch { /* not there */ }
    }
    let current = null;
    try { current = shell.readShortcutLink(lnk); } catch { /* no shortcut yet */ }
    if (!current || current.target !== process.execPath || current.appUserModelId !== APP_ID) {
      toastsReady = shell.writeShortcutLink(lnk, current ? 'replace' : 'create', {
        target: process.execPath, cwd: path.dirname(process.execPath), appUserModelId: APP_ID,
        description: 'YBots', icon: process.execPath, iconIndex: 0,
      });
    } else toastsReady = true;
  } catch (e) { toastsReady = false; log.warn('start menu shortcut could not be made', e); }
}

let lastBalloonBot = null;
let lastBalloonTag = null;
const shown = new Map(); // tag -> Notification still on screen or in the Notification Centre

/**
 * Something worth a notification while the window is hidden or not in front: a reply, a bot waiting
 * on an approval, finished work. A Windows toast where the Start Menu shortcut exists, else the tray
 * balloon. Clicking it brings the window forward and opens that chat. A notification never answers
 * anything: approvals are answered on the card.
 */
function notifyFromApp(title, body, opts = {}) {
  title = String(title ?? '').slice(0, 120);
  body = String(body ?? '').slice(0, 300);
  if (!title) return;
  // Paused on this PC (tray menu) or turned off in the app's settings: the badge still counts it.
  if (notificationsPaused(settings)) return;
  const botId = typeof opts.botId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(opts.botId) ? opts.botId : null;
  const tag = typeof opts.tag === 'string' && opts.tag.length <= 200 ? opts.tag : null;
  if (tag) clearNotifications([tag]); // a newer notice for the same thing replaces the old one
  const silent = !!opts.silent || !settings.notifications.sound;
  const { Notification, nativeImage } = require('electron');
  // The bot's face (a round PNG the page drew from its picture): the toast's picture, in place of the app icon.
  let icon = null;
  if (typeof opts.icon === 'string' && opts.icon.startsWith('data:image/png;base64,') && opts.icon.length < 400_000) {
    try { const img = nativeImage.createFromDataURL(opts.icon); if (!img.isEmpty()) icon = img; } catch { /* bad picture: app icon */ }
  }
  if (toastsReady && Notification.isSupported()) {
    const n = new Notification({ title, body, silent, ...(icon ? { icon } : {}) });
    n.on('click', () => openChat(botId));
    if (tag) {
      shown.set(tag, n);
      n.on('close', () => { if (shown.get(tag) === n) shown.delete(tag); });
    }
    n.show();
    return;
  }
  const tray = trayBadge?.tray;
  if (process.platform === 'win32' && tray) {
    lastBalloonBot = botId;
    lastBalloonTag = tag;
    tray.displayBalloon({ title, content: body || ' ', ...(icon ? { icon, iconType: 'custom', largeIcon: true } : { iconType: 'info' }), noSound: silent });
  }
}

/** Withdraw notifications the server says no longer apply (answered, read on another device). */
function clearNotifications(tags) {
  for (const t of tags) {
    const n = shown.get(t);
    if (n) { shown.delete(t); try { n.close(); } catch { /* already gone */ } }
    if (lastBalloonTag && lastBalloonTag === t && trayBadge?.tray) {
      lastBalloonTag = null;
      lastBalloonBot = null;
      try { trayBadge.tray.removeBalloon(); } catch { /* not shown */ }
    }
  }
}

// ---------- the main window ----------
function openApp() {
  if (!win || win.isDestroyed()) return null;
  if (!settings.address) return win.loadURL(pageUrl('setup.html')).catch(() => {});
  const target = lastAppUrl && sameOrigin(lastAppUrl, settings.address) ? lastAppUrl : settings.address + '/';
  return win.loadURL(target).catch(() => {}); // a failed load shows the offline page (did-fail-load)
}

function showSetup(mode = '') {
  showWindow();
  return win.loadURL(pageUrl('setup.html', mode ? `?mode=${mode}` : '')).catch(() => {});
}

function showOffline(info) {
  if (!win || win.isDestroyed()) return;
  offline = { ...info, attempt: offline ? offline.attempt + 1 : 0 };
  log.warn('offline page', info.description ?? '', info.status ?? '', `try ${offline.attempt + 1}`);
  trayBadge?.reset();
  win.loadURL(pageUrl('offline.html')).catch(() => {});
}

let boundsTimer = null;
function saveBoundsNow() {
  clearTimeout(boundsTimer);
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  update({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } }, { quiet: true });
}
function rememberBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(saveBoundsNow, 400);
}

function setZoom(zoom) {
  const z = Math.min(3, Math.max(0.5, Math.round(zoom * 100) / 100));
  update({ zoom: z }, { quiet: true });
  if (onApp()) win.webContents.setZoomFactor(z);
  buildMenu();
}

/** Presses one of the web app's own shortcuts for it (its search, settings, new conversation...). */
function pressInApp(keyCode, modifiers = []) {
  if (!onApp()) return;
  showWindow();
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

function runCommand(cmd) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  switch (cmd) {
    case 'zoom-in': return setZoom(zoomStep(settings.zoom, 1));
    case 'zoom-out': return setZoom(zoomStep(settings.zoom, -1));
    case 'zoom-reset': return setZoom(1);
    case 'find': return findBar.open();
    case 'find-next': return findBar.step(true);
    case 'find-prev': return findBar.step(false);
    case 'reload': return isLocal(wc.getURL()) && offline ? openApp() : wc.reload();
    case 'hard-reload': return isLocal(wc.getURL()) && offline ? openApp() : wc.reloadIgnoringCache();
    case 'close': return win.close();
    case 'back': return wc.navigationHistory.canGoBack() && onApp() ? wc.navigationHistory.goBack() : undefined;
    case 'forward': return wc.navigationHistory.canGoForward() && onApp() ? wc.navigationHistory.goForward() : undefined;
    case 'fullscreen': return win.setFullScreen(!win.isFullScreen());
    case 'devtools': return wc.toggleDevTools();
    case 'print': return wc.print({ printBackground: true }, () => {});
    case 'save-pdf': return savePdf();
    default:
  }
}

/** File > Save page as PDF: the chat, Page or view on screen, as it would print. */
async function savePdf() {
  if (!win || win.isDestroyed()) return;
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `${(win.getTitle().replace(/^\(\d+\+?\)\s*/, '').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'YBots').slice(0, 80)} ${stamp}.pdf`;
    const r = await dialog.showSaveDialog(win, { title: 'Save page as PDF', defaultPath: path.join(downloads?.folder() ?? app.getPath('downloads'), name), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return;
    const data = await win.webContents.printToPDF({ printBackground: true, pageSize: 'Letter' });
    require('node:fs').writeFileSync(r.filePath, data);
    notifyPlain('Saved as PDF', path.basename(r.filePath), () => shell.showItemInFolder(r.filePath));
  } catch (e) {
    log.warn('save as pdf', e);
    dialog.showMessageBox(win, { type: 'warning', title: 'YBots', message: 'The page could not be saved as a PDF.', detail: String(e?.message ?? e).slice(0, 300) }).catch(() => {});
  }
}

let crashes = [];
let hangDialog = false;

function createWindow() {
  const b = fitBounds(settings.window, screen.getAllDisplays().map((d) => d.workArea));
  win = new BrowserWindow({
    ...(Number.isFinite(b.x) ? { x: b.x, y: b.y } : {}),
    width: b.width,
    height: b.height,
    minWidth: MIN.width,
    minHeight: MIN.height,
    title: 'YBots',
    backgroundColor: background(),
    icon: path.join(ASSETS, 'icon.png'),
    show: false,
    alwaysOnTop: settings.alwaysOnTop,
    webPreferences: {
      partition: PARTITION,
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: settings.spellcheck,
      // Hidden in the tray or behind other windows, the page keeps its live connection and its timers at
      // full speed, so replies, notifications and a hands-free call carry on.
      backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  win.once('ready-to-show', () => {
    if (b.maximized) win.maximize();
    if (!launch.hidden) win.show();
  });
  // Closing the window keeps YBots running in the tray (unless that is turned off in Settings);
  // Quit (tray or File menu) ends it.
  win.on('close', (event) => {
    if (quitting || !trayBadge?.tray || !settings.closeToTray) { saveBoundsNow(); return; }
    event.preventDefault();
    win.hide();
    if (!settings.trayHintShown) {
      update({ trayHintShown: true }, { quiet: true });
      notifyStill();
    }
  });
  win.on('closed', () => { win = null; app.quit(); });
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, rememberBounds);
  // Windows is shutting down or signing out: there is no time for the usual quit, so save now.
  win.on('session-end', () => { saveBoundsNow(); ses().cookies.flushStore().catch(() => {}); log.info('windows session ended'); });
  win.on('focus', () => win.flashFrame(false));
  win.on('page-title-updated', (_e, title) => { if (onApp()) trayBadge?.onTitle(title); });
  // The mouse's back and forward buttons.
  win.on('app-command', (_e, cmd) => { if (cmd === 'browser-backward') runCommand('back'); else if (cmd === 'browser-forward') runCommand('forward'); });

  wc.on('before-input-event', (event, input) => {
    const cmd = shellCommand(input);
    if (!cmd) return;
    // DevTools only where it helps: a development run, or any run started with --devtools.
    if (cmd === 'devtools' && app.isPackaged && !process.argv.includes('--devtools')) return;
    event.preventDefault();
    runCommand(cmd);
  });
  wc.on('zoom-changed', (_e, dir) => setZoom(zoomStep(settings.zoom, dir === 'in' ? 1 : -1))); // Ctrl + mouse wheel
  wc.on('found-in-page', (_e, r) => findBar.result(r));

  // A page that cannot load (Tailscale off, server down) gets a clear page instead of a blank window.
  // `failing` is true from a failed load until the next try starts: Chromium also reports its own error
  // page as "finished loading", and that must not count as YBots being back.
  let failing = false;
  wc.on('did-start-navigation', (e, url, _inPage, isMainFrame) => {
    const main = typeof isMainFrame === 'boolean' ? isMainFrame : e.isMainFrame;
    if (main && !isLocal(url ?? e.url)) failing = false;
  });
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted, e.g. a redirect */) return;
    if (url.startsWith('file:')) return;
    failing = true;
    showOffline({ code, description, url });
  });
  // The address answered, but with a proxy's error page (the server behind Cloudflare or Tailscale is down).
  let lastStatus = 0;
  wc.on('did-navigate', (_e, url, status) => {
    if (!settings.address || !sameOrigin(url, settings.address)) return;
    lastStatus = status;
    if (status >= 500) { failing = true; return showOffline({ status, url }); }
    lastAppUrl = url;
  });
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame && settings.address && sameOrigin(url, settings.address)) lastAppUrl = url; });
  wc.on('did-finish-load', () => {
    if (!onApp()) { trayBadge?.reset(); return; }
    if (failing || lastStatus >= 500) return; // an error page: the offline page is on its way
    offline = null;
    wc.setZoomFactor(settings.zoom);
    trayBadge?.onTitle(wc.getTitle());
  });
  // The page's process died (out of memory, a driver fault): load it again, a few times at most.
  wc.on('render-process-gone', (_e, details) => {
    log.error('page process gone', details.reason, details.exitCode);
    if (details.reason === 'clean-exit' || quitting) return;
    const now = Date.now();
    crashes = crashes.filter((t) => now - t < 60_000);
    crashes.push(now);
    if (crashes.length > 3) return showOffline({ description: 'crashed' });
    setTimeout(() => { if (win && !win.isDestroyed()) wc.reload(); }, 500);
  });
  win.on('unresponsive', async () => {
    if (hangDialog || quitting) return;
    hangDialog = true;
    log.warn('window not responding');
    const { response } = await dialog.showMessageBox(win, { type: 'warning', title: 'YBots', message: 'YBots is not responding', detail: 'You can wait for it, or load the page again. Nothing you sent is lost.', buttons: ['Wait', 'Reload'], defaultId: 0, cancelId: 0 });
    hangDialog = false;
    if (response === 1 && win && !win.isDestroyed()) { try { wc.forcefullyCrashRenderer(); } catch { /* already gone */ } wc.reload(); }
  });

  findBar = createFindBar({ getWin: () => win, pageUrl, preload: PRELOAD, background });
  openApp();
}

function notifyStill() {
  const { Notification } = require('electron');
  const text = 'It keeps running by the clock so you get replies and approvals. Right-click its icon there to quit.';
  if (toastsReady && Notification.isSupported()) { const n = new Notification({ title: 'YBots is still running', body: text, silent: true }); n.on('click', showWindow); n.show(); }
  else if (process.platform === 'win32' && trayBadge?.tray) trayBadge.tray.displayBalloon({ title: 'YBots is still running', content: text, iconType: 'info', noSound: true });
}

/** A plain notice from the shell itself (not about a chat): a toast, or the tray balloon without one. */
function notifyPlain(title, body, onClick) {
  const { Notification } = require('electron');
  if (toastsReady && Notification.isSupported()) { const n = new Notification({ title, body, silent: true }); if (onClick) n.on('click', onClick); n.show(); }
  else if (process.platform === 'win32' && trayBadge?.tray) trayBadge.tray.displayBalloon({ title, content: body, iconType: 'info', noSound: true });
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Brings the window forward on a chat (a notification, the tray menu, Quick Chat, a yanceybot:// link). */
function openChat(botId) {
  showWindow();
  if (botId && onApp()) win.webContents.send('cleft:open-chat', botId);
}

/** The app's own small window: its settings, and "Let YBots use this PC". The chat stays open behind it. */
function openAux(page) {
  if (aux && !aux.isDestroyed()) {
    if (!aux.webContents.getURL().endsWith(`/${page}`)) aux.loadURL(pageUrl(page));
    if (aux.isMinimized()) aux.restore();
    aux.show();
    aux.focus();
    return aux;
  }
  aux = new BrowserWindow({
    width: 560, height: 780, minWidth: 420, minHeight: 480, title: 'YBots settings', backgroundColor: background(),
    icon: path.join(ASSETS, 'icon.png'), autoHideMenuBar: true, show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  aux.setMenuBarVisibility(false);
  aux.once('ready-to-show', () => aux.show());
  aux.on('closed', () => { aux = null; });
  aux.loadURL(pageUrl(page));
  return aux;
}
const showRemote = () => openAux('remote.html');
const showSettings = () => openAux('settings.html');

function startsAtLogin() {
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
}
function setStartAtLogin(on) {
  // Started by Windows at sign-in, the app opens straight to the tray.
  app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  update({ startAtLogin: !!on }, { quiet: true });
  tellPrefs();
}
/**
 * Windows remembers "start at sign-in" as the path of one exe. After an update the app runs from another
 * folder, so the choice is kept in the settings too and Windows' entry is pointed at this copy again.
 */
function syncLoginItem() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    if (settings.startAtLogin === null) {
      const from = process.argv.find((a) => a.startsWith(FROM))?.slice(FROM.length);
      const on = startsAtLogin() || (!!from && app.getLoginItemSettings({ path: from, args: ['--hidden'] }).openAtLogin);
      update({ startAtLogin: on }, { quiet: true });
    }
    if (settings.startAtLogin && !startsAtLogin()) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  } catch (e) { log.warn('start at sign-in could not be checked', e); }
}

// ---------- Quick Chat shortcut ----------
function registerQuickShortcut() {
  if (quickShortcut.registered) { try { globalShortcut.unregister(quickShortcut.registered); } catch { /* not registered */ } }
  quickShortcut = { registered: '', error: '' };
  const want = settings.quickChat.enabled ? settings.quickChat.shortcut : '';
  if (!want) return;
  let ok = false;
  try { ok = globalShortcut.register(want, () => quick.toggle()); } catch { ok = false; }
  if (ok) quickShortcut.registered = want;
  else { quickShortcut.error = `Another app already uses ${want}. Pick a different shortcut.`; log.warn('quick chat shortcut not registered', want); }
}

// ---------- Talk shortcut ----------
// Like the phone's assistant gesture: a small card at the bottom of the screen (talkpopup.js), over whatever is
// open, that listens at once and sends what you said when you stop talking (web/src/components/QuickAsk.tsx).
// Pressed again while it is in front, it goes away.
function talkNow() {
  if (talk && settings.address) talk.toggle();
  else { showWindow(); if (onApp()) win.webContents.send('cleft:talk'); }
}
function registerTalkShortcut() {
  if (talkShortcut.registered) { try { globalShortcut.unregister(talkShortcut.registered); } catch { /* not registered */ } }
  talkShortcut = { registered: '', error: '' };
  const want = settings.talk.enabled ? settings.talk.shortcut : '';
  if (!want) return;
  if (want === quickShortcut.registered) { talkShortcut.error = `Quick Chat already uses ${want}. Pick a different shortcut.`; return; }
  let ok = false;
  try { ok = globalShortcut.register(want, talkNow); } catch { ok = false; }
  if (ok) talkShortcut.registered = want;
  else { talkShortcut.error = `Another app already uses ${want}. Pick a different shortcut.`; log.warn('talk shortcut not registered', want); }
}

// ---------- guards ----------
function guardContents(contents) {
  const decide = (url) => navigationDecision(url, settings.address);
  const onNavigate = (event, url) => {
    if (isLocal(url)) return;
    const d = decide(url);
    if (d === 'allow') return;
    event.preventDefault();
    if (d === 'external') shell.openExternal(url);
  };
  contents.on('will-navigate', onNavigate);
  contents.on('will-redirect', (event, url) => {
    if (decide(url) !== 'allow') event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (decide(url) !== 'deny') shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  // No page here may pick a Bluetooth, USB, serial or HID device.
  contents.on('select-bluetooth-device', (event, _devices, callback) => { event.preventDefault(); callback(''); });
  attachContextMenu(contents, { openExternal: (url) => { if (decide(url) !== 'deny') shell.openExternal(url); }, dev: !app.isPackaged });
}

function guardSession() {
  const s = ses();
  s.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permissionAllowed(permission, details.requestingUrl ?? contents.getURL(), settings.address, details));
  });
  s.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    permissionAllowed(permission, details?.requestingUrl ?? requestingOrigin, settings.address, details ?? {}),
  );
  s.setDevicePermissionHandler(() => false);
  s.setDisplayMediaRequestHandler((_req, callback) => callback({}));
  s.setSpellCheckerEnabled(settings.spellcheck);
  downloads = createDownloads({ app, getWin: () => win, getSettings: () => settings, toastsReady: () => toastsReady, log });
  s.on('will-download', downloads.onDownload);
  // Name this PC on requests to YBots itself, so "Signed-in devices" in the app says which computer it is.
  const device = `YBots for Windows, ${os.hostname().replace(/[^\x20-\x7e]/g, '').slice(0, 60)}`;
  s.webRequest.onBeforeSendHeaders({ urls: ['http://*/api/*', 'https://*/api/*'] }, (details, callback) => {
    if (settings.address && sameOrigin(details.url, settings.address)) details.requestHeaders['x-cleft-device'] = device;
    callback({ requestHeaders: details.requestHeaders });
  });
}

// ---------- menus ----------
function diagnostics() {
  const paused = settings.notifications.pausedUntil > Date.now();
  return [
    `YBots for Windows ${app.getVersion()}${app.isPackaged ? '' : ' (development run)'}`,
    `Electron ${process.versions.electron}, Chrome ${process.versions.chrome}, Node ${process.versions.node}`,
    `${os.type()} ${os.release()} ${os.arch()}`,
    `Address: ${settings.address ?? 'not set'}`,
    `Window: ${!win || win.isDestroyed() ? 'none' : onApp() ? 'the app' : path.basename(win.webContents.getURL().split('?')[0])}${offline ? ` (${offline.description ?? offline.status ?? 'offline'})` : ''}`,
    `Notifications: ${!settings.notifications.enabled ? 'off' : paused ? 'paused' : toastsReady ? 'Windows notifications' : 'tray balloon'}`,
    `Quick Chat: ${quickShortcut.registered || (quickShortcut.error ? `not registered (${settings.quickChat.shortcut})` : 'no shortcut')}`,
    `Talk: ${talkShortcut.registered || (talkShortcut.error ? `not registered (${settings.talk.shortcut})` : 'no shortcut')}`,
    `Remote use: ${remote?.statusText() ?? 'not started'}`,
    `Updates: ${settings.updates.auto ? 'automatic' : 'off'}${updater?.state().text ? `; ${updater.state().text}` : ''}`,
    `Start at login: ${startsAtLogin() ? 'on' : 'off'}; close to tray: ${settings.closeToTray ? 'on' : 'off'}; zoom ${Math.round(settings.zoom * 100)}%; graphics acceleration ${settings.hardwareAcceleration ? 'on' : 'off'}`,
    ...(settingsWereBad ? ['The settings file could not be read at start and was set aside.'] : []),
    '',
    'Recent log:',
    ...log.tail(30),
  ].join('\n');
}

async function signOut() {
  if (!settings.address) return;
  const { response } = await dialog.showMessageBox(win, { type: 'question', title: 'YBots', message: 'Sign out of YBots on this PC?', detail: 'Your bots keep working. You will need your phone or a sign-in link to sign in here again.', buttons: ['Cancel', 'Sign out'], defaultId: 0, cancelId: 0 });
  if (response !== 1) return;
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch (e) { log.warn('sign out', e); }
  lastAppUrl = null;
  trayBadge?.reset();
  openApp();
}

function aboutBox() {
  dialog.showMessageBox(win && !win.isDestroyed() && win.isVisible() ? win : undefined, {
    type: 'info', title: 'About YBots', message: `YBots for Windows ${app.getVersion()}`,
    detail: `Connected to ${settings.address ?? 'nothing yet'}\nElectron ${process.versions.electron}, Chrome ${process.versions.chrome}\n\nA window onto your own YBots. MIT License.`,
    buttons: ['OK', 'Copy details'], defaultId: 0, cancelId: 0,
  }).then(({ response }) => { if (response === 1) clipboard.writeText(diagnostics()); });
}

function buildMenu() {
  const app2 = (label, keyCode, modifiers, accelerator) => ({ label, accelerator, registerAccelerator: false, click: () => pressInApp(keyCode, modifiers) });
  const cmd = (label, name, accelerator) => ({ label, accelerator, registerAccelerator: false, click: () => runCommand(name) });
  const devtools = !app.isPackaged || process.argv.includes('--devtools') ? [{ type: 'separator' }, cmd('Developer tools', 'devtools', 'Ctrl+Shift+I')] : [];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '&File',
        submenu: [
          app2('New conversation', 'O', ['control', 'shift'], 'Ctrl+Shift+O'),
          app2('Search…', 'K', ['control'], 'Ctrl+K'),
          { label: 'Quick Chat…', accelerator: settings.quickChat.enabled && quickShortcut.registered ? quickShortcut.registered : undefined, registerAccelerator: false, click: () => quick.show() },
          { label: 'Talk to a Bot', accelerator: settings.talk.enabled && talkShortcut.registered ? talkShortcut.registered : undefined, registerAccelerator: false, click: talkNow },
          { type: 'separator' },
          { label: 'Settings for this PC…', click: showSettings },
          { label: 'Let YBots use this PC…', click: showRemote },
          { type: 'separator' },
          { label: 'Sign in with QR code…', click: () => showSetup('pair') },
          { label: 'Sign in with a link…', click: () => showSetup('link') },
          { label: 'Change YBots address…', click: () => showSetup('address') },
          { label: 'Sign out…', enabled: !!settings.address, click: signOut },
          { type: 'separator' },
          { label: 'Show last download', click: () => downloads.showLast() },
          { type: 'separator' },
          cmd('Print…', 'print', 'Ctrl+P'),
          cmd('Save page as PDF…', 'save-pdf'),
          { type: 'separator' },
          cmd(settings.closeToTray ? 'Close to the tray' : 'Close', 'close', 'Ctrl+W'),
          { label: 'Quit YBots', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
        ],
      },
      {
        label: '&Edit',
        submenu: [
          { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
          { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle', label: 'Paste as plain text' }, { role: 'selectAll' },
          { type: 'separator' },
          cmd('Find on this page…', 'find', 'Ctrl+F'),
          cmd('Find next', 'find-next', 'F3'),
          cmd('Find previous', 'find-prev', 'Shift+F3'),
        ],
      },
      {
        label: '&View',
        submenu: [
          cmd('Reload', 'reload', 'Ctrl+R'),
          cmd('Reload without the saved copy', 'hard-reload', 'Ctrl+Shift+R'),
          { type: 'separator' },
          cmd(`Actual size${settings.zoom === 1 ? '' : ` (now ${Math.round(settings.zoom * 100)}%)`}`, 'zoom-reset', 'Ctrl+0'),
          cmd('Zoom in', 'zoom-in', 'Ctrl+Plus'),
          cmd('Zoom out', 'zoom-out', 'Ctrl+-'),
          { type: 'separator' },
          app2('Show or hide the chat list', 'B', ['control'], 'Ctrl+B'),
          app2('Full-screen chat', 'F', ['control', 'shift'], 'Ctrl+Shift+F'),
          app2('Bot details', ',', ['control', 'shift'], 'Ctrl+Shift+,'),
          cmd('Full screen', 'fullscreen', 'F11'),
          { label: 'Keep on top of other windows', type: 'checkbox', checked: settings.alwaysOnTop, click: (item) => { update({ alwaysOnTop: item.checked }); win?.setAlwaysOnTop(item.checked); } },
          ...devtools,
        ],
      },
      {
        label: '&Go',
        submenu: [
          app2('Previous chat', 'Up', ['alt'], 'Alt+Up'),
          app2('Next chat', 'Down', ['alt'], 'Alt+Down'),
          { type: 'separator' },
          cmd('Back', 'back', 'Alt+Left'),
          cmd('Forward', 'forward', 'Alt+Right'),
          { label: 'Home', click: () => { lastAppUrl = null; openApp(); } },
        ],
      },
      {
        label: '&Help',
        submenu: [
          app2('Keyboard shortcuts', '/', ['control'], 'Ctrl+/'),
          app2('App settings', ',', ['control'], 'Ctrl+,'),
          { type: 'separator' },
          { label: 'Check for updates…', click: () => { showSettings(); updater?.check({ manual: true }); } },
          { label: 'Copy diagnostics', click: () => clipboard.writeText(diagnostics()) },
          { label: 'Open the log folder', click: () => { const d = log.dir(); if (d) shell.openPath(d); } },
          { label: 'Clear saved pages and reload', click: async () => { await ses().clearCache().catch(() => {}); if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache(); } },
          { type: 'separator' },
          { label: `About YBots ${app.getVersion()}`, click: aboutBox },
        ],
      },
    ]),
  );
}

function trayItems({ pauseItems }) {
  const remoteItems = remote
    ? [
        { label: remote.statusText(), enabled: false },
        remote.enabled ? { label: 'Stop remote use now', click: () => remote.stopAll() } : { label: 'Use this PC remotely…', click: showRemote },
        { type: 'separator' },
      ]
    : [];
  const ready = updater?.state();
  return [
    ...(ready?.phase === 'ready' && ready.canApply ? [{ label: `Restart to update to ${ready.version}`, click: () => updater.restart() }, { type: 'separator' }] : []),
    { label: `Quick Chat…${quickShortcut.registered ? `\t${quickShortcut.registered}` : ''}`, click: () => quick.show() },
    { label: `Talk to a Bot${talkShortcut.registered ? `\t${talkShortcut.registered}` : ''}`, click: talkNow },
    { label: 'Send a screenshot to a bot…', click: () => quick.showWithScreenshot() },
    pauseItems(),
    { type: 'separator' },
    ...remoteItems,
    { label: 'Start at login', type: 'checkbox', checked: startsAtLogin(), click: (item) => setStartAtLogin(item.checked) },
    { label: 'Settings…', click: showSettings },
    { type: 'separator' },
    { label: 'Quit YBots', click: () => app.quit() },
  ];
}

// ---------- signing in by QR code ----------
// The server makes a two-minute pairing; this window shows its QR code and short code; a signed-in
// phone allows it; the poll (with the secret only this process holds) then gets a one-time sign-in
// link, which the window opens like a pasted one.
let pairing = null; // { id, secret, timer }

function stopPairing() {
  if (pairing?.timer) clearTimeout(pairing.timer);
  pairing = null;
}

function tellPage(update_) {
  if (win && !win.isDestroyed()) win.webContents.send('cleft:pair-update', update_);
}

async function startPairing() {
  stopPairing();
  if (!settings.address) throw new Error('Set the YBots address first.');
  // The whole pairing (QR, polls, the sign-in link) stays with the address it started on. Saving a
  // new address cancels it, and a late answer for an old attempt is ignored.
  const address = settings.address;
  const attempt = {};
  pairing = attempt;
  let res;
  try {
    res = await ses().fetch(`${address}/api/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ device: os.hostname() }),
      credentials: 'include',
      redirect: 'manual',
    });
  } catch (err) {
    // Cloudflare Access redirects a window that hasn't signed in to it yet: open YBots so its
    // sign-in shows here. Once through, the web app signs in from the Access identity on its own.
    if (pairing !== attempt) throw new Error('A newer sign-in code was started.');
    if (isRedirectError(err)) return { needsAccess: true };
    throw new Error(`Couldn't reach ${address}. Check the address and your internet connection, then try again.`);
  }
  if (pairing !== attempt) throw new Error('A newer sign-in code was started.');
  const contentType = res.headers.get('content-type') ?? '';
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400) || (res.ok && contentType.includes('text/html'))) {
    return { needsAccess: true };
  }
  if (res.status === 429) throw new Error('Too many sign-in codes were made in a short time. Wait a minute, then press New code.');
  if (!res.ok) throw new Error(`Could not make a sign-in code (HTTP ${res.status}). Try again in a moment.`);
  if (!contentType.includes('application/json')) throw new Error('The server returned an unexpected response while making a sign-in code. Check the address and try again.');
  const p = await res.json();
  if (pairing !== attempt || settings.address !== address) throw new Error('A newer sign-in code was started.');
  const qr = qrcode(0, 'M');
  // The phone opens the address this app uses, not the server's own name for itself.
  qr.addData(`${address}/pair/${p.id}`);
  qr.make();
  pairing = { id: p.id, secret: p.secret, timer: null };
  const mine = pairing;
  const poll = async () => {
    if (pairing !== mine) return;
    let state = 'waiting';
    let link;
    try {
      const r = await ses().fetch(`${address}/api/auth/pair/${encodeURIComponent(mine.id)}`, {
        headers: { 'x-pair-secret': mine.secret, accept: 'application/json' },
        credentials: 'include',
        redirect: 'manual',
      });
      const body = await r.json().catch(() => ({}));
      state = r.status === 404 ? 'gone' : body.state ?? 'waiting';
      link = body.link;
    } catch {
      state = 'waiting'; // a dropped poll is tried again
    }
    if (pairing !== mine || settings.address !== address) return;
    const target = state === 'allowed' ? signInUrl(link, address) : null;
    if (target) {
      stopPairing();
      lastAppUrl = null;
      win.loadURL(target).catch(() => {});
      return;
    }
    if (state === 'denied' || state === 'gone' || state === 'allowed') {
      stopPairing();
      tellPage({ state: state === 'denied' ? 'denied' : 'expired' });
      return;
    }
    mine.timer = setTimeout(poll, 2000);
  };
  mine.timer = setTimeout(poll, 2000);
  return { code: p.code, expiresAt: p.expiresAt, svg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }), device: os.hostname() };
}

// ---------- what the app's own pages may ask for ----------
function prefsState() {
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    address: settings.address ?? '',
    startAtLogin: startsAtLogin(),
    toasts: toastsReady,
    paused: settings.notifications.pausedUntil > Date.now(),
    quickShortcut,
    talkShortcut,
    remote: remote?.statusText() ?? '',
    downloadsFolder: downloads?.folder() ?? '',
    zoom: Math.round(settings.zoom * 100),
    update: updater?.state() ?? null,
    settings: {
      closeToTray: settings.closeToTray, hardwareAcceleration: settings.hardwareAcceleration, spellcheck: settings.spellcheck,
      notifications: settings.notifications, downloads: settings.downloads, quickChat: { shortcut: settings.quickChat.shortcut, enabled: settings.quickChat.enabled }, talk: { shortcut: settings.talk.shortcut, enabled: settings.talk.enabled }, updates: { auto: settings.updates.auto },
    },
  };
}
function tellPrefs() {
  if (aux && !aux.isDestroyed()) aux.webContents.send('cleft:prefs', prefsState());
  trayBadge?.paint();
}

function applyPref(key) {
  if (key === 'spellcheck') ses().setSpellCheckerEnabled(settings.spellcheck);
  if (key.startsWith('quickChat.') || key.startsWith('talk.')) { registerQuickShortcut(); registerTalkShortcut(); buildMenu(); }
  if (key === 'closeToTray') buildMenu();
  if (key.startsWith('notifications.')) trayBadge?.paint();
}

const ACTIONS = {
  'open-logs': () => { const d = log.dir(); if (d) shell.openPath(d); },
  'open-downloads': () => shell.openPath(downloads.folder()),
  'copy-diagnostics': () => { clipboard.writeText(diagnostics()); },
  'open-remote': () => { showRemote(); },
  'open-settings': () => { showSettings(); },
  'quick-chat': () => { quick.show(); },
  talk: () => { talkNow(); },
  'restart': () => { app.relaunch(); app.quit(); },
  'test-notification': () => {
    const { Notification } = require('electron');
    if (toastsReady && Notification.isSupported()) new Notification({ title: 'YBots', body: 'This is what a notification from YBots looks like.', silent: !settings.notifications.sound }).show();
    else if (process.platform === 'win32' && trayBadge?.tray) trayBadge.tray.displayBalloon({ title: 'YBots', content: 'This is what a notification from YBots looks like.', iconType: 'info', noSound: !settings.notifications.sound });
  },
  'pick-downloads': async () => {
    const r = await dialog.showOpenDialog(aux ?? win, { title: 'Where should downloads go?', defaultPath: downloads.folder(), properties: ['openDirectory', 'createDirectory'] });
    if (!r.canceled && r.filePaths[0]) update({ downloads: { folder: r.filePaths[0] } });
  },
  'reset-downloads': () => { update({ downloads: { folder: '' } }); },
  'zoom-in': () => { runCommand('zoom-in'); },
  'zoom-out': () => { runCommand('zoom-out'); },
  'zoom-reset': () => { runCommand('zoom-reset'); },
  'change-address': () => { if (aux && !aux.isDestroyed()) aux.close(); showSetup('address'); },
  'sign-out': () => { if (aux && !aux.isDestroyed()) aux.close(); return signOut(); },
  'check-updates': () => { updater.check({ manual: true }); },
  'restart-to-update': () => { if (!updater.restart()) throw new Error('There is no update ready to start yet.'); },
};

function registerIpc() {
  // The calls the web app gets: bring the window forward, and say something finished while it was hidden.
  ipcMain.on('cleft:app-show', (event) => { if (fromAppPage(event)) showWindow(); });
  ipcMain.on('cleft:app-notify', (event, title, body, opts) => {
    if (!fromAppPage(event)) return;
    if (win && win.isVisible() && win.isFocused()) return;
    notifyFromApp(title, body, opts && typeof opts === 'object' ? opts : {});
  });
  // The theme picked in the app (System, Light, Dark): the setup, offline and "Use this PC" pages
  // follow it too, and it is remembered for the next start, before sign-in.
  ipcMain.on('cleft:app-theme', (event, theme) => {
    if (!fromAppPage(event)) return;
    const t = theme === 'light' || theme === 'dark' ? theme : undefined;
    if (settings.theme === t) return;
    update({ theme: t }, { quiet: true });
    nativeTheme.themeSource = t ?? 'system';
  });
  ipcMain.on('cleft:app-notify-clear', (event, tags) => {
    if (!fromAppPage(event) || !Array.isArray(tags)) return;
    clearNotifications(tags.filter((t) => typeof t === 'string'));
  });

  const local = (fn) => (event, ...a) => { if (!fromLocalPage(event)) throw new Error('refused'); return fn(event, ...a); };
  ipcMain.handle('cleft:pair-start', local(() => startPairing()));
  ipcMain.handle('cleft:pair-stop', local(() => { stopPairing(); return true; }));
  ipcMain.handle('cleft:get-settings', local(() => ({ address: settings.address ?? '', recent: settings.recentAddresses.filter((a) => a !== settings.address) })));
  ipcMain.handle('cleft:save-address', local((_e, input) => {
    const address = normalizeAddress(input);
    if (address !== settings.address) { stopPairing(); lastAppUrl = null; offline = null; trayBadge?.reset(); }
    update({ address, recentAddresses: [...new Set([address, settings.address, ...settings.recentAddresses].filter(Boolean))].slice(0, 5) });
    remote?.addressChanged();
    buildMenu();
    return { address };
  }));
  ipcMain.handle('cleft:open-app', local((event) => {
    // From the settings window, "Back to YBots" just closes it; the chat was never unloaded.
    if (aux && !aux.isDestroyed() && event.sender === aux.webContents) { aux.close(); showWindow(); return true; }
    stopPairing();
    openApp();
    return true;
  }));
  ipcMain.handle('cleft:sign-in-link', local((_e, link) => {
    if (!settings.address) throw new Error('Set the YBots address first.');
    const text = String(link ?? '').trim();
    const target = signInUrl(text, settings.address);
    if (!target) throw new Error('That is not a sign-in link. It should end in /api/auth/link/ and a long code.');
    stopPairing();
    lastAppUrl = null;
    win.loadURL(target).catch(() => {});
    return true;
  }));
  ipcMain.handle('cleft:read-clipboard-link', local(() => {
    // Only ever a sign-in link for this YBots, so the page can offer "Paste" without reading anything else.
    const text = clipboard.readText().trim().slice(0, 2000);
    return settings.address && signInUrl(text, settings.address) ? text : '';
  }));
  ipcMain.handle('cleft:offline-info', local(() => {
    const o = offline ?? { attempt: 0 };
    const hint = offlineHint({ code: o.code, description: o.description, status: o.status, address: settings.address });
    return { address: settings.address ?? '', ...hint, details: o.status ? `HTTP ${o.status}` : o.description ?? '', retryIn: hint.retry ? retryDelay(o.attempt) : 0, attempt: o.attempt };
  }));
  ipcMain.handle('cleft:prefs-get', local(() => prefsState()));
  ipcMain.handle('cleft:prefs-set', local((_e, key, value) => {
    update(cleanPatch(String(key), value));
    applyPref(String(key));
    return prefsState();
  }));
  ipcMain.handle('cleft:start-at-login', local((_e, on) => { setStartAtLogin(!!on); return prefsState(); }));
  ipcMain.handle('cleft:action', local(async (_e, name) => {
    const fn = ACTIONS[String(name)];
    if (!fn) throw new Error('refused');
    await fn();
    return prefsState();
  }));
  ipcMain.on('cleft:find', (event, text, opts) => { if (fromLocalPage(event)) findBar.find(typeof text === 'string' ? text : undefined, { forward: opts?.forward !== false, again: !!opts?.again }); });
  ipcMain.on('cleft:find-stop', (event) => { if (fromLocalPage(event)) findBar.close(); });
}

function runLaunch(l) {
  if (l.action === 'quick') quick.show();
  else if (l.action === 'screenshot') quick.showWithScreenshot();
  else if (l.action === 'settings') showSettings();
  else if (l.action === 'chat') openChat(l.botId);
  else if (!l.hidden) showWindow();
}

/** The taskbar button's right-click list. */
function setJumpList() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    app.setUserTasks([
      { program: process.execPath, arguments: '--quick-chat', iconPath: process.execPath, iconIndex: 0, title: 'Quick Chat', description: 'Send a message to a bot' },
      { program: process.execPath, arguments: '--screenshot', iconPath: process.execPath, iconIndex: 0, title: 'Screenshot to a bot', description: 'Take a picture of the screen and send it to a bot' },
      { program: process.execPath, arguments: '--settings', iconPath: process.execPath, iconIndex: 0, title: 'Settings', description: 'Settings for YBots on this PC' },
    ]);
  } catch (e) { log.warn('jump list', e); }
}

let errorShown = false;
function onFatal(kind, err) {
  log.error(kind, err);
  // One message box per run at most: a fault that repeats must not bury the screen in dialogs.
  if (errorShown || !app.isReady()) return;
  errorShown = true;
  dialog.showMessageBox({ type: 'error', title: 'YBots', message: 'YBots ran into a problem', detail: `It will keep running. If something stops working, quit and start it again.\n\n${String(err?.message ?? err).slice(0, 400)}`, buttons: ['OK', 'Copy details'] })
    .then(({ response }) => { if (response === 1) clipboard.writeText(diagnostics()); }).catch(() => {});
}

function boot() {
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  process.on('uncaughtException', (err) => onFatal('uncaught exception', err));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));
  // Starting it again (a taskbar task, a yanceybot:// link, a second double-click) talks to the copy that is running.
  app.on('second-instance', (_e, argv) => runLaunch(parseLaunch(argv)));
  app.on('web-contents-created', (_e, contents) => guardContents(contents));
  app.on('child-process-gone', (_e, details) => { if (details.reason !== 'clean-exit') log.warn('helper process gone', details.type, details.reason); });
  app.whenReady().then(() => {
    log.info(`start ${app.getVersion()} on ${os.type()} ${os.release()}${launch.hidden ? ' (hidden)' : ''}`);
    if (settingsWereBad) log.warn('settings file could not be read and was set aside');
    nativeTheme.themeSource = settings.theme ?? 'system';
    nativeTheme.on('updated', () => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setBackgroundColor(w.getTitle().includes('is using this PC') ? '#111111' : background()); });
    setUpToasts();
    syncLoginItem();
    guardSession();
    registerIpc();
    remote = createRemote({ app, partition: PARTITION, getAddress: () => settings.address, pagesDir: PAGES, onStatus: () => { tellPrefs(); }, log });
    remote.registerIpc(fromLocalPage);
    quick = createQuickChat({ pageUrl, preload: PRELOAD, background, api, getSettings: () => settings, update: (p) => update(p, { quiet: true }), openChat, log });
    quick.registerIpc(ipcMain, fromLocalPage);
    talk = createTalkPopup({ getAddress: () => settings.address, partition: PARTITION, preload: PRELOAD, background, openChat, log });
    talk.registerIpc(ipcMain);
    trayBadge = createTrayBadge({ assets: ASSETS, getWin: () => win, getSettings: () => settings, update, api, showWindow, openChat, log, extraItems: trayItems });
    updater = createUpdater({
      app, log, fetch: (url, init) => ses().fetch(url, init), address: () => settings.address, getSettings: () => settings, update,
      keys: !app.isPackaged && process.env.CLEFT_TEST_UPDATE_KEY ? [process.env.CLEFT_TEST_UPDATE_KEY] : undefined,
      onChange: () => {
        const u = updater?.state();
        if (win && !win.isDestroyed()) win.setProgressBar(u?.phase === 'downloading' ? Math.max(0.02, u.progress ?? 0) : -1);
        tellPrefs();
      },
      notify: (version) => notifyPlain('YBots was updated', `Version ${version} is ready and starts the next time you open YBots.`, showSettings),
    });
    registerQuickShortcut();
    registerTalkShortcut();
    buildMenu();
    createWindow();
    updater.start();
    if (process.env.CLEFT_NO_TRAY !== '1') {
      const tray = trayBadge.create();
      tray.on('balloon-click', () => openChat(lastBalloonBot));
    }
    if (process.platform === 'win32' && app.isPackaged) app.setAsDefaultProtocolClient('yanceybot');
    setJumpList();
    remote.start();
    // Back from sleep or a locked screen: connect again straight away instead of waiting out a retry.
    const wake = () => { remote?.wake?.(); if (offline && win && !win.isDestroyed()) openApp(); else trayBadge?.refresh(); };
    // A screen was unplugged (a laptop leaving its dock): a window left on it comes back to one that is there.
    screen.on('display-removed', () => {
      if (!win || win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
      const now = win.getBounds();
      const fit = fitBounds({ ...now, maximized: false }, screen.getAllDisplays().map((d) => d.workArea));
      if (Number.isFinite(fit.x) && (fit.x !== now.x || fit.y !== now.y || fit.width !== now.width || fit.height !== now.height)) win.setBounds({ x: fit.x, y: fit.y, width: fit.width, height: fit.height });
    });
    powerMonitor.on('resume', wake);
    powerMonitor.on('unlock-screen', wake);
    if (launch.action) setTimeout(() => runLaunch(launch), 600);
    if (process.env.CLEFT_TEST === '1') globalThis.__yb = { get settings() { return settings; }, get tray() { return trayBadge.state; }, trayMenu: () => trayBadge.menu().items.map((i) => i.label), talk: () => talk, setDownloadsFolder: (dir) => update({ downloads: { folder: dir } }), get quickShortcut() { return quickShortcut; }, diagnostics, runCommand, runLaunch, parseLaunch, showSettings, showRemote, quick, findBar, notifyFromApp, updater, get aux() { return aux; } };
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // Write the sign-in cookie to disk before quitting, so the next start is still signed in.
  let flushed = false;
  app.on('before-quit', (event) => {
    quitting = true;
    if (flushed) return;
    event.preventDefault();
    flushed = true;
    saveBoundsNow();
    log.info('quit');
    ses().cookies.flushStore().finally(() => app.quit());
  });
}
}

if (!handoff) boot();
else {
  // Start the newer copy and end, or carry on with this one if Windows will not start it.
  let child = null;
  const stay = (err) => { giveUp(app, handoff.version); log.warn(`could not start version ${handoff.version}; staying on ${app.getVersion()}`, err); boot(); };
  try {
    child = require('node:child_process').spawn(handoff.exe, handoff.args, { detached: true, stdio: 'ignore', cwd: path.dirname(handoff.exe) });
    child.once('error', stay);
    child.once('spawn', () => { child.unref(); process.exit(0); });
  } catch (err) { stay(err); }
}
