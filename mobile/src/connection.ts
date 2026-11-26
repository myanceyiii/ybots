/**
 * Whether the phone can reach the server right now, for the banner under the status bar and for the
 * catch-up polling in App.tsx. Two signals feed it: the live event stream (open, or down since when) and
 * plain requests (the last one that worked and the last one that could not reach the server at all).
 *
 * - ok: the stream is open.
 * - connecting: the stream is not open yet, or dropped a moment ago (no banner for a short blip).
 * - reconnecting: the stream has been down for a few seconds, but requests still get through or none was tried.
 * - offline: the stream is down and the newest request could not reach the server either.
 * - updating: the server said it is restarting for an update; it is back within a minute or so.
 */
import { useEffect, useState } from 'react';

export type Connection = 'ok' | 'connecting' | 'reconnecting' | 'offline' | 'updating';

/** The server gives itself this long to come back after saying it is restarting. */
const UPDATE_MS = 90_000;
let updatingUntil = 0;
/** The server said it is about to stop for an update (the `restarting` event). */
export function serverRestarting() { updatingUntil = Date.now() + UPDATE_MS; streamOpen = false; downSince = Date.now(); tell(); }
export const serverUpdating = (now = Date.now()) => now < updatingUntil;

/** A dropped stream shows no banner for this long: most drops (a network switch) heal themselves. */
const GRACE_MS = 5000;

let streamOpen = false;
let downSince = Date.now();
let lastData = 0;
let lastOk = 0;
let lastFail = 0;
const listeners = new Set<() => void>();
const kicks = new Set<() => void>();
const tell = () => { for (const fn of listeners) fn(); };

export function streamOpened() { lastData = Date.now(); updatingUntil = 0; if (!streamOpen) { streamOpen = true; tell(); } }
export function streamData() { lastData = Date.now(); if (!streamOpen) { streamOpen = true; tell(); } }
export function streamDown() { if (streamOpen) { streamOpen = false; downSince = Date.now(); tell(); } }
/** A new sign-in (or sign-out): nothing is known yet. */
export function resetConnection() { streamOpen = false; downSince = Date.now(); lastData = 0; lastOk = 0; lastFail = 0; updatingUntil = 0; tell(); }
export function requestOk() { const was = lastFail > lastOk; lastOk = Date.now(); if (was) tell(); }
export function requestFailed() { const was = lastFail > lastOk; lastFail = Date.now(); if (!was) tell(); }

export function connectionNow(now = Date.now()): Connection {
  if (streamOpen) return 'ok';
  if (now < updatingUntil) return 'updating';
  if (now - downSince < GRACE_MS) return 'connecting';
  return lastFail > lastOk ? 'offline' : 'reconnecting';
}

/** True while the stream is open and has said something lately (the server pings every 20 s). */
export const streamHealthy = (now = Date.now()) => streamOpen && now - lastData < 30_000;

/** "Try now" on the banner: every open stream reconnects at once instead of waiting for its timer. */
export function onKick(fn: () => void) { kicks.add(fn); return () => { kicks.delete(fn); }; }
export function kickConnection() { for (const fn of kicks) { try { fn(); } catch { /* ignore */ } } }

/** The connection state, kept up to date (it also changes with time alone, when the grace period ends). */
export function useConnection(): Connection {
  const [state, setState] = useState<Connection>(connectionNow());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const next = connectionNow();
      setState(next);
      clearTimeout(timer);
      if (next === 'updating') timer = setTimeout(read, Math.max(50, updatingUntil - Date.now() + 30));
      else if (next === 'connecting') timer = setTimeout(read, Math.max(50, GRACE_MS - (Date.now() - downSince) + 30));
    };
    listeners.add(read);
    read();
    return () => { listeners.delete(read); clearTimeout(timer); };
  }, []);
  return state;
}
