'use strict';
// The rules the window follows, kept free of Electron so they can be tested on their own.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Turns what the person typed into the YBots origin, or throws with a sentence they can read.
 * HTTPS only (a tailnet name or the Cloudflare-protected address); plain HTTP only on this computer,
 * for testing. No user name, password, path or query is kept.
 */
function normalizeAddress(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new Error('Type the address of your YBots.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That does not look like a web address.');
  }
  if (url.username || url.password) throw new Error('Leave the user name and password out of the address.');
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The address has to start with https://.');
  }
  if (!loopback && !url.hostname.includes('.')) throw new Error('Use the full name, such as cleft.example.ts.net.');
  return url.origin;
}

function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The address to open for a one-time sign-in link (from "Sign in another device", the QR pairing or
 * scripts/sign-in-link.sh), or null if it isn't one. The link may name another host for the same
 * YBots (the server prints its tailnet name even when this app uses the Cloudflare address), so
 * only its path is kept and it is always opened on this app's own address.
 */
function signInUrl(link, origin) {
  let url;
  try {
    url = new URL(String(link ?? '').trim());
  } catch {
    return null;
  }
  if (!origin || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search) return null;
  if (!/^\/api\/auth\/link\/[A-Za-z0-9_-]{16,}$/.test(url.pathname)) return null;
  return origin + url.pathname;
}

/** Cloudflare Access sign-in pages, which sit in front of a YBots published through Cloudflare. */
function isAccessLogin(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname.endsWith('.cloudflareaccess.com'));
  } catch {
    return false;
  }
}

/**
 * True when a request from the app failed only because the server answered with a redirect. The
 * YBots server never redirects its API calls, so this is Cloudflare Access sending a window that
 * has not been through its sign-in yet to the Access login page. Electron's fetch rejects such a
 * request ("Redirect was cancelled") instead of returning the 302, which used to read as
 * "Couldn't reach".
 */
function isRedirectError(err) {
  return /redirect/i.test(String(err?.message ?? err ?? ''));
}

/**
 * Where a navigation in the window may go: 'allow' keeps it in the window (our origin, or the
 * Cloudflare Access sign-in in front of it), 'external' hands an ordinary web link to the default
 * browser, 'deny' drops anything else (file:, javascript:, custom schemes).
 */
function navigationDecision(url, origin) {
  if (sameOrigin(url, origin) || isAccessLogin(url)) return 'allow';
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:' ? 'external' : 'deny';
  } catch {
    return 'deny';
  }
}

/**
 * Which browser permissions a page gets: the microphone (calls), notifications and the clipboard
 * (Paste and Copy on a bot's or PC's screen, read only when the person presses them), for our origin
 * only. Camera, screen capture, location and everything else are refused, as is any request from
 * another origin.
 */
function permissionAllowed(permission, requestingUrl, origin, details = {}) {
  if (!origin || !sameOrigin(requestingUrl, origin)) return false;
  if (permission === 'notifications' || permission === 'clipboard-sanitized-write' || permission === 'clipboard-read') return true;
  if (permission === 'media') {
    const types = details.mediaTypes ?? [];
    // A check (not a request) has no mediaTypes but names the kind in mediaType.
    if (details.mediaType) return details.mediaType === 'audio';
    return types.length > 0 && types.every((t) => t === 'audio');
  }
  return false;
}

/**
 * What a failed page load most likely means, in words a person can act on. `code` is Chromium's error
 * number and `description` its name (ERR_NAME_NOT_RESOLVED and so on); `status` is set instead when the
 * address did answer, but with an error page (a proxy in front of a server that is down).
 */
function offlineHint({ code, description, status, address } = {}) {
  const name = String(description ?? '');
  let tailnet = false;
  try { tailnet = new URL(address).hostname.endsWith('.ts.net'); } catch { /* no address */ }
  if (status) {
    if (status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530)) return { title: 'YBots is restarting or switched off', hint: `The address answered, but the YBots server behind it did not (error ${status}). It usually comes back within a minute.`, retry: true };
    return { title: 'YBots answered with an error', hint: `The server answered with error ${status}.`, retry: true };
  }
  if (name === 'crashed') return { title: 'The page stopped working', hint: 'The window ran into a problem and could not recover by itself.', retry: false };
  if (/INTERNET_DISCONNECTED|NETWORK_CHANGED|ADDRESS_UNREACHABLE|NETWORK_ACCESS_DENIED/.test(name) || code === -106) return { title: 'This PC is offline', hint: 'There is no network connection. YBots opens by itself when the connection is back.', retry: true };
  if (/NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED/.test(name) || code === -105 || code === -137) return { title: "Can't find YBots", hint: tailnet ? 'That name is only known while Tailscale is on. Turn Tailscale on and sign in to it, and YBots opens by itself.' : 'The address could not be found. Check that it is typed correctly and that this PC is online.', retry: true };
  if (/CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE/.test(name)) return { title: 'YBots is not answering', hint: 'The computer that runs YBots was found, but the YBots server on it is not running or is restarting.', retry: true };
  if (/TIMED_OUT|CONNECTION_FAILED/.test(name)) return { title: 'YBots took too long to answer', hint: tailnet ? 'Check that Tailscale is on here and that the computer that runs YBots is switched on.' : 'Check that the computer that runs YBots is switched on and online.', retry: true };
  if (/CERT_|SSL_|INSECURE/.test(name)) return { title: 'The connection is not secure', hint: "The address's security certificate was not accepted, so nothing was sent. Check this PC's date and time, and the address.", retry: false };
  return { title: "Can't reach YBots", hint: 'YBots did not answer.', retry: true };
}

/** How long the offline page waits before it tries again by itself: 5 s, 10 s, 20 s, then every 30 s. */
function retryDelay(attempt) {
  return [5, 10, 20][Math.max(0, attempt)] ?? 30;
}

/**
 * What the app was started (or started again) to do, from its command line: "--hidden" (started by
 * Windows at sign-in), "--quick-chat", "--settings", or a link such as yanceybot://chat/<bot id>.
 * Anything else is ignored; a link can only open a place in the app, never do something there.
 */
function parseLaunch(argv) {
  const out = { hidden: false, action: null, botId: null };
  for (const a of Array.isArray(argv) ? argv.slice(1) : []) {
    if (typeof a !== 'string') continue;
    if (a === '--hidden') out.hidden = true;
    else if (a === '--quick-chat') out.action = 'quick';
    else if (a === '--settings') out.action = 'settings';
    else if (a === '--screenshot') out.action = 'screenshot';
    else if (/^yanceybot:/i.test(a)) {
      const m = /^yanceybot:\/\/(chat\/([A-Za-z0-9_-]{1,80})|quick|screenshot|settings|open)\/?$/i.exec(a);
      if (!m) continue;
      if (m[2]) { out.action = 'chat'; out.botId = m[2]; }
      else out.action = m[1].toLowerCase();
    }
  }
  return out;
}

/** A file name that is free in a folder: "report.pdf", then "report (1).pdf", "report (2).pdf"... */
function freeName(name, taken) {
  const clean = String(name || 'file').replace(/[\\/:*?"<>|\0-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 180) || 'file';
  if (!taken(clean)) return clean;
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const next = `${stem} (${i})${ext}`;
    if (!taken(next)) return next;
  }
  return `${stem} (${Date.now()})${ext}`;
}

module.exports = { normalizeAddress, signInUrl, isAccessLogin, isRedirectError, navigationDecision, permissionAllowed, sameOrigin, offlineHint, retryDelay, parseLaunch, freeName };
