// Browser audio for voice calls: mic capture → PCM16 @ 24 kHz (AudioWorklet), and a gapless PCM16 player.

export const RATE = 24000;

// The worklet runs at the context's native rate (usually 48 kHz). It box-filters down to 24 kHz,
// converts to Int16 and posts 40 ms frames plus a level for the UI.
const WORKLET = `
class Pcm16Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.target = (options.processorOptions && options.processorOptions.rate) || 24000;
    this.ratio = sampleRate / this.target;
    this.frame = new Int16Array(Math.round(this.target * 0.04));
    this.n = 0; this.sum = 0; this.cnt = 0; this.t = 0; this.peak = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      this.sum += s; this.cnt++; this.t += 1;
      const a = s < 0 ? -s : s; if (a > this.peak) this.peak = a;
      if (this.t >= this.ratio) {
        this.t -= this.ratio;
        let v = this.sum / this.cnt; this.sum = 0; this.cnt = 0;
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        this.frame[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.frame.length) {
          const out = this.frame.slice(0);
          this.port.postMessage({ pcm: out.buffer, level: this.peak }, [out.buffer]);
          this.n = 0; this.peak = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm16-capture', Pcm16Capture);
`;

let workletUrl: string | null = null;
const loadedContexts = new WeakSet<BaseAudioContext>();

async function ensureWorklet(ctx: AudioContext) {
  if (loadedContexts.has(ctx)) return;
  workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(workletUrl);
  loadedContexts.add(ctx);
}

/** Create (and resume) an AudioContext. Call this synchronously inside a click handler so autoplay rules allow it. */
export function createAudioContext(): AudioContext {
  const Ctx: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx({ latencyHint: 'interactive' });
  void ctx.resume().catch(() => {});
  return ctx;
}

export function micErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was blocked. Allow it in your browser’s site settings.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found.';
  if (name === 'NotReadableError') return 'Your microphone is in use by another app.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser can’t use the microphone here (it needs HTTPS or localhost).';
  return (e as Error)?.message || 'Could not open the microphone.';
}

export async function openMic(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no mediaDevices'), { name: 'NotSupportedError' });
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
}

export class MicCapture {
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  level = 0;

  constructor(private ctx: AudioContext, private stream: MediaStream, private onFrame: (pcm: Int16Array) => void, private rate = RATE) {}

  async start() {
    await ensureWorklet(this.ctx);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm16-capture', { processorOptions: { rate: this.rate }, numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    this.node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      this.level = this.level * 0.6 + e.data.level * 0.4;
      this.onFrame(new Int16Array(e.data.pcm));
    };
    // A worklet only runs while connected to the destination; route it through a muted gain.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node).connect(this.sink).connect(this.ctx.destination);
  }

  set muted(m: boolean) {
    for (const t of this.stream.getAudioTracks()) t.enabled = !m;
    if (m) this.level = 0;
  }

  stop() {
    try { this.source?.disconnect(); this.node?.disconnect(); this.sink?.disconnect(); } catch { /* already gone */ }
    if (this.node) this.node.port.onmessage = null;
    for (const t of this.stream.getTracks()) t.stop();
    this.source = this.node = this.sink = null;
  }
}

/** Gapless queue of PCM16 chunks (e.g. realtime `response.output_audio.delta`). */
export class PcmPlayer {
  private out: GainNode;
  private analyser: AnalyserNode;
  private sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private idleWaiters: (() => void)[] = [];
  private levelBuf: Float32Array<ArrayBuffer>;
  onIdle: (() => void) | null = null;
  onStart: (() => void) | null = null;

  constructor(private ctx: AudioContext) {
    this.out = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.levelBuf = new Float32Array(this.analyser.fftSize);
    this.out.connect(this.analyser).connect(ctx.destination);
  }

  get playing() { return this.sources.size > 0; }

