/*
 * The page inside the phone app's WebView that shows a bot's screen (noVNC) and, while the person drives
 * it, the touch bar under it. Bundled into src/vnc/page.generated.ts by scripts/build-vnc.mjs.
 *
 * The page never talks to the server. The app opens the screen socket itself (it holds the sign-in token
 * and the Cloudflare Access headers, which a page's WebSocket cannot send) and passes the bytes through:
 *   app -> page: window.__cleft({ t: 'start' | 'open' | 'data' | 'closed' | 'stop' | 'fullscreen' | 'ctrlV' | 'note' | 'clipBusy', ... })
 *   page -> app: ReactNativeWebView.postMessage(JSON.stringify({ t: 'ready' | 'send' | 'close' | 'state' | 'handback' | 'fullscreen' | 'helpSeen' | 'clipPaste' | 'clipCopy' }))
 *
 * Copy and paste (start's `clip`: true when this screen allows it): the Clipboard button opens a tray with
 * "Paste from phone" and "Copy to phone"; the app moves the text (it holds the phone's clipboard and the
 * sign-in) and answers with 'ctrlV' (press Ctrl+V here) and a short 'note'.
 *
 * The touch bar is the web app's (web/src/components/ScreenTouch.tsx) in plain DOM: it lives in the page so
 * the hidden text box that brings up the phone keyboard is focused by a real tap, as Android requires.
 */
import RFB from '@novnc/novnc';

const post = (m) => window.ReactNativeWebView?.postMessage(JSON.stringify(m));
// noVNC says why it gave up only in its log (console.error), which it binds when it loads. A small script ahead
// of this one (scripts/build-vnc.mjs) keeps the last such line in window.__cleftFail; it goes to the app with
// the state, so the app can say what actually failed.
const lastFail = () => window.__cleftFail || '';

// ---------- bytes ----------
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

/** A WebSocket-shaped channel for noVNC whose far end is the app. */
class AppChannel {
  constructor() {
    this.binaryType = 'arraybuffer';
    this.protocol = 'binary';
    this.readyState = 'connecting';
    this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
  }
  send(data) {
    if (this.readyState !== 'open') return;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    post({ t: 'send', d: toB64(bytes) });
  }
  close() {
    if (this.readyState === 'closed' || this.readyState === 'closing') return;
    this.readyState = 'closing';
    post({ t: 'close' });
  }
  _open() { this.readyState = 'open'; this.onopen?.(); }
  _data(b64) { if (this.readyState === 'open') this.onmessage?.({ data: fromB64(b64) }); }
  _closed(code, reason) {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.({ code: code ?? 1006, reason: reason ?? '', wasClean: code === 1000 });
  }
}

// ---------- keys (X11 keysyms) ----------
const KEY = {
  Return: 0xff0d, BackSpace: 0xff08, Tab: 0xff09, Escape: 0xff1b, Delete: 0xffff,
  Home: 0xff50, Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54, PageUp: 0xff55, PageDown: 0xff56, End: 0xff57,
  Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9, Super: 0xffeb, F1: 0xffbe,
};
const NAMED = {
  Enter: [KEY.Return, 'Enter'], Backspace: [KEY.BackSpace, 'Backspace'], Tab: [KEY.Tab, 'Tab'], Escape: [KEY.Escape, 'Escape'],
  Delete: [KEY.Delete, 'Delete'], Home: [KEY.Home, 'Home'], End: [KEY.End, 'End'], PageUp: [KEY.PageUp, 'PageUp'], PageDown: [KEY.PageDown, 'PageDown'],
  ArrowLeft: [KEY.Left, 'ArrowLeft'], ArrowUp: [KEY.Up, 'ArrowUp'], ArrowRight: [KEY.Right, 'ArrowRight'], ArrowDown: [KEY.Down, 'ArrowDown'],
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = [KEY.F1 + i - 1, `F${i}`];
const charKeysym = (ch) => {
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) ? cp : 0x01000000 | cp;
};
const MOD_KEY = { ctrl: [KEY.Control, 'ControlLeft'], alt: [KEY.Alt, 'AltLeft'], shift: [KEY.Shift, 'ShiftLeft'], super: [KEY.Super, 'MetaLeft'] };
const FILLER = '_'.repeat(40);

