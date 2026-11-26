'use strict';
// The Talk popup: what the Talk shortcut (Alt+Shift+L by default) and the tray's "Talk to a Bot" open. Like
// the phone's assistant card, a small window at the bottom of the screen you are on, over whatever you are
// doing. It shows the web app's quick-ask card (web/src/components/QuickAsk.tsx, the page /?talk&popup=1)
// with the main window's own sign-in: it listens at once, sends what you said when you stop talking, and
// shows (and reads out) the answer. "Open in app" goes on in the main window's chat.
//
// The window grows and shrinks with the card (the page says how tall it is). Clicking elsewhere puts it away,
// as Quick Chat does. Share screen takes a picture of the screen only when the person presses it; the popup
// steps aside first so it is not in the picture, and the picture shows on the card before anything is sent.

const { BrowserWindow, screen, desktopCapturer } = require('electron');

const WIDTH = 600;
const MIN_HEIGHT = 140;
const MAX_HEIGHT = 640;
const GAP = 16;

function createTalkPopup({ getAddress, partition, preload, background, openChat, log }) {
  let win = null;
  let shownAt = 0;
  let busy = false; // taking a screenshot or showing the file picker: losing the focus must not put it away
  let height = 220;
  let loadedFor = '';

  const url = (address) => `${new URL(address).origin}/?talk&popup=1`;

  function place(w) {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(WIDTH, area.width - 2 * GAP);
    const h = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height, area.height - 2 * GAP));
    w.setBounds({ x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + area.height - h - GAP), width, height: h });
  }

  function ensure() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: WIDTH, height, frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false, title: 'YBots Talk', backgroundColor: background(),
      roundedCorners: true,
      webPreferences: {
        partition, preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
        // It listens as soon as it opens, before any click in it.
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.on('blur', () => { if (!busy && Date.now() - shownAt > 500) hide(); });
    win.on('closed', () => { win = null; loadedFor = ''; });
    return win;
  }

  function show() {
    const address = getAddress();
    if (!address) { openChat(null); return; }
    const w = ensure();
    place(w);
    shownAt = Date.now();
    if (loadedFor !== address) {
      loadedFor = address;
      w.loadURL(url(address)).catch((e) => log.warn('talk popup load', e?.message ?? e));
      w.webContents.once('did-finish-load', () => { if (!w.isDestroyed()) { w.show(); w.focus(); } });
    } else {
      w.show();
      w.focus();
      // Already loaded: a fresh start (listening again, nothing left over from last time).
      w.webContents.send('cleft:talk-start');
    }
  }

  function hide() {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.webContents.send('cleft:talk-stop');
    win.hide();
  }

  function toggle() { if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) hide(); else show(); }

  /** The screen the popup is on, as a JPEG (base64). The popup steps aside first so it is not in the picture. */
  async function capture() {
    if (busy) throw new Error('Already taking a picture.');
    busy = true;
    try {
      const visible = win && !win.isDestroyed() && win.isVisible();
      const display = visible ? screen.getDisplayMatching(win.getBounds()) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      if (visible) { win.setOpacity(0); await new Promise((r) => setTimeout(r, 220)); }
      let jpeg = null;
      try {
        const scale = Math.min(display.scaleFactor || 1, 2);
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } });
        const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
        if (source && !source.thumbnail.isEmpty()) jpeg = source.thumbnail.toJPEG(85);
      } finally {
        if (visible && win && !win.isDestroyed()) { win.setOpacity(1); shownAt = Date.now(); win.focus(); }
      }
      if (!jpeg) throw new Error('The screen could not be captured on this PC.');
      return { name: 'Screen.jpg', type: 'image/jpeg', data: jpeg.toString('base64') };
    } finally { busy = false; }
  }

  /** Only the popup's own page, on the signed-in address, may use these. */
  const fromPopup = (event) => {
    const address = getAddress();
    if (!win || win.isDestroyed() || event.sender !== win.webContents || !address) return false;
    try { return new URL(event.senderFrame?.url ?? '').origin === new URL(address).origin; } catch { return false; }
  };

  function registerIpc(ipcMain) {
    const guard = (fn) => (event, ...a) => { if (!fromPopup(event)) throw new Error('refused'); return fn(...a); };
    ipcMain.handle('cleft:talk-size', guard((h) => {
      const n = Number(h);
      if (!Number.isFinite(n) || !win) return false;
      height = Math.round(n);
      if (win.isVisible()) {
        const b = win.getBounds();
        const area = screen.getDisplayMatching(b).workArea;
        const nh = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height, area.height - 2 * GAP));
        if (nh !== b.height) win.setBounds({ x: b.x, y: b.y + b.height - nh, width: b.width, height: nh });
      }
      return true;
    }));
    ipcMain.handle('cleft:talk-close', guard(() => { hide(); return true; }));
    ipcMain.handle('cleft:talk-open', guard((botId) => { hide(); openChat(typeof botId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(botId) ? botId : null); return true; }));
    ipcMain.handle('cleft:talk-capture', guard(() => capture()));
    // The page is about to show the file picker: losing the focus to it must not put the popup away.
    ipcMain.handle('cleft:talk-busy', guard((on) => { busy = !!on; if (!on) shownAt = Date.now(); return true; }));
  }

  return { show, hide, toggle, registerIpc, get window() { return win; } };
}

module.exports = { createTalkPopup };
