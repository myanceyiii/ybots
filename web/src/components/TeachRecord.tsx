import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, TeachState } from '@shared/types';
import { configApi } from '../lib/configApi';
import { useStore } from '../store';
import { Icon } from './Icon';

/** How often the app asks for the step count while a recording runs or is being written up. */
const POLL_MS = 1500;

/**
 * The bot's Teach a bot state (server/src/teach.ts), kept fresh while a recording runs or its skill is being
 * written. `refresh` asks again now.
 */
export function useTeach(botId: string | undefined, on = true) {
  const [state, setState] = useState<TeachState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    if (!botId) return;
    try { const s = await configApi.teach(botId); if (alive.current) { setState(s); setError(null); } } catch (e) { if (alive.current) setError((e as Error).message); }
  }, [botId]);
  useEffect(() => { alive.current = true; if (on) void refresh(); return () => { alive.current = false; }; }, [refresh, on]);
  const status = state?.recording?.status;
  useEffect(() => {
    if (!on || (status !== 'recording' && status !== 'drafting')) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [on, status, refresh]);
  return { state, setState, error, setError, refresh };
}

/**
 * Record / Stop beside Hand back while the person drives a bot's screen. Record starts capturing what they do in
 * the bot's browser; Stop has the bot write it up as a skill and opens the review.
 */
export function TeachRecordButton({ bot, compact = false }: { bot: Bot; compact?: boolean }) {
  const { state, setState, error, setError } = useTeach(bot.id);
  const set = useStore((s) => s.set);
  const [busy, setBusy] = useState(false);
  const rec = state?.recording;
  const recording = rec?.status === 'recording';
  if (!state || state.blocked) return null;

  const start = async () => {
    setBusy(true);
    try { setState(await configApi.teachStart(bot.id)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true);
    try { setState(await configApi.teachStop(bot.id)); set({ teachReview: bot.id }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const n = rec?.steps.length ?? 0;
  return (
    <>
      {error && <span className="teach-rec__error" role="alert" title={error}>{compact ? 'Couldn’t record' : error}</span>}
      {recording ? (
        <button type="button" className="teach-rec is-on" onClick={stop} disabled={busy} aria-label={`Stop recording (${n} ${n === 1 ? 'step' : 'steps'})`} title="Stop, then review the skill">
          <i className="teach-rec__dot" aria-hidden />
          <span>Stop{compact ? '' : ' recording'} · {n}</span>
        </button>
      ) : (
        <button type="button" className="teach-rec" onClick={start} disabled={busy}
          title={`Record what you do in ${bot.name}’s browser, and ${bot.name} writes it up as a skill`}>
          <Icon name="record" size={14} />
          <span>{busy ? 'Starting…' : 'Record'}</span>
        </button>
      )}
    </>
  );
}