// ---------- icons (24px stroke icons, like the app's) ----------
const svg = (d, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  keyboard: svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/>'),
  keys: svg('<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>', 16),
  zoomIn: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M11 8v6M8 11h6"/>', 17),
  zoomOut: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M8 11h6"/>', 17),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.3M12 17h.01"/>', 16),
  expand: svg('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>', 16),
  clip: svg('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>', 16),
  shrink: svg('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>', 16),
};

// ---------- page ----------
const $ = (sel) => document.querySelector(sel);
const canvasEl = $('#canvas');
const barEl = $('#touch');
let rfb = null;
let channel = null;
let opts = { mode: 'watch', zoom: false, help: true, fullscreen: false, name: 'the bot', clip: false };
let kbOpen = false;
let keysOpen = false;
let clipOpen = false;
let clipBusy = false;
let noteText = '';
let noteTimer = null;
let mods = { ctrl: false, alt: false, shift: false, super: false };

function stop() {
  const ch = channel;
  const r = rfb;
  // Forget the old connection first, so its disconnect below is not reported: the app stopped it on purpose,
  // and a late "disconnected" would read as the new connection failing.
  channel = null;
  rfb = null;
  if (r) { try { r.disconnect(); } catch { /* closed */ } }
  // The app drops the socket itself; finish noVNC's disconnect now rather than after its timeout.
  ch?._closed(1000, '');
  canvasEl.innerHTML = '';
}

function start(o) {
  stop();
  opts = { ...opts, ...o };
  document.body.classList.toggle('is-driving', opts.mode === 'control');
  document.documentElement.style.setProperty('--action', o.action ?? '#FFFFFF');
  document.documentElement.style.setProperty('--on-action', o.onAction ?? '#111111');
  window.__cleftFail = '';
  channel = new AppChannel();
  const ch = channel;
  rfb = new RFB(canvasEl, ch, { shared: true });
  rfb.viewOnly = opts.mode === 'watch';
  applyZoom();
  rfb.resizeSession = false;
  rfb.background = '#000000';
  rfb.focusOnClick = opts.mode === 'control' && !kbOpen;
  // `sid` names the app's connection, so the app can tell a late report about an earlier one.
  const sid = o.sid;
  rfb.addEventListener('connect', () => { if (ch === channel) post({ t: 'state', s: 'connected', sid }); });
  rfb.addEventListener('disconnect', (e) => { if (ch === channel) post({ t: 'state', s: e.detail?.clean ? 'disconnected' : 'error', why: lastFail(), sid }); });
  rfb.addEventListener('securityfailure', (e) => { if (ch === channel) post({ t: 'state', s: 'error', why: e.detail?.reason || lastFail(), sid }); });
  renderBar();
}

function applyZoom() {
  if (!rfb) return;
  const zoom = opts.mode === 'control' && opts.zoom;
  rfb.clipViewport = zoom;
  rfb.dragViewport = zoom;
  rfb.scaleViewport = !zoom;
}

/** Press one key on the remote screen, holding any modifiers that are on, then switch them off. */
function press(keysym, code, extra = {}) {
  if (!rfb || opts.mode !== 'control') return;
  const held = Object.keys(MOD_KEY).filter((m) => mods[m] || extra[m]);
  for (const m of held) rfb.sendKey(MOD_KEY[m][0], MOD_KEY[m][1], true);
  rfb.sendKey(keysym, code);
  for (const m of held.reverse()) rfb.sendKey(MOD_KEY[m][0], MOD_KEY[m][1], false);
  if (held.some((m) => mods[m])) { mods = { ctrl: false, alt: false, shift: false, super: false }; renderBar(); }
}
const typeText = (text) => { for (const ch of Array.from(text)) ch === '\n' ? press(KEY.Return, 'Enter') : press(charKeysym(ch), ''); };

