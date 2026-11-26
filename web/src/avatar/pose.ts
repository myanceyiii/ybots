import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { poseFor, type AvatarPose, type PoseInput } from '@shared/avatar-poses';
import { useStore } from '../store';
import { useVoice } from '../voice/call';

/** Bots that just got a new look celebrate for a moment. */
const useCelebrations = create<Record<string, number>>(() => ({}));
export function celebrate(botId: string, ms = 6000) {
  useCelebrations.setState({ [botId]: Date.now() + ms });
}

const DONE_MS = 8_000;

/** The last row of a bot's conversation is an error notice (the turn that just ended went wrong). */
function endedBadly(botId: string): boolean {
  const t = useStore.getState().transcripts[botId];
  if (!t) return false;
  let last = -1;
  for (const k in t.bySeq) if (+k > last) last = +k;
  const b = t.bySeq[last]?.body;
  return !!b && b.type === 'notice' && b.tone === 'error';
}

/**
 * The pose a bot should show now (avatar-poses.ts): from its voice call, its live state, a turn that
 * just ended, and a new look just chosen. Undefined when `botId` is not given.
 */
export function useBotPose(botId: string | undefined, lastActivityAt?: number): AvatarPose | undefined {
  const live = useStore((s) => (botId ? s.live[botId] : undefined));
  const voice = useVoice((v) => {
    if (!botId || v.botId !== botId) return null;
    if (v.status === 'connecting') return 'connecting';
    if (v.status !== 'live') return null;
    return v.speaking ? 'speaking' : v.listening ? 'listening' : v.working.length ? 'working' : v.thinking ? 'thinking' : 'listening';
  });
  const celebrateUntil = useCelebrations((c) => (botId ? c[botId] ?? null : null));
  const [finished, setFinished] = useState<{ at: number; failed: boolean } | null>(null);
  const [, tick] = useState(0);
  const wasRunning = useRef(false);

  const running = !!live?.isRunning;
  useEffect(() => {
    if (!botId) return;
    if (wasRunning.current && !running) setFinished({ at: Date.now(), failed: endedBadly(botId) });
    wasRunning.current = running;
  }, [botId, running]);

  // Re-render when a timed pose (done, celebrating) runs out.
  const now = Date.now();
  const until = Math.max(finished ? finished.at + DONE_MS : 0, celebrateUntil ?? 0);
  useEffect(() => {
    if (until <= now) return;
    const t = setTimeout(() => tick((n) => n + 1), until - now + 20);
    return () => clearTimeout(t);
  }, [until, now]);

  if (!botId) return undefined;
  const input: PoseInput = {
    now,
    voice,
    running,
    activity: live?.activity?.kind ?? null,
    awaiting: !!live?.awaiting,
    finishedAt: finished?.at ?? null,
    failed: finished?.failed,
    celebrateUntil,
    lastActivityAt: lastActivityAt ?? null,
  };
  return poseFor(input);
}
