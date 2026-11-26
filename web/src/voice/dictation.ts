// Composer dictation: hold the mic to talk (or tap to start, tap again to stop). The words appear in
// the message box as you speak: streamed to the server's live speech-to-text service when it is up,
// otherwise worked out about once a second (liveEngine.ts). Nothing is sent until you press Send.
import { useCallback, useEffect, useRef, useState } from 'react';
import { voiceApi } from './api';
import { createAudioContext, MicCapture, micErrorMessage, openMic, pcmToWav } from './audio';
import { rmsOf, type LiveText } from './liveDictation';
import { LiveEngine } from './liveEngine';

/** Dictation audio: 16 kHz, what the speech services want. */
const DICT_RATE = 16000;

export type DictationState = 'idle' | 'recording' | 'transcribing';

const HOLD_MS = 350;
const MAX_MS = 120_000;

interface Rec {
  ctx: AudioContext;
  mic: MicCapture;
  frames: Int16Array[];
  live: LiveEngine;
  downAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * onStart: dictation began (remember where the words go).
 * onLive: the words so far; `done` once dictation has ended (then `text` is final, possibly empty).
 */
export function useDictation(handlers: { onStart: () => void; onLive: (text: LiveText, done: boolean) => void; onError: (msg: string) => void }, language?: string) {
  const [state, setState] = useState<DictationState>('idle');
  const rec = useRef<Rec | null>(null);
  const starting = useRef(false);
  const toggleMode = useRef(false);
  const cb = useRef({ ...handlers, language });
  cb.current = { ...handlers, language };

  const finish = useCallback(async (cancel = false) => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    toggleMode.current = false;
    clearTimeout(r.timer);
    r.mic.stop();
    void r.ctx.close().catch(() => {});
    if (cancel || Date.now() - r.downAt < 250) {
      r.live.cancel();
      cb.current.onLive({ settled: '', pending: '' }, true);
      setState('idle');
      return;
    }
    setState('transcribing');
    try {
      const { text, error } = await r.live.finish();
      cb.current.onLive({ settled: text, pending: '' }, true);
      if (error && !text) cb.current.onError(error);
    } finally {
      setState('idle');
    }
  }, []);

  const begin = useCallback(async () => {
    if (rec.current || starting.current) return;
    if (typeof AudioWorkletNode === 'undefined') { cb.current.onError('Dictation isn’t supported in this browser.'); return; }
    starting.current = true;
    const downAt = Date.now();
    // Made in the click so the browser lets it run.
    const ctx = createAudioContext();
    try {
      const stream = await openMic();
      const frames: Int16Array[] = [];
      const clip = (from: number, to: number) => {
        const part = frames.slice(from, to);
        const pcm = new Int16Array(part.reduce((n, f) => n + f.length, 0));
        let o = 0;
        for (const f of part) { pcm.set(f, o); o += f.length; }
        return voiceApi.transcribe(pcmToWav(pcm, DICT_RATE), cb.current.language);
      };
      const opts = await voiceApi.options().catch(() => null);
      const socketUrl = opts?.live ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/voice/live` : null;
      const live = new LiveEngine({ socketUrl, clip, onText: (t) => cb.current.onLive(t, false) });
      const mic = new MicCapture(ctx, stream, (pcm) => { frames.push(pcm); live.push(pcm, [rmsOf(pcm)]); }, DICT_RATE);
      await mic.start();
      rec.current = { ctx, mic, frames, live, downAt, timer: setTimeout(() => { void finish(); }, MAX_MS) };
      cb.current.onStart();
      setState('recording');
    } catch (e) {
      void ctx.close().catch(() => {});
      cb.current.onError(micErrorMessage(e));
      setState('idle');
    } finally {
      starting.current = false;
    }
  }, [finish]);

  // Pointer handlers: press-and-hold records until release; a quick tap toggles recording on, tap again stops.
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (rec.current && toggleMode.current) { void finish(); return; }
    void begin();
  }, [begin, finish]);

  const onPointerUp = useCallback(() => {
    const r = rec.current;
    if (!r) {
      // Still waiting on the permission prompt: treat as a tap.
      if (starting.current) toggleMode.current = true;
      return;
    }
    if (toggleMode.current) return;
    if (Date.now() - r.downAt < HOLD_MS) toggleMode.current = true; // tap: keep recording
    else void finish();
  }, [finish]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (rec.current) void finish();
    else { toggleMode.current = true; void begin(); }
  }, [begin, finish]);

  // Esc cancels; unmount stops.
  useEffect(() => {
    if (state !== 'recording') return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') void finish(true); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [state, finish]);
  useEffect(() => () => { void finish(true); }, [finish]);

  /** Microphone level 0..1 right now, for the wave beside the mic. */
  const level = useCallback(() => rec.current?.mic.level ?? 0, []);

  /** Starts dictating (tap mode: it runs until the mic is tapped again), as Try again does. */
  const start = useCallback(() => { if (rec.current) return; toggleMode.current = true; void begin(); }, [begin]);

  return { state, level, onPointerDown, onPointerUp, onKeyDown, start, cancel: () => { void finish(true); } };
}
