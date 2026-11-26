/**
 * Listen: a bot's reply read aloud in its own voice, from the speaker button under the message (the same
 * as the Android app's src/voice/listen.ts). The server makes the speech (POST /api/voice/speak). One reply
 * at a time: starting another or pressing the button again stops it. Long replies are read in pieces (the
 * server takes 1,500 characters at a time); the next piece is fetched while the one before it plays.
 */
import { useSyncExternalStore } from 'react';
import { voiceApi } from './api';
import { speakable } from './call';

type Listening = { key: string; state: 'loading' | 'playing' } | null;

const PIECE = 1400;
const MAX_PIECES = 12;

let cur: Listening = null;
let run = 0;
let player: HTMLAudioElement | null = null;
let abort: AbortController | null = null;
const subs = new Set<() => void>();
const set = (v: Listening) => { cur = v; for (const f of subs) f(); };

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
  run++;
  abort?.abort();
  abort = null;
  if (player) { try { player.pause(); } catch { /* gone */ } if (player.src.startsWith('blob:')) URL.revokeObjectURL(player.src); player = null; }
  if (cur) set(null);
}

/** Read `text` aloud in `botId`'s voice. `key` names the message; calling again with the playing key stops it. */
export function listen(botId: string, key: string, text: string, onError: (msg: string) => void) {
  if (cur?.key === key) { stopListening(); return; }
  const list = pieces(speakable(text));
  if (!list.length) { onError('No words to read'); return; }
  stopListening();
  const id = ++run;
  const ac = new AbortController();
  abort = ac;
  set({ key, state: 'loading' });
  const fetchPiece = (i: number) => voiceApi.speak(botId, list[i], ac.signal).then((buf) => URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
  const fail = (e: unknown) => { if (id !== run) return; stopListening(); onError((e as Error)?.message || 'Speech unavailable'); };
  const play = (i: number, url: Promise<string>) => {
    url.then((src) => {
      if (id !== run) { URL.revokeObjectURL(src); return; }
      const next = i + 1 < list.length ? fetchPiece(i + 1) : null;
      next?.catch(() => {});
      const a = new Audio(src);
      player = a;
      a.onended = () => {
        URL.revokeObjectURL(src);
        if (id !== run) return;
        if (next) play(i + 1, next); else { player = null; set(null); }
      };
      a.onerror = () => fail(new Error('This browser could not play the speech'));
      a.play().then(() => { if (id === run && cur?.state === 'loading') set({ key, state: 'playing' }); }, fail);
    }, fail);
  };
  play(0, fetchPiece(0));
}

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
/** 'loading' | 'playing' while this message is being read, else null. */
export function useListening(key: string): 'loading' | 'playing' | null {
  return useSyncExternalStore(subscribe, () => (cur?.key === key ? cur.state : null));
}
