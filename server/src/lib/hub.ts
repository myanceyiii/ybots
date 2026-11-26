import type { ServerEvent } from '../types.js';

type Listener = (ev: ServerEvent, id: number) => void;

/** How much of an account's recent events is kept for an app that reconnects: by count and by age. */
const KEEP = 400;
const KEEP_MS = 3 * 60_000;
/** Told apart from the numbers of an earlier run of the server: an app that reconnects after a restart starts over. */
export const hubBoot = Date.now().toString(36);

/**
 * Per-user fan-out of server events to connected SSE clients.
 *
 * Every event gets a number, and the last few minutes are kept per account, so an app whose connection
 * dropped for a moment (a phone changing networks, a proxy closing the stream) can ask for what it missed
 * (`since`) instead of fetching everything again or, worse, showing a reply that stopped halfway.
 */
class Hub {
  private listeners = new Map<string, Set<Listener>>();
  private seq = 0;
  private recent = new Map<string, { id: number; at: number; ev: ServerEvent }[]>();
  /** The newest event number that is no longer kept, per account: asking for anything at or before it is a gap. */
  private dropped = new Map<string, number>();
  /** Called for every event of every user, whether or not anyone is connected (notify.ts). */
  private taps = new Set<(userId: string, ev: ServerEvent) => void>();

  tap(fn: (userId: string, ev: ServerEvent) => void): () => void {
    this.taps.add(fn);
    return () => { this.taps.delete(fn); };
  }

  subscribe(userId: string, fn: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(userId);
    };
  }

  emit(userId: string, ev: ServerEvent) {
    for (const t of this.taps) {
      try { t(userId, ev); } catch { /* a broken tap never stops delivery */ }
    }
    const id = ++this.seq;
    const at = Date.now();
    let kept = this.recent.get(userId);
    if (!kept) this.recent.set(userId, (kept = []));
    kept.push({ id, at, ev });
    let drop = 0;
    while (drop < kept.length && (kept.length - drop > KEEP || at - kept[drop].at > KEEP_MS)) drop++;
    if (drop) { this.dropped.set(userId, kept[drop - 1].id); kept.splice(0, drop); }
    const set = this.listeners.get(userId);
    if (!set) return;
    for (const fn of set) {
      try { fn(ev, id); } catch { /* ignore broken listener */ }
    }
  }

  /** One event to every account with an app connected (the server saying it is about to restart). */
  broadcast(ev: ServerEvent) {
    for (const userId of [...this.listeners.keys()]) this.emit(userId, ev);
  }

  /** The newest event number so far (0 before the first). */
  lastId(): number { return this.seq; }

  /**
   * The events an account was sent after number `after`, oldest first, or null when some of them are no
   * longer kept (the app was away too long, or `after` is from another run): the app must fetch afresh.
   */
  since(userId: string, after: number): { id: number; ev: ServerEvent }[] | null {
    if (!Number.isFinite(after) || after < 0 || after > this.seq) return null;
    const kept = this.recent.get(userId) ?? [];
    // Kept events can also have aged out without a newer one arriving to trim them.
    const now = Date.now();
    const live = kept.filter((k) => now - k.at <= KEEP_MS);
    const floor = live.length < kept.length ? kept[kept.length - live.length - 1].id : (this.dropped.get(userId) ?? 0);
    if (after < floor) return null;
    return live.filter((k) => k.id > after).map(({ id, ev }) => ({ id, ev }));
  }

  /** How many apps are listening right now, over every account (status.ts). */
  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  isOnline(userId: string) {
    return (this.listeners.get(userId)?.size ?? 0) > 0;
  }
}

export const hub = new Hub();
