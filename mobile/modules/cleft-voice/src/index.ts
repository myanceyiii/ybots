import { Platform } from 'react-native';
import { requireOptionalNativeModule, type EventSubscription } from 'expo';

/**
 * The phone's microphone and speaker for voice calls and dictation (modules/cleft-voice/android).
 * Android only; in the web preview `available` is false and nothing here does anything.
 */
interface Events {
  onSpeechStart: () => void;
  /** One thing said on a call, as a WAV file. An empty path: it was a noise, or cut off by Mute. */
  onUtterance: (e: { path: string; ms: number }) => void;
  onPlayback: (e: { playing: boolean }) => void;
  onError: (e: { message: string }) => void;
}

interface Native {
  start(mode: 'call' | 'dictate'): boolean;
  stop(): string | null;
  setMuted(muted: boolean): void;
  /** Dictation: loudness (RMS 0..1) of each 40 ms frame heard since frame `from`. */
  dictationLevels?(from: number): number[];
  /** Dictation: frames [from, to) as a WAV file, while still listening (null when none). */
  dictationClip?(from: number, to: number): string | null;
  /** Dictation: frames from `from` on, as base64 PCM16 16 kHz mono. */
  dictationPcm?(from: number): string;
  levels(): { mic: number; out: number };
  fetchAudio(url: string, headers: Record<string, string>, body: string): Promise<string>;
  /** Plays speech as it arrives, after what is queued; true once audio arrived, false if dropped first. */
  playStream(url: string, headers: Record<string, string>, body: string): Promise<boolean>;
  /** true: play as media (Listen in a chat); false: on the call stream. Drops what is playing when it changes. */
  setMedia?(on: boolean): void;
  play(path: string): void;
  clear(): void;
  isPlaying(): boolean;
  discard(path: string): boolean;
  end(): void;
  addListener<K extends keyof Events>(name: K, listener: Events[K]): EventSubscription;
}

const native = Platform.OS === 'android' ? requireOptionalNativeModule<Native>('CleftVoice') : null;

/** The plain reason inside an error from the native side ("…Caused by: Could not open the microphone."). */
export function nativeReason(e: unknown, fallback: string): string {
  const msg = String((e as Error)?.message ?? '');
  const tail = msg.split(/Caused by:\s*/).pop()?.replace(/^[\w.$]+Exception:\s*/, '').trim();
  return tail || fallback;
}

export const voiceNative = {
  available: !!native,
  start: (mode: 'call' | 'dictate') => native!.start(mode),
  stop: () => native?.stop() ?? null,
  setMuted: (m: boolean) => native?.setMuted(m),
  /** False on an app build from before live dictation text. */
  liveDictation: !!native?.dictationLevels && !!native?.dictationClip,
  dictationLevels: (from: number): number[] => native?.dictationLevels?.(from) ?? [],
  dictationClip: (from: number, to: number): string | null => native?.dictationClip?.(from, to) ?? null,
  /** False on an app build from before the live dictation service. */
  liveStream: !!native?.dictationPcm,
  dictationPcm: (from: number): string => native?.dictationPcm?.(from) ?? '',
  levels: () => native?.levels() ?? { mic: 0, out: 0 },
  fetchAudio: (url: string, headers: Record<string, string>, body: unknown) => native!.fetchAudio(url, headers, JSON.stringify(body)),
  /** Undefined on an app build without it (then use fetchAudio + play). */
  playStream: native?.playStream ? (url: string, headers: Record<string, string>, body: unknown) => native!.playStream(url, headers, JSON.stringify(body)) : undefined,
  /** Undefined on an app build from before Listen. */
  setMedia: native?.setMedia ? (on: boolean) => native!.setMedia!(on) : undefined,
  play: (path: string) => native?.play(path),
  clear: () => native?.clear(),
  isPlaying: () => native?.isPlaying() ?? false,
  discard: (path: string) => { try { native?.discard(path); } catch { /* gone */ } },
  end: () => native?.end(),
  on<K extends keyof Events>(name: K, f: Events[K]): () => void {
    if (!native) return () => {};
    const sub = native.addListener(name, f);
    return () => sub.remove();
  },
};
