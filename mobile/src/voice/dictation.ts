// Dictation in the composer, as on the web (web/src/voice/dictation.ts): tap the mic to start and tap
// again to stop, or hold it and let go. The words appear in the message box as you speak: streamed to
// the server's live speech-to-text service when it is up, otherwise worked out about once a second
// through POST /api/voice/stt (liveEngine.ts). Nothing is sent until you press Send.
import { useCallback, useEffect, useRef, useState } from 'react';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import type { Client } from '../api';
import { nativeReason, voiceNative } from '../../modules/cleft-voice/src';
import { getCall, isCallActive } from './call';
import { toByteArray } from 'base64-js';
import type { LiveText } from './liveDictation';
import { LiveEngine } from './liveEngine';
import { postRecording, UploadError, type Uploaded } from './upload';

export type DictationState = 'idle' | 'recording' | 'transcribing';

const HOLD_MS = 350;
const MAX_MS = 120_000;
const POLL_MS = 200;

/** One recording on the phone, written down by the server's speech service (also the assistant card's chunked way). */
export async function transcribe(api: Client, path: string, language?: string): Promise<string> {
  let res: Uploaded;
  try {
    res = await postRecording(api, '/api/voice/stt', path, 'dictation.wav', { language });
  } catch (e) {
    throw new Error(e instanceof UploadError && e.kind === 'file' ? "The phone couldn't read the recording." : "Couldn't reach the server, so nothing was written down.");
  }
  const j = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(j.error || `The speech server answered with an error (${res.status}).`);
  return j.text ?? '';
}

/**
 * onStart: dictation began (remember what the box held).
 * onLive: the words so far; `done` once dictation has ended (then the text is final, possibly empty).
 */
