// Live dictation, choosing the way the words are worked out:
//  - "live": the microphone streams to the live speech-to-text service on the server (WebSocket
//    /api/voice/live, Moonshine streaming, deploy/live-stt), which sends the words back as they change;
//  - "chunked": liveDictation.ts (the speech server is asked again about once a second).
// Live is tried first when the server says it is up; if the socket fails to open, or drops before the
// end, the engine falls back to chunked from the start of the recording, so no words are lost.
//
// No browser- or phone-only code: web/src/voice/liveEngine.ts and mobile/src/voice/liveEngine.ts are
// the same file; keep them so.
import { LiveDictation, type LiveText } from './liveDictation';

const OPEN_MS = 2500;
const FINAL_MS = 4000;

export interface LiveEngineOptions {
  /** wss://…/api/voice/live, or null to go straight to chunked. */
  socketUrl: string | null;
  /** Makes the socket (the phone passes its sign-in header here). */
  openSocket?: (url: string) => WebSocket;
  /** Chunked: transcribe 40 ms frames [from, to). */
  clip: (from: number, to: number) => Promise<string>;
  onText: (t: LiveText) => void;
}

export class LiveEngine {
  mode: 'live' | 'chunked';
  private ws: WebSocket | null = null;
  private open = false;
  private waiting: ArrayBuffer[] = [];
  private finalText: string | null = null;
  private onFinal: (() => void) | null = null;
  private chunked: LiveDictation | null = null;
  private levels: number[] = [];
  private done = false;
  private openTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private o: LiveEngineOptions) {
    this.mode = o.socketUrl ? 'live' : 'chunked';
    if (o.socketUrl) this.connect(o.socketUrl);
    else this.toChunked();
  }

  private connect(url: string) {
    let ws: WebSocket;
    try { ws = this.o.openSocket ? this.o.openSocket(url) : new WebSocket(url); } catch { this.toChunked(); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.openTimer = setTimeout(() => { if (!this.open) this.fail(); }, OPEN_MS);
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let m: { type?: string; settled?: string; pending?: string; text?: string };
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'ready') {
        this.open = true;
        if (this.openTimer) clearTimeout(this.openTimer);
        for (const b of this.waiting.splice(0)) ws.send(b);
      } else if (m.type === 'text' && !this.done) {
        this.o.onText({ settled: m.settled ?? '', pending: m.pending ?? '' });
      } else if (m.type === 'final') {
        this.finalText = (m.text ?? '').trim();
        this.onFinal?.();
      } else if (m.type === 'error') {
        this.fail();
      }
    };
    ws.onerror = () => this.fail();
    ws.onclose = () => { if (this.finalText === null) this.fail(); };
  }

  /** The socket is gone before the end: work the whole recording out the chunked way instead. */
  private fail() {
    if (this.mode !== 'live') return;
    if (this.openTimer) clearTimeout(this.openTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = ws.onerror = ws.onmessage = null; try { ws.close(); } catch { /* gone */ } }
    this.toChunked();
    this.onFinal?.();
  }

  private toChunked() {
    this.mode = 'chunked';
    this.waiting = [];
    this.chunked = new LiveDictation(this.o.clip, (t) => { if (!this.done) this.o.onText(t); });
    if (this.levels.length) this.chunked.push(this.levels);
  }

  /** New microphone audio: its 16 kHz samples (for live) and the loudness of each new 40 ms frame. */
  push(pcm: Int16Array | null, levels: number[]) {
    this.levels.push(...levels);
    if (this.mode === 'chunked') { this.chunked!.push(levels); return; }
    if (!pcm || !pcm.length) return;
    const buf = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
    if (this.open && this.ws) this.ws.send(buf);
    else if (this.waiting.length < 200) this.waiting.push(buf);
  }

  /** Stop listening and resolve with the whole text (and the last error, if nothing came of it). */
  async finish(): Promise<{ text: string; error: string | null }> {
    if (this.mode === 'live' && this.ws) {
      const ws = this.ws;
      const got = new Promise<void>((resolve) => {
        this.onFinal = resolve;
        setTimeout(resolve, FINAL_MS);
      });
      if (this.open) ws.send(JSON.stringify({ type: 'stop' }));
      await got;
      if (this.mode === 'live' && this.finalText !== null) {
        this.done = true;
        try { ws.close(); } catch { /* gone */ }
        return { text: this.finalText, error: null };
      }
      if (this.mode === 'live') this.fail(); // no final in time
    }
    const text = await this.chunked!.finish();
    this.done = true;
    return { text, error: this.chunked!.lastError };
  }

  cancel() {
    this.done = true;
    if (this.openTimer) clearTimeout(this.openTimer);
    if (this.ws) { this.ws.onclose = this.ws.onerror = this.ws.onmessage = null; try { this.ws.close(); } catch { /* gone */ } }
    this.chunked?.cancel();
  }
}
