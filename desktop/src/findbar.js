'use strict';
// Find on the page (Ctrl+F): a small bar at the top right of the window with the count, next and
// previous. It is its own little window on top of the main one, so nothing is added to the web app's
// page. Esc or the X closes it and clears the highlights.

const { BrowserWindow } = require('electron');
const path = require('node:path');

const WIDTH = 380;
const HEIGHT = 52;

function createFindBar({ getWin, pageUrl, preload, background }) {
  let bar = null;
  let text = '';

  function place() {
    const win = getWin();
    if (!win || win.isDestroyed() || !bar || bar.isDestroyed()) return;
    const c = win.getContentBounds();
    const w = Math.min(WIDTH, Math.max(240, c.width - 24));
    bar.setBounds({ x: c.x + c.width - w - 16, y: c.y + 12, width: w, height: HEIGHT });
  }

  function ensure() {
    const win = getWin();
    if (bar && !bar.isDestroyed()) return bar;
    bar = new BrowserWindow({
      parent: win, width: WIDTH, height: HEIGHT, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, show: false, hasShadow: true, backgroundColor: background(),
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    bar.loadURL(pageUrl('find.html'));
    bar.on('closed', () => { bar = null; });
    for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) win.on(ev, place);
    win.on('hide', () => close());
    win.on('minimize', () => close());
    return bar;
  }

  function open() {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    const b = ensure();
    place();
    const show = () => { b.show(); b.focus(); b.webContents.send('cleft:find-focus', text); };
    if (b.webContents.isLoading()) b.webContents.once('did-finish-load', show); else show();
  }

  function find(next, { forward = true, again = false } = {}) {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    if (typeof next === 'string') text = next.slice(0, 500);
    if (!text) { win.webContents.stopFindInPage('clearSelection'); result({ matches: 0, activeMatchOrdinal: 0 }); return; }
    win.webContents.findInPage(text, { forward, findNext: again });
  }

  function result(r) {
    if (bar && !bar.isDestroyed() && r.finalUpdate !== false) bar.webContents.send('cleft:find-result', { matches: r.matches ?? 0, active: r.activeMatchOrdinal ?? 0 });
  }

  function close() {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.stopFindInPage('clearSelection');
    if (bar && !bar.isDestroyed() && bar.isVisible()) {
      bar.hide();
      if (win && !win.isDestroyed() && win.isVisible()) win.focus();
    }
  }

  return {
    open,
    close,
    find,
    result,
    /** F3 with the bar closed finds the last text again, or opens the bar when there is none. */
    step: (forward) => { if (text) find(undefined, { forward, again: true }); else open(); },
    get visible() { return !!bar && !bar.isDestroyed() && bar.isVisible(); },
    path: path.join('pages', 'find.html'),
  };
}

module.exports = { createFindBar };
