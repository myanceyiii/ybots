import type { ServerEvent } from '@shared/types';
import { useStore } from '../store';

/** The web app's own entry script, as the page loaded it: what the server's `hello` is compared with. */
const ownBuild = (): string | null => {
  for (const s of Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))) {
    const m = /\/assets\/(index-[\w-]+\.js)/.exec(s.src);
    if (m) return m[1];
  }
  return null;
};

/**
 * One EventSource for the whole app.
 *
 * EventSource retries on its own, but a server restart can leave it CLOSED, and a connection that died
 * without saying so (a laptop waking, a proxy dropping the stream) stays "open" and silent for good. So:
 *  - a closed stream is reopened here, with backoff;
 *  - the server sends something at least every 20 s, and 45 s of silence replaces the stream;
 *  - coming back online or to the tab checks at once;
 *  - the server says when it stops for an update (`restarting`): the app then looks for it every second.
 * Every event carries a number. A reconnect sends the last one seen and the server sends what was missed
 * (`hello.resumed`), so a short drop loses nothing and fetches nothing; only when that is not possible
 * (away too long, or the server restarted) is everything fetched afresh.
 */
export function startEvents(): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let retry = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let everConnected = false;
  let lastId = '';
  let lastData = Date.now();
  let restartUntil = 0;
  const mine = ownBuild();

  const resync = () => {
    const st = useStore.getState();
    st.loadBots().catch(() => {});
    st.loadComputer().catch(() => {});
    if (st.selectedBotId) { st.loadRows(st.selectedBotId).catch(() => {}); st.loadRoutines(st.selectedBotId).catch(() => {}); }
  };

  const open = () => {
    if (stopped) return;
    clearTimeout(timer);
    es?.close();
    lastData = Date.now();
    const src = new EventSource(`/api/events${lastId ? `?after=${encodeURIComponent(lastId)}` : ''}`, { withCredentials: true });
    es = src;
    src.onopen = () => {
      if (es !== src) return;
      retry = 1000;
      lastData = Date.now();
      useStore.getState().set({ sseConnected: true });
    };
    src.onmessage = (m) => {
      if (es !== src) return;
      lastData = Date.now();
      if (m.lastEventId) lastId = m.lastEventId;
      let ev: ServerEvent;
      try { ev = JSON.parse(m.data) as ServerEvent; } catch (e) { console.warn('bad event', e); return; }
      if (ev.type === 'restarting') {
        // The server is stopping for an update: say so, and look for the new one every second for a while
        // instead of backing off as for a lost connection.
        restartUntil = Date.now() + 90_000;
        useStore.getState().set({ restarting: true });
        return;
      }
      if (ev.type === 'hello') {
        restartUntil = 0;
        if (useStore.getState().restarting) useStore.getState().set({ restarting: false });
        // The first hello needs nothing (the app has just loaded everything); later ones fetch afresh
        // unless the server is sending exactly what was missed.
        if (everConnected && !ev.resumed) resync();
        everConnected = true;
        if (mine && ev.web && ev.web !== mine) useStore.getState().set({ updateReady: true });
      }
      try { useStore.getState().handleEvent(ev); } catch (e) { console.warn('bad event', e); }
    };
    src.onerror = () => {
      if (es !== src) return;
      useStore.getState().set({ sseConnected: false });
      if (src.readyState === EventSource.CLOSED) {
        es = null;
        const quick = Date.now() < restartUntil;
        timer = setTimeout(open, quick ? 1000 : retry);
        if (!quick) {
          retry = Math.min(retry * 2, 15_000);
          if (useStore.getState().restarting) useStore.getState().set({ restarting: false });
        }
      }
    };
  };
  open();

  // A stream that has gone quiet is dead even if the browser still calls it open.
  const watchdog = setInterval(() => {
    if (stopped || !es || Date.now() - lastData < 45_000) return;
    useStore.getState().set({ sseConnected: false });
    open();
  }, 10_000);
  // Back online, or back to the tab after a while: do not wait out the backoff or the watchdog.
  const kick = () => {
    if (stopped || document.visibilityState === 'hidden') return;
    if (!es || es.readyState === EventSource.CLOSED || Date.now() - lastData > 30_000) { retry = 1000; open(); }
  };
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', kick);

  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(watchdog);
    window.removeEventListener('online', kick);
    document.removeEventListener('visibilitychange', kick);
    es?.close();
  };
}