// The hidden text box: comparing its text before and after each change tells us what the keyboard did, which
// covers autocorrect, swipe typing and Android keyboards that report every key as "Unidentified".
const input = $('#input');
let last = FILLER;
const resetInput = () => { input.value = FILLER; last = FILLER; input.setSelectionRange(FILLER.length, FILLER.length); };
input.value = FILLER;
input.addEventListener('input', (e) => {
  const now = input.value;
  let same = 0;
  while (same < last.length && same < now.length && last[same] === now[same]) same++;
  for (let i = 0; i < last.length - same; i++) press(KEY.BackSpace, 'Backspace');
  typeText(now.slice(same));
  last = now;
  if (!e.isComposing && (now.length < 10 || now.length > 200 || now.includes('\n'))) resetInput();
});
input.addEventListener('keydown', (e) => {
  if (e.isComposing || e.key === 'Unidentified' || e.key === 'Process') return;
  const named = NAMED[e.key];
  if (named) { e.preventDefault(); press(named[0], named[1], { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, super: e.metaKey }); }
  else if ((e.ctrlKey || e.altKey || e.metaKey) && e.key.length === 1) { e.preventDefault(); press(charKeysym(e.key), e.code, { ctrl: e.ctrlKey, alt: e.altKey, super: e.metaKey }); }
});
input.addEventListener('compositionend', () => { if (input.value.length > 200) resetInput(); });
const setKb = (open) => {
  kbOpen = open;
  // While the keyboard is open a tap on the picture must not take focus, or the keyboard closes.
  if (rfb) rfb.focusOnClick = opts.mode === 'control' && !open;
  renderBar();
};
input.addEventListener('focus', () => setKb(true));
input.addEventListener('blur', () => setKb(false));

function toggleKeyboard() {
  if (document.activeElement === input) { input.blur(); return; }
  resetInput();
  input.focus({ preventScroll: true });
}

