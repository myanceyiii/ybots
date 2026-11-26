// The quick-ask card: the phone's assistant gesture (Android), the Talk popup (Windows) and /?talk (web).
// You speak, and when you stop talking the words are sent by themselves; the answer is shown, and read
// out when you asked by voice. This file is the part with no screen in it:
//  - EndOfSpeech: when you have finished talking, from the loudness of each 40 ms of microphone audio;
//  - replyAfter: the Bot's answer to the message just sent, from the chat's rows;
//  - SpeechQueue: which new, complete sentences of that answer are ready to be read out.
//
// No browser- or phone-only code: web/src/voice/quickAsk.ts and mobile/src/voice/quickAsk.ts are the
// same file; keep them so.

/** Audio arrives in 40 ms frames (liveDictation.ts). */
const FRAME_MS = 40;

/** Quiet this long after you have said something: you are done, so it is sent. */
export const END_SILENCE_MS = 1200;
/** Words that rarely end a request ("and…", "the…") give you a little longer to go on. */
const TRAILING_SILENCE_MS = 2200;
/** Under this much speech is a cough or a click, not a request. */
const MIN_SPEECH_MS = 320;
/** Nothing said for this long: stop listening (the mic is one tap away). */
const NO_SPEECH_MS = 8000;
/** The longest one request may run. */
const MAX_MS = 60_000;

const TRAILING = /\b(and|but|or|so|because|the|a|an|to|of|for|with|from|about|that|my|your|is|was|then|um+|uh+|like)\s*$/i;

export type EndReason = 'done' | 'nothing' | 'long';

/**
 * Decides when you have finished talking. push() takes the loudness (RMS, 0..1) of each new frame and
 * answers null while you may still be talking, else why listening should stop. `textSoFar` (optional)
 * is what has been written down so far: a sentence that obviously goes on is given longer.
 */
export class EndOfSpeech {
  private floor = 0.004;
  private frames = 0;
  private voiced = 0;
  private quiet = 0;
  private silenceMs: number;

  constructor(silenceMs = END_SILENCE_MS) { this.silenceMs = silenceMs; }

  /** True once something has been said (enough to be worth sending). */
  get heard() { return this.voiced * FRAME_MS >= MIN_SPEECH_MS; }

  push(levels: number[], textSoFar = ''): EndReason | null {
    for (const r of levels) {
      this.frames++;
      const bar = Math.max(0.012, this.floor * 3);
      if (r > bar) { this.voiced++; this.quiet = 0; } else {
        if (r < bar * 0.7) this.quiet++;
        this.floor = this.floor * 0.95 + Math.min(r, 0.05) * 0.05;
      }
    }
    const ms = this.frames * FRAME_MS;
    if (ms >= MAX_MS) return 'long';
    if (!this.heard) return ms >= NO_SPEECH_MS ? 'nothing' : null;
    const wait = TRAILING.test(textSoFar.trim()) ? TRAILING_SILENCE_MS : this.silenceMs;
    return this.quiet * FRAME_MS >= wait ? 'done' : null;
  }
}

/** The little of a chat row this needs (server rows have more). */
export interface QuickRow { seq: number; body: any }

export interface QuickReply {
  /** The answer's text so far (every Bot message after yours, in order). */
  text: string;
  /** Still being written. */
  streaming: boolean;
  /** A card waiting on you (an approval or a question): it is answered in the app, never from this card. */
  waiting: string | null;
  /** The answer's rows, for "Open in app". */
  seqs: number[];
}

/** The Bot's answer to the message you sent as `sentSeq`. */
export function replyAfter(rows: QuickRow[], sentSeq: number): QuickReply {
  const out: QuickReply = { text: '', streaming: false, waiting: null, seqs: [] };
  const parts: string[] = [];
  for (const r of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (r.seq <= sentSeq) continue;
    const b = r.body;
    if (b?.type === 'message' && b.role === 'assistant') {
      const t = String(b.text ?? '').trim();
      if (t) parts.push(t);
      if (b.streaming) out.streaming = true;
      out.seqs.push(r.seq);
    } else if (b?.type === 'card' && b.status === 'pending' && (b.card === 'approval' || b.card === 'question')) {
      out.waiting = b.card === 'question' ? String(b.question ?? 'A question is waiting for you.') : String(b.title ?? 'An approval is waiting for you.');
      out.seqs.push(r.seq);
    }
  }
  out.text = parts.join('\n\n');
  return out;
}

/**
 * Hands out the next whole sentences of an answer as it streams in, each once. feed() takes the rows;
 * it answers the new text to read out (possibly empty).
 */
export class SpeechQueue {
  private done = new Map<number, number>();
  private sentSeq: number;
  constructor(sentSeq: number) { this.sentSeq = sentSeq; }
  feed(rows: QuickRow[]): string[] {
    const out: string[] = [];
    for (const r of [...rows].sort((a, b) => a.seq - b.seq)) {
      const b = r.body;
      if (r.seq <= this.sentSeq || b?.type !== 'message' || b.role !== 'assistant') continue;
      const text = String(b.text ?? '');
      const from = this.done.get(r.seq) ?? 0;
      const to = b.streaming ? sentenceEnd(text) : text.length;
      if (to > from) {
        const piece = text.slice(from, to).trim();
        this.done.set(r.seq, to);
        if (piece) out.push(piece);
      }
    }
    return out;
  }
}

/** Where the last complete sentence in text still streaming in ends, or -1 (as speakable.ts lastSentenceEnd). */
function sentenceEnd(text: string): number {
  let end = -1;
  const re = /[.!?…:;](?=\s|$)|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) end = m.index + m[0].length;
  return end;
}
