'use strict';
// Quick Chat: a small window that opens over whatever you are doing (a global shortcut, the tray menu or
// the taskbar's right-click list), where you pick a bot, type a message and press Enter. The message is
// sent as yours, with the same sign-in as the main window, and lands in that bot's chat. The window
// then gets out of the way; the answer arrives in the chat (and as a notification, as usual).
//
// A message can carry a screenshot, a pasted picture or files, sent the same way the chat's own paperclip
// sends them (they land in the bot's Library). A screenshot is only ever taken when the person presses the
// button or its shortcut, and it shows in the window before anything is sent.
//
// It can only send a chat message. It cannot answer an approval, and it never shows one.

const { BrowserWindow, screen, clipboard, desktopCapturer, dialog, nativeImage } = require('electron');
const crypto = require('node:crypto');
const { summarize } = require('./attention');
const fs = require('node:fs');
const path = require('node:path');

const WIDTH = 620;
const HEIGHT = 228;
const HEIGHT_WITH_FILES = 300;
const MAX_FILES = 8; // the server's own limits (chat-extras.ts)
const MAX_BYTES = 25 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

/** The bots to offer, in the chat list's own order: main bot, your bots, pinned, most recent. */
function quickBots(body) {
  const bots = Array.isArray(body?.bots) ? body.bots : [];
  // The same "who needs you" the tray shows, so a bot waiting on an answer is marked here too.
  const needs = new Map(summarize(body).bots.map((b) => [b.id, b.state]));
  return bots
    .filter((b) => b && typeof b.id === 'string' && ID.test(b.id) && !b.ownerHidden && !(b.outside && b.outside.status === 'not-set-up'))
    .sort((a, b) => Number(!!b.isPrimary) - Number(!!a.isPrimary) || Number(!!a.outside) - Number(!!b.outside) || Number(!!b.pinned) - Number(!!a.pinned) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    .slice(0, 24)
    .map((b) => ({
      id: b.id,
      name: String(b.name ?? 'Bot').replace(/[\r\n\t]+/g, ' ').slice(0, 40) || 'Bot',
      group: b.kind === 'room',
      color: typeof b.chatColor === 'string' && /^[a-z]{3,10}$/.test(b.chatColor) ? b.chatColor : null,
      needs: needs.get(b.id) ?? null, // 'waiting' | 'unread' | null
    }));
}

const two = (n) => String(n).padStart(2, '0');
/** "Screenshot 2026-11-24 16.08.33.png": sorts by time and is a legal file name everywhere. */
function stampedName(kind, d = new Date()) {
  return `${kind} ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}.png`;
}

/** Why one more file may not be added, or null when it may. */
function attachRefusal(count, size) {
  if (count >= MAX_FILES) return `A message can carry ${MAX_FILES} files at most.`;
  if (!size) return 'That file is empty.';
  if (size > MAX_BYTES) return 'That file is larger than 25 MB, which is the most a message can carry.';
  return null;
}

const sizeText = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function createQuickChat({ pageUrl, preload, background, api, getSettings, update, openChat, log }) {
  let win = null;
  let shownAt = 0;
  let busy = false; // taking a screenshot or showing the file picker: losing the focus must not put the window away
  let pending = []; // files waiting to go with the next message: { id, name, data, size, thumb }

  function ensure() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: WIDTH, height: HEIGHT, frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false, title: 'YBots Quick Chat', backgroundColor: background(),
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: getSettings().spellcheck },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.loadURL(pageUrl('quick.html'));
    // Clicking anywhere else puts it away (unless it only just opened: Windows can take focus back for a moment).
    win.on('blur', () => { if (!busy && Date.now() - shownAt > 400) hide(); });
    win.on('closed', () => { win = null; });
    return win;
  }

  function show() {
    const w = ensure();
    // On the screen the mouse is on, a third of the way down.
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(WIDTH, area.width - 24);
    w.setBounds({ x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + area.height * 0.22), width, height: pending.length ? HEIGHT_WITH_FILES : HEIGHT });
    shownAt = Date.now();
    const go = () => { w.show(); w.focus(); w.webContents.send('cleft:quick-show', { lastBot: getSettings().quickChat.lastBot, files: files() }); };
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go();
  }

  function hide() { if (win && !win.isDestroyed() && win.isVisible()) win.hide(); }
  function toggle() { if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) hide(); else show(); }

  async function bots() {
    return quickBots(await api('/api/bots'));
  }

  // ----- files waiting to go with the message -----
  const files = () => pending.map((f) => ({ id: f.id, name: f.name, size: sizeText(f.size), thumb: f.thumb }));
  function fit() {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const height = pending.length ? HEIGHT_WITH_FILES : HEIGHT;
    if (b.height !== height) win.setBounds({ ...b, height });
  }
  function add(name, data) {
    const no = attachRefusal(pending.length, data.length);
    if (no) throw new Error(no);
    let thumb = '';
    if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) {
      try { const img = nativeImage.createFromBuffer(data); if (!img.isEmpty()) thumb = img.resize({ height: 88 }).toDataURL(); } catch { /* no preview */ }
    }
    pending.push({ id: crypto.randomUUID(), name: String(name).slice(0, 120), data, size: data.length, thumb });
    fit();
  }
  function remove(id) { pending = pending.filter((f) => f.id !== id); fit(); return files(); }

  /** The screen the mouse is on, as a PNG. The window steps aside first so it is not in the picture. */
  async function screenshot() {
    if (busy) return files();
    const no = attachRefusal(pending.length, 1);
    if (no) throw new Error(no);
    busy = true;
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const visible = win && !win.isDestroyed() && win.isVisible();
      if (visible) { win.hide(); await new Promise((r) => setTimeout(r, 220)); }
      let png = null;
      try {
        const scale = Math.min(display.scaleFactor || 1, 3);
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } });
        const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
        if (source && !source.thumbnail.isEmpty()) png = source.thumbnail.toPNG();
      } finally {
        if (visible && win && !win.isDestroyed()) { shownAt = Date.now(); win.show(); win.focus(); }
      }
      if (!png) throw new Error('The screen could not be captured on this PC.');
      add(stampedName('Screenshot'), png);
      return files();
    } finally { busy = false; }
  }

  /** A picture on the clipboard (Ctrl+V with no text to paste). Null when there is none. */
  function pasteImage() {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    add(stampedName('Pasted picture'), img.toPNG());
    return files();
  }

  function addPaths(paths) {
    for (const p of paths) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
      let st;
      try { st = fs.statSync(p); } catch { throw new Error(`${path.basename(p)} could not be read.`); }
      if (!st.isFile()) throw new Error('Folders can\'t be attached. Pick the files inside it.');
      const no = attachRefusal(pending.length, st.size);
      if (no) throw new Error(no);
      add(path.basename(p), fs.readFileSync(p));
    }
    return files();
  }

  async function pickFiles() {
    if (busy || !win || win.isDestroyed()) return files();
    busy = true;
    try {
      const r = await dialog.showOpenDialog(win, { title: 'Attach files', properties: ['openFile', 'multiSelections'] });
      return r.canceled ? files() : addPaths(r.filePaths.slice(0, MAX_FILES));
    } finally { busy = false; shownAt = Date.now(); if (win && !win.isDestroyed()) win.focus(); }
  }

  async function send(botId, text) {
    if (typeof botId !== 'string' || !ID.test(botId)) throw new Error('Pick a bot first.');
    const message = String(text ?? '').trim();
    if (!message && !pending.length) throw new Error('Type a message first.');
    if (message.length > 20_000) throw new Error('That is too long for Quick Chat. Open the chat to send it.');
    // Files first (the same upload the chat's paperclip uses); one that already went up is not sent twice on a retry.
    for (const f of pending) {
      if (f.sentTo === botId && f.path) continue;
      const r = await api(`/api/bots/${botId}/attachments?name=${encodeURIComponent(f.name)}`, { method: 'PUT', body: f.data, headers: { 'content-type': 'application/octet-stream' } });
      if (typeof r?.file?.path !== 'string') throw new Error(`${f.name} could not be attached.`);
      f.path = r.file.path;
      f.sentTo = botId;
    }
    // The clientId makes a retry after a dropped connection safe: the server answers the message it already has.
    await api(`/api/bots/${botId}/messages`, { method: 'POST', body: JSON.stringify({ text: message, ...(pending.length ? { attachments: pending.map((f) => f.path) } : {}), clientId: `quick-${crypto.randomUUID()}` }) });
    const n = pending.length;
    pending = [];
    fit();
    update({ quickChat: { lastBot: botId } });
    log.info(`quick chat: message sent${n ? ` with ${n} file${n === 1 ? '' : 's'}` : ''}`);
    return true;
  }

  function registerIpc(ipcMain, fromLocalPage) {
    const guard = (fn) => (event, ...a) => { if (!fromLocalPage(event)) throw new Error('refused'); return fn(...a); };
    ipcMain.handle('cleft:quick-bots', guard(() => bots()));
    ipcMain.handle('cleft:quick-send', guard((botId, text) => send(botId, text)));
    ipcMain.handle('cleft:quick-open', guard((botId) => { hide(); openChat(typeof botId === 'string' && ID.test(botId) ? botId : null); return true; }));
    ipcMain.handle('cleft:quick-hide', guard(() => { hide(); return true; }));
    ipcMain.handle('cleft:quick-files', guard(() => files()));
    ipcMain.handle('cleft:quick-screenshot', guard(() => screenshot()));
    ipcMain.handle('cleft:quick-paste-image', guard(() => pasteImage()));
    ipcMain.handle('cleft:quick-pick-files', guard(() => pickFiles()));
    ipcMain.handle('cleft:quick-drop', guard((paths) => addPaths(Array.isArray(paths) ? paths.slice(0, MAX_FILES) : [])));
    ipcMain.handle('cleft:quick-remove', guard((id) => remove(String(id))));
  }

  /** From the tray or the taskbar: take the picture first, then open with it attached. */
  async function showWithScreenshot() {
    try { await screenshot(); } catch (e) { log.warn('quick chat screenshot', e); }
    show();
  }

  return { show, hide, toggle, showWithScreenshot, registerIpc, add: (name, data) => { add(name, data); return files(); }, files, get window() { return win; } };
}

module.exports = { createQuickChat, quickBots, stampedName, attachRefusal };
