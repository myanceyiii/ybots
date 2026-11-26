/**
 * Listen: a bot's reply read aloud in its own voice, from the speaker button under the message.
 * The server makes the speech (POST /api/voice/speak, the same as on a call) and the phone plays it as it
 * arrives. One reply at a time: starting another, tapping the button again, a call or dictation stops it.
 * Long replies are read in pieces (the server takes 1,500 characters at a time), each asked for as the one
 * before it starts playing, so there is no long wait and no pile of requests.
 */
import { useSyncExternalStore } from 'react';
import type { Client } from '../api';
import { nativeReason, voiceNative } from '../../modules/cleft-voice/src';
import { isCallActive } from './call';
import { speakable } from './speakable';

export type Listening = { key: string; state: 'loading' | 'playing' } | null;

const PIECE = 1400;
/** About a quarter of an hour of speech; a longer reply is read up to here. */
const MAX_PIECES = 12;

let cur: Listening = null;
let run = 0;
let left = 0;
const subs = new Set<() => void>();
const set = (v: Listening) => { cur = v; for (const f of subs) f(); };

export const listenAvailable = !!voiceNative.playStream && !!voiceNative.setMedia;

if (listenAvailable) {
  // The speaker went quiet and nothing more is coming: the reply has been read.
  voiceNative.on('onPlayback', (e) => { if (!e.playing && cur && left === 0) set(null); });
}

/** The text in pieces the server will take, cut at sentence ends where it can. */
export function pieces(text: string, size = PIECE): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > size && out.length < MAX_PIECES - 1) {
    const head = rest.slice(0, size);
    let cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('; '), head.lastIndexOf(': '));
    if (cut < size * 0.5) cut = head.lastIndexOf(', ');
    if (cut < size * 0.5) cut = head.lastIndexOf(' ');
    if (cut < size * 0.5) cut = size - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest.slice(0, size + 100));
  return out;
}

export function stopListening() {
  if (!cur) return;
  run++;
  left = 0;
  voiceNative.clear();
  set(null);
}

/** Read `text` aloud in `botId`'s voice. `key` names the message; calling again with the playing key stops it. */
export function listen(api: Client, botId: string, key: string, text: string, onError: (msg: string) => void) {
  if (!listenAvailable) return;
  if (cur?.key === key) { stopListening(); return; }
  if (isCallActive()) { onError('End the voice call first.'); return; }
  const list = pieces(speakable(text));
  if (!list.length) { onError('There are no words to read in this message.'); return; }
  stopListening();
  const id = ++run;
  left = list.length;
  voiceNative.setMedia!(true);
  set({ key, state: 'loading' });
  const next = (i: number) => {
    if (id !== run || i >= list.length) return;
    voiceNative.playStream!(`${api.server}/api/voice/speak`, api.authHeader, { botId, text: list[i], stream: true }).then((ok) => {
      if (id !== run) return;
      left--;
      // Dropped before it played: something else took the speaker (a call, dictation).
      if (!ok) { stopListening(); return; }
      if (cur?.state === 'loading') set({ key, state: 'playing' });
      next(i + 1);
    }, (e) => {
      if (id !== run) return;
      stopListening();
      onError(nativeReason(e, 'The speech server did not answer.'));
    });
  };
  next(0);
}

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
/** 'loading' | 'playing' while this message is being read, else null. */
export function useListening(key: string): 'loading' | 'playing' | null {
  return useSyncExternalStore(subscribe, () => (cur?.key === key ? cur.state : null));
}
