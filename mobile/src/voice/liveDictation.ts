// Live dictation text, worked out from the speech server's plain (file in, text out) transcription.
//
// The speech server (Speaches / faster-whisper on Host2) has no word-by-word results, so the words
// are made live the way whisper_streaming (ufal, MIT) does it: the audio not yet settled is sent
// again about once a second and its text shown as "so far"; at each pause (0.6 s of quiet) the
// audio up to the pause is transcribed one last time and that text is kept. Every request is
// therefore short, one at a time, and the text keeps up a second or two behind you.
//
// This file has no browser or phone code in it. web/src/voice/liveDictation.ts and
// mobile/src/voice/liveDictation.ts are the same file; keep them so.

/** Audio comes in 40 ms frames; only each frame's loudness (RMS, 0..1) is needed here. */
export const FRAME_MS = 40;

const PAUSE_FRAMES = 15; // 600 ms of quiet settles what came before
const INTERIM_EVERY = 20; // ask again once 800 ms more has been heard
const MAX_SEGMENT = 375; // 15 s without a pause: settle at the quietest point of the last 3 s
const MIN_VOICED = 6; // under 240 ms of speech is a noise (Whisper makes words up from noise)

export interface LiveText {
  /** Text that will not change any more. */
  settled: string;
  /** The newest words, still being worked out (shown, but may change). */
  pending: string;
}

/**
 * clip(from, to): transcribe frames [from, to) and resolve with the text. The caller keeps the audio.
 * onText: called whenever the text changes.
 */
export class LiveDictation {
  private rms: number[] = [];
  private floor = 0.004;
  private settledParts: string[] = [];
  private settledTo = 0;
  private pending = '';
  private askedTo = 0;
  private busy: Promise<void> | null = null;
  private stopped = false;
  private cancelled = false;
  /** Set when a request failed; the end-of-dictation pass still tries once more. */
  lastError: string | null = null;

  constructor(private clip: (from: number, to: number) => Promise<string>, private onText: (t: LiveText) => void) {}

  get frames() { return this.rms.length; }
  get text(): LiveText { return { settled: this.settledParts.join(' '), pending: this.pending }; }

  /** Add the loudness of each new 40 ms frame, in order. */
  push(levels: number[]) {
    for (const r of levels) {
      this.rms.push(r);
      if (r < this.bar()) this.floor = this.floor * 0.95 + Math.min(r, 0.05) * 0.05;
    }
    this.tick();
  }

  /** Stop listening: settle whatever is left and resolve with the whole text. */
  async finish(): Promise<string> {
    this.stopped = true;
    while (this.busy) await this.busy;
    const end = this.rms.length;
    if (end > this.settledTo) {
      if (this.voiced(this.settledTo, end) >= MIN_VOICED) {
        try { this.settle(await this.clip(this.settledTo, end), end); } catch (e) { this.lastError = (e as Error).message || 'Transcription failed'; this.keepPending(end); }
      } else this.settle('', end);
    }
    return this.text.settled;
  }

  /** Throw away anything still in flight (cancel). */
  cancel() { this.stopped = this.cancelled = true; }

  private bar() { return Math.max(0.012, this.floor * 3); }
  private loud(i: number) { return this.rms[i] > this.bar() * 0.7; }
  private voiced(from: number, to: number) { let n = 0; for (let i = from; i < to; i++) if (this.rms[i] > this.bar()) n++; return n; }

  /** The end of the first pause after `from` that follows some speech, or -1. */
  private pauseAfter(from: number): number {
    let quiet = 0, spoke = 0;
    for (let i = from; i < this.rms.length; i++) {
      if (this.loud(i)) { quiet = 0; spoke++; } else if (++quiet >= PAUSE_FRAMES && spoke) return i - Math.floor(PAUSE_FRAMES / 2);
    }
    return -1;
  }

  private quietest(from: number, to: number) {
    let best = to, low = Infinity;
    for (let i = from; i < to; i++) if (this.rms[i] < low) { low = this.rms[i]; best = i; }
    return best;
  }

  private tick() {
    if (this.busy || this.stopped) return;
    const end = this.rms.length;
    let cut = this.pauseAfter(this.settledTo);
    if (cut < 0 && end - this.settledTo >= MAX_SEGMENT) cut = this.quietest(end - 75, end);
    if (cut > this.settledTo) {
      const from = this.settledTo;
      if (this.voiced(from, cut) < MIN_VOICED) { this.settledTo = cut; this.askedTo = Math.max(this.askedTo, cut); this.tick(); return; }
      this.run(async () => { this.settle(await this.clip(from, cut), cut); });
      return;
    }
    if (end - this.askedTo >= INTERIM_EVERY && this.voiced(this.settledTo, end) >= MIN_VOICED) {
      const from = this.settledTo;
      this.askedTo = end;
      this.run(async () => {
        const t = await this.clip(from, end);
        if (this.settledTo === from && !this.stopped) { this.pending = t.trim(); this.emit(); }
      });
    }
  }

  private run(job: () => Promise<void>) {
    this.busy = job()
      .catch((e) => { this.lastError = (e as Error).message || 'Transcription failed'; })
      .finally(() => { this.busy = null; this.tick(); });
  }

  private settle(t: string, to: number) {
    const s = t.trim();
    if (s) this.settledParts.push(s);
    this.settledTo = to;
    this.askedTo = Math.max(this.askedTo, to);
    this.pending = '';
    this.emit();
  }

  /** A failed last pass keeps what was already shown for that stretch rather than losing it. */
  private keepPending(to: number) { this.settle(this.pending, to); }

  private emit() { if (!this.cancelled) this.onText(this.text); }
}

/** Loudness (RMS, 0..1) of 16-bit samples. */
export function rmsOf(pcm: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return pcm.length ? Math.sqrt(sum / pcm.length) / 32768 : 0;
}
