'use strict';
// What the app remembers between starts (settings.json in its data folder), kept free of Electron so the
// rules can be tested on their own. Anything that is missing, of the wrong kind or out of range falls
// back to its default, so a hand-edited or half-written file can never stop the app from starting.

const { normalizeAddress } = require('./policy');

const DEFAULTS = Object.freeze({
  address: undefined,
  recentAddresses: [],
  theme: undefined, // 'light' | 'dark' | undefined (follow Windows)
  window: null, // { x, y, width, height, maximized }
  zoom: 1,
  alwaysOnTop: false,
  closeToTray: true,
  startAtLogin: null, // what the person chose; null until they have (then Windows' own list is asked once)
  trayHintShown: false,
  hardwareAcceleration: true,
  spellcheck: true,
  notifications: { enabled: true, sound: true, pausedUntil: 0, flash: true, badge: true },
  downloads: { ask: true, folder: '' },
  quickChat: { shortcut: 'Alt+Shift+Y', lastBot: '', enabled: true },
  // Talk: open the talk Bot's chat (Leonard, else the main Bot) with dictation on, like the phone's assistant gesture.
  talk: { shortcut: 'Alt+Shift+L', enabled: true },
  updates: { auto: true, lastCheck: 0, skipped: '' },
});

const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const num = (v, d, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : d);
const str = (v, d, max = 400) => (typeof v === 'string' && v.length <= max ? v : d);

/** A keyboard shortcut Electron can register ("Ctrl+Alt+Space"): at least one modifier and one key. */
function cleanShortcut(v) {
  if (typeof v !== 'string') return null;
  if (v === '') return '';
  const parts = v.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return null;
  const mods = new Set(['Ctrl', 'Alt', 'Shift', 'Super']);
  const key = parts[parts.length - 1];
  const used = parts.slice(0, -1);
  if (!used.every((m) => mods.has(m)) || new Set(used).size !== used.length) return null;
  // Shift alone with a letter is just typing; it needs Ctrl, Alt or the Windows key too.
  if (!used.some((m) => m !== 'Shift')) return null;
  if (!/^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|Backspace|[`\-=\[\]\\;',./])$/.test(key)) return null;
  return [...['Ctrl', 'Alt', 'Shift', 'Super'].filter((m) => used.includes(m)), key].join('+');
}

function cleanAddress(v) {
  try { return typeof v === 'string' && v ? normalizeAddress(v) : undefined; } catch { return undefined; }
}

function cleanWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const width = num(w.width, 0, 200, 20000);
  const height = num(w.height, 0, 200, 20000);
  if (!width || !height) return null;
  const out = { width: Math.round(width), height: Math.round(height), maximized: bool(w.maximized, false) };
  if (Number.isFinite(w.x) && Number.isFinite(w.y)) { out.x = Math.round(w.x); out.y = Math.round(w.y); }
  return out;
}

/** The settings as the app will use them, whatever was in the file. */
function cleanSettings(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const n = r.notifications && typeof r.notifications === 'object' ? r.notifications : {};
  const d = r.downloads && typeof r.downloads === 'object' ? r.downloads : {};
  const q = r.quickChat && typeof r.quickChat === 'object' ? r.quickChat : {};
  const u = r.updates && typeof r.updates === 'object' ? r.updates : {};
  const t = r.talk && typeof r.talk === 'object' ? r.talk : {};
  const shortcut = cleanShortcut(q.shortcut);
  const talkShortcut = cleanShortcut(t.shortcut);
  const recent = Array.isArray(r.recentAddresses) ? [...new Set(r.recentAddresses.map(cleanAddress).filter(Boolean))].slice(0, 5) : [];
  return {
    address: cleanAddress(r.address),
    recentAddresses: recent,
    theme: r.theme === 'light' || r.theme === 'dark' ? r.theme : undefined,
    window: cleanWindow(r.window),
    zoom: num(r.zoom, 1, 0.5, 3),
    alwaysOnTop: bool(r.alwaysOnTop, false),
    closeToTray: bool(r.closeToTray, true),
    startAtLogin: typeof r.startAtLogin === 'boolean' ? r.startAtLogin : null,
    trayHintShown: bool(r.trayHintShown, false),
    hardwareAcceleration: bool(r.hardwareAcceleration, true),
    spellcheck: bool(r.spellcheck, true),
    notifications: {
      enabled: bool(n.enabled, true),
      sound: bool(n.sound, true),
      pausedUntil: num(n.pausedUntil, 0, 0, 8.64e15),
      flash: bool(n.flash, true),
      badge: bool(n.badge, true),
    },
    downloads: { ask: bool(d.ask, true), folder: str(d.folder, '', 1000) },
    quickChat: {
      shortcut: shortcut === null ? DEFAULTS.quickChat.shortcut : shortcut,
      lastBot: /^[A-Za-z0-9_-]{1,80}$/.test(q.lastBot ?? '') ? q.lastBot : '',
      enabled: bool(q.enabled, true),
    },
    talk: { shortcut: talkShortcut === null ? DEFAULTS.talk.shortcut : talkShortcut, enabled: bool(t.enabled, true) },
    updates: { auto: bool(u.auto, true), lastCheck: num(u.lastCheck, 0, 0, 8.64e15), skipped: /^\d+\.\d+\.\d+$/.test(u.skipped ?? '') ? u.skipped : '' },
  };
}

/** The settings a local page may change, and what each may be set to. Returns the cleaned patch or throws. */
function cleanPatch(key, value) {
  switch (key) {
    case 'closeToTray': case 'hardwareAcceleration': case 'spellcheck': case 'alwaysOnTop':
      if (typeof value !== 'boolean') break;
      return { [key]: value };
    case 'notifications.enabled': case 'notifications.sound': case 'notifications.flash': case 'notifications.badge':
      if (typeof value !== 'boolean') break;
      return { notifications: { [key.split('.')[1]]: value } };
    case 'notifications.pausedUntil':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) break;
      return { notifications: { pausedUntil: value } };
    case 'downloads.ask': case 'updates.auto': case 'quickChat.enabled': case 'talk.enabled':
      if (typeof value !== 'boolean') break;
      return { [key.split('.')[0]]: { [key.split('.')[1]]: value } };
    case 'quickChat.shortcut': {
      const s = cleanShortcut(value);
      if (s === null) throw new Error('Use Ctrl, Alt or the Windows key with one more key, such as Alt+Shift+Y.');
      return { quickChat: { shortcut: s } };
    }
    case 'talk.shortcut': {
      const s = cleanShortcut(value);
      if (s === null) throw new Error('Use Ctrl, Alt or the Windows key with one more key, such as Alt+Shift+L.');
      return { talk: { shortcut: s } };
    }
    default:
  }
  throw new Error('That setting cannot be changed here.');
}

/** One level of merging is all the settings need (notifications, downloads, quickChat, updates). */
function mergeSettings(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? { ...base[k], ...v } : v;
  }
  return out;
}

/** True while notifications are paused on this PC (the tray's "Pause notifications"). */
function notificationsPaused(settings, now = Date.now()) {
  return !settings.notifications.enabled || settings.notifications.pausedUntil > now;
}

/** When "until tomorrow morning" ends: the next 8:00 on this PC's clock. */
function tomorrowMorning(now = new Date()) {
  const t = new Date(now);
  t.setHours(8, 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t.getTime();
}

module.exports = { DEFAULTS, cleanSettings, cleanPatch, cleanShortcut, mergeSettings, notificationsPaused, tomorrowMorning };