const KEYS = [
  ['Esc', 'Escape', () => press(KEY.Escape, 'Escape')],
  ['Tab', null, () => press(KEY.Tab, 'Tab')],
  ['Ctrl', null, null, 'ctrl'], ['Alt', null, null, 'alt'], ['Shift', null, null, 'shift'], ['Super', 'Super (Windows key)', null, 'super'],
  ['←', 'Left arrow', () => press(KEY.Left, 'ArrowLeft')], ['↑', 'Up arrow', () => press(KEY.Up, 'ArrowUp')],
  ['↓', 'Down arrow', () => press(KEY.Down, 'ArrowDown')], ['→', 'Right arrow', () => press(KEY.Right, 'ArrowRight')],
  ['Enter', null, () => press(KEY.Return, 'Enter')], ['⌫', 'Backspace', () => press(KEY.BackSpace, 'Backspace')],
  ['Del', 'Delete', () => press(KEY.Delete, 'Delete')], ['Home', null, () => press(KEY.Home, 'Home')], ['End', null, () => press(KEY.End, 'End')],
  ['PgUp', 'Page up', () => press(KEY.PageUp, 'PageUp')], ['PgDn', 'Page down', () => press(KEY.PageDown, 'PageDown')],
  ['Ctrl+C', 'Copy (Ctrl+C)', () => press(charKeysym('c'), 'KeyC', { ctrl: true })],
  ['Ctrl+V', 'Paste (Ctrl+V)', () => press(charKeysym('v'), 'KeyV', { ctrl: true })],
  ['Ctrl+Alt+Del', null, () => rfb?.sendCtrlAltDel()],
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderBar() {
  if (opts.mode !== 'control') { barEl.hidden = true; return; }
  barEl.hidden = false;
  const help = opts.help ? `
    <div class="help" role="note">
      <ul>
        <li><b>Tap</b> to click</li>
        <li><b>Hold</b> or <b>two-finger tap</b> to right-click</li>
        <li><b>Drag one finger</b> to drag${opts.zoom ? ' (pans while zoomed)' : ''}</li>
        <li><b>Drag two fingers</b> to scroll</li>
        <li><b>Pinch</b> zooms inside the app on screen; the magnifier below enlarges the picture</li>
      </ul>
      <button type="button" class="help-ok" data-act="helpOk">Got it</button>
    </div>` : '';
  const clipTray = clipOpen && opts.clip ? `<div class="keys" role="toolbar" aria-label="Copy and paste">
      <button type="button" class="key" data-act="clipPaste"${clipBusy ? ' disabled' : ''}>Paste from phone</button>
      <button type="button" class="key" data-act="clipCopy"${clipBusy ? ' disabled' : ''}>Copy to phone</button>
    </div>` : '';
  const note = noteText ? `<div class="note" role="status">${esc(noteText)}</div>` : '';
  const keys = keysOpen ? `<div class="keys" role="toolbar" aria-label="Extra keys">${KEYS.map(([label, aria, , mod], i) =>
    `<button type="button" class="key${mod && mods[mod] ? ' is-on' : ''}" data-key="${i}"${aria ? ` aria-label="${esc(aria)}"` : ''}${mod ? ` aria-pressed="${mods[mod]}"` : ''}>${esc(label)}</button>`).join('')}</div>` : '';
  const btn = (act, icon, label, on) => `<button type="button" class="icon${on ? ' is-on' : ''}" data-act="${act}" aria-label="${esc(label)}" aria-pressed="${!!on}">${icon}<span class="lbl">${esc(label)}</span></button>`;
  barEl.querySelector('.slot').innerHTML = `${help}${note}${keys}${clipTray}
    <div class="bar" role="toolbar" aria-label="Touch controls">
      ${btn('kb', ICON.keyboard, 'Keyboard', kbOpen)}
      ${btn('keys', ICON.keys, 'Keys', keysOpen)}
      ${opts.clip ? btn('clip', ICON.clip, 'Copy/paste', clipOpen) : ''}
      ${btn('zoom', opts.zoom ? ICON.zoomOut : ICON.zoomIn, opts.zoom ? 'Fit' : 'Zoom', opts.zoom)}
      ${btn('help', ICON.help, 'Gestures', opts.help)}
      <span class="spacer"></span>
      <button type="button" class="icon" data-act="fs" aria-label="${opts.fullscreen ? 'Leave full screen' : 'Full screen'}">${opts.fullscreen ? ICON.shrink : ICON.expand}</button>
      <button type="button" class="handback" data-act="handback" aria-label="Hand back to ${esc(opts.name)}">Hand back</button>
    </div>`;
}

// Buttons in the bar must not take focus from the hidden text box, or the keyboard would close on every key.
barEl.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
barEl.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
barEl.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.key !== undefined) {
    const [, , run, mod] = KEYS[Number(b.dataset.key)];
    if (mod) { mods = { ...mods, [mod]: !mods[mod] }; renderBar(); } else run();
    return;
  }
  switch (b.dataset.act) {
    case 'kb': toggleKeyboard(); break;
    case 'keys': keysOpen = !keysOpen; clipOpen = false; renderBar(); break;
    case 'clip': clipOpen = !clipOpen; keysOpen = false; renderBar(); break;
    case 'clipPaste': if (!clipBusy) post({ t: 'clipPaste' }); break;
    case 'clipCopy': if (!clipBusy) post({ t: 'clipCopy' }); break;
    case 'zoom': opts.zoom = !opts.zoom; applyZoom(); renderBar(); break;
    case 'help': opts.help = !opts.help; if (!opts.help) post({ t: 'helpSeen' }); renderBar(); break;
    case 'helpOk': opts.help = false; post({ t: 'helpSeen' }); renderBar(); break;
    case 'fs': post({ t: 'fullscreen' }); break;
    case 'handback': input.blur(); post({ t: 'handback' }); break;
  }
});

// ---------- messages from the app ----------
window.__cleft = (m) => {
  switch (m.t) {
    case 'start': start(m); break;
    case 'open': channel?._open(); break;
    case 'data': for (const d of m.d) channel?._data(d); break;
    case 'closed': channel?._closed(m.code, m.reason); break;
    case 'stop': stop(); break;
    case 'fullscreen': opts.fullscreen = !!m.on; renderBar(); break;
    // Copy and paste: the app put the phone's text on the remote clipboard; press Ctrl+V there.
    case 'ctrlV': press(charKeysym('v'), 'KeyV', { ctrl: true }); break;
    case 'clipBusy': clipBusy = !!m.on; renderBar(); break;
    // The phone closed its keyboard itself (its close-keyboard button or Back): match the Keyboard button to it.
    case 'kbHidden': if (document.activeElement === input) input.blur(); else if (kbOpen) setKb(false); break;
    case 'note':
      noteText = String(m.text ?? '');
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => { noteText = ''; renderBar(); }, 3500);
      renderBar();
      break;
  }
};
post({ t: 'ready' });