  push(pcm: Int16Array, rate = RATE) {
    if (!pcm.length) return;
    const buf = this.ctx.createBuffer(1, pcm.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    this.pushBuffer(buf);
  }

  /** Queue decoded audio (e.g. a WAV from the speech server) right after what is already playing. */
  pushBuffer(buf: AudioBuffer) {
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    const now = this.ctx.currentTime;
    const wasIdle = !this.sources.size;
    // Small lead-in when starting fresh absorbs network jitter.
    const at = this.nextTime > now ? this.nextTime : now + 0.06;
    src.start(at);
    this.nextTime = at + buf.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size) this.settle();
    };
    if (wasIdle) this.onStart?.();
  }

  /** Drop everything queued (barge-in). */
  clear() {
    const had = this.sources.size > 0;
    for (const s of this.sources) { s.onended = null; try { s.stop(); } catch { /* not started */ } }
    this.sources.clear();
    this.nextTime = 0;
    if (had) this.settle();
  }

  whenIdle(maxMs = 15000): Promise<void> {
    if (!this.sources.size) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, maxMs);
      this.idleWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  /** RMS output level 0..1 for the speaking animation. */
  level(): number {
    if (!this.sources.size) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (let i = 0; i < this.levelBuf.length; i++) sum += this.levelBuf[i] * this.levelBuf[i];
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 4);
  }

  private settle() {
    this.onIdle?.();
    const w = this.idleWaiters.splice(0);
    for (const f of w) f();
  }

  dispose() {
    this.clear();
    try { this.out.disconnect(); this.analyser.disconnect(); } catch { /* ignore */ }
  }
}

// ---------- WAV ----------

/** PCM16 mono samples -> a WAV file the speech server can transcribe. */
export function pcmToWav(pcm: Int16Array, rate = RATE): Blob {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer], { type: 'audio/wav' });
}

/**
 * Read a WAV response as it arrives: 16-bit mono/stereo PCM comes out in pieces of about 0.1 s (so
 * playback can start while the rest is still being made); anything else comes out whole, to decode.
 */
export async function* wavPieces(res: Response): AsyncGenerator<{ pcm: Int16Array; rate: number } | { whole: ArrayBuffer }> {
  const reader = res.body?.getReader();
  if (!reader) { yield { whole: await res.arrayBuffer() }; return; }
  let head = new Uint8Array(0);
  let fmt: { rate: number; channels: number } | null = null;
  // Header: RIFF/WAVE, then chunks until "data".
  for (;;) {
    const { done, value } = await reader.read();
    if (value) { const b = new Uint8Array(head.length + value.length); b.set(head); b.set(value, head.length); head = b; }
    const parsed = parseWavHead(head);
    if (parsed === 'not-pcm' || (done && !parsed)) {
      // Not something to stream (or too short to tell): hand the whole file to the decoder.
      const rest: Uint8Array[] = [head];
      for (;;) { const r = await reader.read(); if (r.done) break; rest.push(r.value); }
      const total = rest.reduce((n, x) => n + x.length, 0);
      const all = new Uint8Array(total); let o = 0; for (const x of rest) { all.set(x, o); o += x.length; }
      if (total) yield { whole: all.buffer };
      return;
    }
    if (parsed) { fmt = parsed; head = head.subarray(parsed.dataStart); break; }
    if (done) return;
  }
  const frame = 2 * fmt.channels;
  const min = Math.round(fmt.rate * 0.1) * frame;
  let pending = head;
  const out = function* (flush: boolean) {
    while (pending.length >= min || (flush && pending.length >= frame)) {
      const n = flush ? pending.length - (pending.length % frame) : min;
      const bytes = pending.slice(0, n);
      pending = pending.subarray(n);
      let pcm = new Int16Array(bytes.buffer, 0, n / 2);
      if (fmt!.channels === 2) { const m = new Int16Array(pcm.length / 2); for (let i = 0; i < m.length; i++) m[i] = (pcm[2 * i] + pcm[2 * i + 1]) >> 1; pcm = m; }
      yield { pcm, rate: fmt!.rate };
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) { const b = new Uint8Array(pending.length + value.length); b.set(pending); b.set(value, pending.length); pending = b; }
    yield* out(done);
    if (done) return;
  }
}

/** Where a 16-bit PCM WAV's samples start, null if more bytes are needed, 'not-pcm' for anything else. */
function parseWavHead(b: Uint8Array): { rate: number; channels: number; dataStart: number } | null | 'not-pcm' {
  if (b.length < 12) return null;
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return 'not-pcm';
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 12;
  let fmt: { rate: number; channels: number } | null = null;
  while (o + 8 <= b.length) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'data') return fmt ? { ...fmt, dataStart: o + 8 } : 'not-pcm';
    if (o + 8 + size > b.length) return null;
    if (id === 'fmt ') {
      const format = v.getUint16(o + 8, true), channels = v.getUint16(o + 10, true), rate = v.getUint32(o + 12, true), bits = v.getUint16(o + 22, true);
      if (format !== 1 || bits !== 16 || channels < 1 || channels > 2) return 'not-pcm';
      fmt = { rate, channels };
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

// ---------- base64 <-> PCM16 ----------

export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

export function base64ToPcm(b64: string): Int16Array {
  const bin = atob(b64);
  const n = bin.length & ~1;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}
