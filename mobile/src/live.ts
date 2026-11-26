import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { poseFor, type AvatarPose, type LiveState } from './poses';

// What each bot is doing right now (the server's `live` events), and bots that just got a new look.
let live: Record<string, LiveState> = {};
let celebrations: Record<string, number> = {};
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Called whenever any bot's live state changes. */
export function subscribeLive(l: () => void): () => void { return subscribe(l); }
export function setLive(list: LiveState[]) { live = Object.fromEntries(list.map((s) => [s.botId, s])); notify(); }
export function updateLive(s: LiveState) { live = { ...live, [s.botId]: s }; notify(); }
export function getLive(botId: string): LiveState | undefined { return live[botId]; }
/** What a bot is doing right now, kept up to date. */
export function useLive(botId: string): LiveState | undefined { return useSyncExternalStore(subscribe, () => live[botId]); }
/** Every bot's live state, by bot id, kept up to date. */
export function useAllLive(): Record<string, LiveState> { return useSyncExternalStore(subscribe, () => live); }
export function celebrate(botId: string, ms = 6000) { celebrations = { ...celebrations, [botId]: Date.now() + ms }; notify(); }

/** The pose a bot shows now, or undefined when `botId` is not given. */
export function useBotPose(botId: string | undefined, lastActivityAt?: number): AvatarPose | undefined {
  const s = useSyncExternalStore(subscribe, () => (botId ? live[botId] : undefined));
  const until = useSyncExternalStore(subscribe, () => (botId ? celebrations[botId] ?? 0 : 0));
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [, tick] = useState(0);
  const was = useRef(false);
  const running = !!s?.isRunning;
  useEffect(() => { if (was.current && !running) setFinishedAt(Date.now()); was.current = running; }, [running]);
  const now = Date.now();
  const next = Math.max(finishedAt ? finishedAt + 8_000 : 0, until);
  useEffect(() => {
    if (next <= now) return;
    const t = setTimeout(() => tick((n) => n + 1), next - now + 20);
    return () => clearTimeout(t);
  }, [next, now]);
  if (!botId) return undefined;
  return poseFor({ now, running, activity: s?.activity?.kind ?? null, awaiting: !!s?.awaiting, finishedAt, celebrateUntil: until || null, lastActivityAt: lastActivityAt ?? null });
}