export function useDictation(api: Client, handlers: { onStart: () => void; onLive: (text: LiveText, done: boolean) => void; onError: (msg: string) => void }, language?: string) {
  const [state, setState] = useState<DictationState>('idle');
  const rec = useRef<{ downAt: number; timer: ReturnType<typeof setTimeout>; poll: ReturnType<typeof setInterval> | null; live: LiveEngine | null } | null>(null);
  const starting = useRef(false);
  const toggleMode = useRef(false);
  const pump = useRef<(() => void) | null>(null);
  const cb = useRef({ ...handlers, language });
  cb.current = { ...handlers, language };

  const finish = useCallback(async (cancel = false) => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    toggleMode.current = false;
    clearTimeout(r.timer);
    // Take the last frames before the microphone closes.
    if (r.poll) { clearInterval(r.poll); pump.current?.(); }
    const short = Date.now() - r.downAt < 250;
    if (r.live) {
      if (cancel || short) {
        r.live.cancel();
        let path: string | null = null;
        try { path = voiceNative.stop(); } catch { /* already stopped */ }
        if (path) voiceNative.discard(path);
        cb.current.onLive({ settled: '', pending: '' }, true);
        setState('idle');
        return;
      }
      setState('transcribing');
      try {
        // The last stretch is clipped while the recording is still open, then it is closed.
        const { text, error } = await r.live.finish();
        cb.current.onLive({ settled: text, pending: '' }, true);
        if (error && !text) cb.current.onError(error);
      } finally {
        let path: string | null = null;
        try { path = voiceNative.stop(); } catch { /* already stopped */ }
        if (path) voiceNative.discard(path);
        setState('idle');
      }
      return;
    }
    // An app build without live text: transcribe the whole recording at the end.
    let path: string | null = null;
    try { path = voiceNative.stop(); } catch { /* already stopped */ }
    if (cancel || !path || short) { if (path) voiceNative.discard(path); cb.current.onLive({ settled: '', pending: '' }, true); setState('idle'); return; }
    setState('transcribing');
    try {
      cb.current.onLive({ settled: await transcribe(api, path, cb.current.language), pending: '' }, true);
    } catch (e) {
      cb.current.onLive({ settled: '', pending: '' }, true);
      cb.current.onError((e as Error).message || 'Transcription failed');
    } finally {
      voiceNative.discard(path);
      setState('idle');
    }
  }, [api]);

  const begin = useCallback(async () => {
    if (rec.current || starting.current) return;
    if (!voiceNative.available) { cb.current.onError('Dictation only works in the Android app.'); return; }
    if (isCallActive(getCall())) { cb.current.onError('You are on a voice call. Hang up to dictate.'); return; }
    starting.current = true;
    const downAt = Date.now();
    try {
      const p = await requestRecordingPermissionsAsync().catch(() => null);
      if (p && !p.granted) { cb.current.onError('Microphone access is off for this app. Allow it in Android settings to dictate.'); return; }
      voiceNative.start('dictate');
      let live: LiveEngine | null = null;
      let poll: ReturnType<typeof setInterval> | null = null;
      if (voiceNative.liveDictation) {
        const clip = async (from: number, to: number) => {
          const path = voiceNative.dictationClip(from, to);
          if (!path) return '';
          try { return await transcribe(api, path, cb.current.language); } finally { voiceNative.discard(path); }
        };
        const opts = voiceNative.liveStream ? await api.voiceOptions().catch(() => null) : null;
        const sock = opts?.live ? api.liveSocket() : null;
        // React Native's WebSocket takes headers as a third argument (not in the DOM typings).
        const WS = WebSocket as unknown as new (url: string, protocols: string[] | undefined, o: { headers: Record<string, string> }) => WebSocket;
        const l = new LiveEngine({ socketUrl: sock?.url ?? null, openSocket: (u) => new WS(u, undefined, { headers: sock!.headers }), clip, onText: (t) => cb.current.onLive(t, false) });
        live = l;
        let seen = 0;
        // Every 200 ms: the loudness of each new 40 ms frame, and (streaming) its audio.
        pump.current = () => {
          try {
            const levels = voiceNative.dictationLevels(seen);
            if (!levels.length) return;
            const b64 = l.mode === 'live' ? voiceNative.dictationPcm(seen) : '';
            seen += levels.length;
            const bytes = b64 ? toByteArray(b64) : null;
            l.push(bytes ? new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2)) : null, levels);
          } catch { /* stopped */ }
        };
        poll = setInterval(() => pump.current?.(), POLL_MS);
      }
      rec.current = { downAt, timer: setTimeout(() => { void finish(); }, MAX_MS), poll, live };
      cb.current.onStart();
      setState('recording');
    } catch (e) {
      cb.current.onError(nativeReason(e, 'Could not open the microphone.'));
      setState('idle');
    } finally {
      starting.current = false;
    }
  }, [api, finish]);

  // Press and hold records until you let go; a quick tap keeps recording until the next tap.
  const onPressIn = useCallback(() => {
    if (rec.current && toggleMode.current) { void finish(); return; }
    void begin();
  }, [begin, finish]);

  const onPressOut = useCallback(() => {
    const r = rec.current;
    if (!r) {
      // Still waiting on the permission question: treat it as a tap.
      if (starting.current) toggleMode.current = true;
      return;
    }
    if (toggleMode.current) return;
    if (Date.now() - r.downAt < HOLD_MS) toggleMode.current = true;
    else void finish();
  }, [finish]);

  // Leaving the chat stops (and drops) a recording.
  useEffect(() => () => { void finish(true); }, [finish]);

  /** Microphone level 0..1 right now, for the wave beside the mic. */
  const level = useCallback(() => (rec.current ? voiceNative.levels().mic : 0), []);

  /** Starts dictating (tap mode: it runs until the mic is tapped again), as Try again does. */
  const start = useCallback(() => { if (rec.current) return; toggleMode.current = true; void begin(); }, [begin]);

  return { state, level, onPressIn, onPressOut, start, cancel: () => { void finish(true); } };
}
