import { useCallback, useEffect, useRef, useState } from 'react';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import type { Client } from './api';

/**
 * The play buttons next to each voice in a bot's Voice settings: plays that voice saying a short
 * sample sentence (server/src/voice.ts GET /voice/sample, an MP3 the server makes once and keeps).
 * One sample at a time; tapping the one that is playing stops it.
 */
export function useVoiceSamples(api: Client) {
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<{ player: AudioPlayer; voice: string } | null>(null);

  const stop = useCallback(() => {
    const c = current.current;
    current.current = null;
    setPlaying(null);
    if (c) { try { c.player.pause(); c.player.remove(); } catch { /* already gone */ } }
  }, []);

  const play = useCallback((voice: string, speed = 1) => {
    const same = current.current?.voice === voice;
    stop();
    if (same) return;
    setError(null);
    void setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
    const uri = `${api.server}/api/voice/sample?voice=${encodeURIComponent(voice)}&speed=${speed}`;
    const player = createAudioPlayer({ uri, headers: api.authHeader });
    const mine = { player, voice };
    current.current = mine;
    setPlaying(voice);
    let started = false;
    const giveUp = setTimeout(() => {
      if (current.current === mine && !started) { stop(); setError('That voice did not load. Is the speech server running?'); }
    }, 20_000);
    player.addListener('playbackStatusUpdate', (s) => {
      if (current.current !== mine) return;
      if (s.playing) started = true;
      if (s.didJustFinish) { clearTimeout(giveUp); stop(); }
    });
    player.play();
  }, [api, stop]);

  useEffect(() => stop, [stop]);
  return { playing, play, stop, error };
}
