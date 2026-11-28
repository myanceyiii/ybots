// A voice call with a bot, the way you would call a dot: hands-free, in the browser (desktop or phone).
//
// Nothing here talks to a cloud voice service. The microphone is listened to in the browser; when you
// stop talking, what you said goes to the server as audio, is transcribed by the local speech server
// and sent to the bot as a message. The bot's own agent does the work (its tools, apps, computer,
// approvals) and its replies, as they stream into the chat, are spoken back sentence by sentence.
// While it works the call says so now and then; an action waiting for your OK is read out, and
// with VOICE_APPROVALS=1 on the server you can answer it by saying yes or no. Talking over the bot
// stops it. "Goodbye" ends the call.
import { create } from 'zustand';
import type { Row } from '@shared/types';
import { sortedRows, useStore } from '../store';
import { voiceApi, type VoiceSession } from './api';
import { MicCapture, PcmPlayer, RATE, createAudioContext, micErrorMessage, openMic, pcmToWav, wavPieces } from './audio';

export interface Caption { id: string; role: 'user' | 'assistant'; text: string; final: boolean }

export type CallStatus = 'idle' | 'connecting' | 'live' | 'ending' | 'error';

interface VoiceState {
  status: CallStatus;
  botId: string | null;
  callId: string | null;
  muted: boolean;
  /** Bot audio is playing. */
  speaking: boolean;
  /** The user is talking (voice detected). */
  listening: boolean;
  /** What you said is being transcribed, or the bot has not answered yet. */
  thinking: boolean;
  /** The bot is working on what was asked on the call. */
  working: { seq: number; request: string }[];
  captions: Caption[];
  error: string | null;
  startedAt: number | null;
}

export const useVoice = create<VoiceState>(() => ({
  status: 'idle', botId: null, callId: null, muted: false, speaking: false, listening: false, thinking: false,
  working: [], captions: [], error: null, startedAt: null,
}));

const setV = (p: Partial<VoiceState>) => useVoice.setState(p);

let current: VoiceCall | null = null;

/** Start a call with a bot. Must be called from a user gesture (click) so audio can start. */
export function startCall(botId: string) {
  if (current && !current.ended) {
    if (current.botId === botId) return;
    current.end();
  }
  current = new VoiceCall(botId);
  void current.start();
}

export function endCall() { current?.end(); }
export function toggleMute() { current?.setMuted(!useVoice.getState().muted); }
export function callLevels(): { out: number; mic: number } {
  return current && !current.ended ? { out: current.player.level(), mic: current.micLevel() } : { out: 0, mic: 0 };
}
export const isCallActive = (s: VoiceState = useVoice.getState()) => s.status === 'connecting' || s.status === 'live';

// ---------- voice detection ----------

const FRAME_MS = 40; // MicCapture's frame
const START_FRAMES = 3; // 120 ms of speech to start
const END_FRAMES = 20; // 800 ms of quiet to end
const PREROLL_FRAMES = 8; // keep 320 ms from before the start
const MIN_VOICED = 6; // shorter than 240 ms of speech is a noise
const MAX_FRAMES = Math.round(30_000 / FRAME_MS);

/**
 * Energy-based voice detection with an adaptive noise floor. While the bot is speaking the bar is
 * higher, so its own voice coming back through the speakers is not taken for the user's (the
 * browser's echo cancellation does most of that work).
 */
class Vad {
  private floor = 0.004;
  private above = 0;
  private quiet = 0;
  private voiced = 0;
  private inSpeech = false;
  private frames: Int16Array[] = [];
  private preroll: Int16Array[] = [];
  constructor(private onStart: () => void, private onEnd: (pcm: Int16Array | null) => void) {}

  feed(pcm: Int16Array, botTalking: boolean) {
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    const rms = Math.sqrt(sum / Math.max(1, pcm.length)) / 32768;
    const bar = Math.max(0.012, this.floor * 3) * (botTalking ? 2.5 : 1);
    if (!this.inSpeech) {
      this.preroll.push(pcm);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      if (rms > bar) {
        if (++this.above >= START_FRAMES) {
          this.inSpeech = true;
          this.frames = [...this.preroll];
          this.voiced = this.above;
          this.quiet = 0;
          this.onStart();
        }
      } else {
        this.above = 0;
        this.floor = this.floor * 0.95 + Math.min(rms, 0.05) * 0.05;
      }
      return;
    }
    this.frames.push(pcm);
    if (rms > bar * 0.7) { this.quiet = 0; this.voiced++; } else this.quiet++;
    if (this.quiet >= END_FRAMES || this.frames.length >= MAX_FRAMES) this.finish();
  }

  /** End the current utterance now (mute, hang-up). */
  reset() { if (this.inSpeech) this.finish(true); this.above = 0; this.preroll = []; }

  private finish(drop = false) {
    const frames = this.frames;
    const voiced = this.voiced;
    this.inSpeech = false;
    this.frames = [];
    this.above = 0;
    this.preroll = [];
    if (drop || voiced < MIN_VOICED) { this.onEnd(null); return; }
    const total = frames.reduce((n, f) => n + f.length, 0);
    const out = new Int16Array(total);
    let o = 0;
    for (const f of frames) { out.set(f, o); o += f.length; }
    this.onEnd(out);
  }
}

// ---------- turning the bot's written replies into speech ----------

/** What a reply sounds like when read out: no markdown, links or code. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\*\*|__|~~|\*|_(?=\S)|(?<=\S)_/g, '')
    .replace(/\|/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Where the last complete sentence in `text` ends (for text still streaming in), or -1. */
function lastSentenceEnd(text: string): number {
  let end = -1;
  const re = /[.!?…:;](?=\s|$)|\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) end = m.index + m[0].length;
  return end;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

interface Spoken { offset: number; skipped: boolean }

class VoiceCall {
  ended = false;
  readonly ctx: AudioContext;
  readonly player: PcmPlayer;
  private mic: MicCapture | null = null;
  private vad: Vad;
  private sess: VoiceSession | null = null;
  /** Bumped on barge-in: speech fetched for an older generation is thrown away. */
  private gen = 0;
  private playChain: Promise<void> = Promise.resolve();
  private spoken = new Map<number, Spoken>();
  private announcedCards = new Set<number>();
  /** The approval card whose "say yes or no" was last actually played, and the one in play when you started speaking. */
  private heardCard: { approvalId: string; digest: string } | null = null;
  private idleWaiters: (() => void)[] = [];
  private cardAtSpeech: { approvalId: string; digest: string } | null = null;
  private lastHeardAt = 0;
  private lastSpokeAt = 0;
  private lastStatusAt = 0;
  private lastTurn: { seq: number; text: string } | null = null;
  private pendingTurns = 0;
  private unsubStore: (() => void) | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private onUnload = () => { if (this.sess && !this.ended) voiceApi.endBeacon(this.botId, this.sess.callId, this.transcript()); };

  constructor(readonly botId: string) {
    // Created synchronously inside the click so autoplay policy lets it run.
    this.ctx = createAudioContext();
    this.player = new PcmPlayer(this.ctx);
    this.player.onStart = () => { setV({ speaking: true }); };
    this.player.onIdle = () => { this.lastSpokeAt = Date.now(); setV({ speaking: false }); this.idleWaiters.splice(0).forEach((f) => f()); };
    this.vad = new Vad(() => this.speechStarted(), (pcm) => { setV({ listening: false }); if (pcm) void this.sendTurn(pcm); });
  }

  micLevel() { return useVoice.getState().muted ? 0 : this.mic?.level ?? 0; }

  async start() {
    setV({ status: 'connecting', botId: this.botId, callId: null, muted: false, speaking: false, listening: false, thinking: false, working: [], captions: [], error: null, startedAt: null });
    window.addEventListener('pagehide', this.onUnload);
    let stream: MediaStream;
    try {
      stream = await openMic();
    } catch (e) {
      this.end(micErrorMessage(e));
      return;
    }
    if (this.ended) { stream.getTracks().forEach((t) => t.stop()); return; }
    try {
      this.sess = await voiceApi.session(this.botId);
      if (this.ended) { void voiceApi.end(this.botId, this.sess.callId, [], 'Cancelled'); stream.getTracks().forEach((t) => t.stop()); return; }
      this.mic = new MicCapture(this.ctx, stream, (pcm) => { if (!this.ended && !useVoice.getState().muted) this.vad.feed(pcm, this.player.playing); });
      await this.mic.start();
      // Ended while the microphone was starting: end() already ran, so nothing here may bring the call back.
      if (this.ended) return;
      setV({ status: 'live', callId: this.sess.callId, startedAt: Date.now() });
      // Keep a phone's screen (and so the call) awake.
      try { this.wakeLock = await (navigator as any).wakeLock?.request('screen'); } catch { /* not offered */ }
      if (this.ended) { void this.wakeLock?.release().catch(() => {}); this.wakeLock = null; return; }
      this.watchChat();
      this.statusTimer = setInterval(() => this.statusUpdate(), 2000);
      this.say(this.sess.greeting, 'greeting');
    } catch (e) {
      // The microphone is stopped by end() only once MicCapture holds it; before that it is stopped here.
      if (!this.mic) stream.getTracks().forEach((t) => t.stop());
      if (!this.ended) this.end((e as Error).message || 'Could not start the call');
    }
  }

  setMuted(m: boolean) {
    if (this.mic) this.mic.muted = m;
    if (m) this.vad.reset();
    setV({ muted: m, listening: false });
  }

  // ---------- you talking ----------

  private speechStarted() {
    setV({ listening: true });
    this.cardAtSpeech = this.heardCard;
    // Barge-in: stop talking, drop what was still to be said, and listen.
    if (this.player.playing || this.pendingSpeech()) {
      this.gen++;
      this.player.clear();
      for (const s of this.spoken.values()) s.skipped = true;
      this.markSpokenToEnd();
    }
  }

  private async sendTurn(pcm: Int16Array) {
    if (this.ended || !this.sess) return;
    this.pendingTurns++;
    setV({ thinking: true });
    const card = this.cardAtSpeech;
    this.cardAtSpeech = null;
    try {
      const r = await voiceApi.turn(this.botId, this.sess.callId, pcmToWav(pcm, RATE), card);
      if (this.ended || !r.text) return;
      this.lastHeardAt = Date.now();
      this.caption(`u-${Date.now()}`, 'user', r.text, true);
      if (r.action === 'hangup') { this.say('Okay, talk soon.', 'bye'); await this.playChain; await this.player.whenIdle(5000); this.end(); return; }
      if (r.action === 'review-card') { this.say(r.reason || 'Open the approval card in chat to review this action.', 'ack'); return; }
      if (r.action === 'approved') { if (card && this.heardCard?.approvalId === card.approvalId) this.heardCard = null; this.say('Approved.', 'ack'); return; }
      if (r.action === 'declined') { if (card && this.heardCard?.approvalId === card.approvalId) this.heardCard = null; this.say('Okay, cancelled.', 'ack'); return; }
      if (r.seq) {
        this.lastTurn = { seq: r.seq, text: r.text };
        // A new request: older replies still streaming are not read out any more.
        this.markSpokenToEnd();
      }
    } catch (e) {
      if (!this.ended) this.say(`Sorry, I didn't catch that. ${(e as Error).message.includes('speech server') ? 'The speech server is not answering.' : ''}`.trim(), 'error');
    } finally {
      this.pendingTurns--;
      this.syncThinking();
    }
  }

  // ---------- the bot talking ----------

  private pendingSpeech() { return useVoice.getState().speaking; }

  /** Queue a piece of text to be spoken, in order, after anything already queued. */
  private say(text: string, captionId: string, onPlay?: () => void) {
    const clean = speakable(text);
    if (!clean || this.ended) return;
    const gen = this.gen;
    // Asked for now (so it is being made while earlier sentences play), played in order. The speech
    // arrives as it is made, so the first words play well before the sentence is finished.
    const ctl = new AbortController();
    const audio = voiceApi.speakStream(this.botId, clean, ctl.signal).catch(() => null);
    this.playChain = this.playChain.then(async () => {
      const res = await audio;
      if (!res || this.ended || gen !== this.gen) { ctl.abort(); return; }
      let started = false;
      try {
        for await (const piece of wavPieces(res)) {
          if (this.ended || gen !== this.gen) { ctl.abort(); return; }
          if ('pcm' in piece) this.player.push(piece.pcm, piece.rate);
          else this.player.pushBuffer(await this.ctx.decodeAudioData(piece.whole));
          if (!started) { started = true; this.lastSpokeAt = Date.now(); onPlay?.(); }
        }
        if (started) this.lastSpokeAt = Date.now();
      } catch { /* cut off, or not audio */ }
    });
    if (!captionId.startsWith('a-')) this.caption(`${captionId}-${Date.now()}`, 'assistant', clean, true);
  }

  /**
   * The approval prompt's first words are queued, not yet heard: earlier sentences may still be playing.
   * A spoken yes answers the card only once the prompt has played to the end without being talked over.
   */
  private async bindWhenHeard(card: { approvalId: string; digest: string }) {
    const gen = this.gen;
    if (this.player.playing) await new Promise<void>((resolve) => { const t = setTimeout(resolve, 120_000); this.idleWaiters.push(() => { clearTimeout(t); resolve(); }); });
    if (!this.ended && gen === this.gen && !this.player.playing) this.heardCard = card;
  }

  private markSpokenToEnd() {
    for (const r of this.callRows()) {
      if (r.body.type !== 'message' || r.body.role !== 'assistant') continue;
      this.spoken.set(r.seq, { offset: r.body.text.length, skipped: true });
    }
  }

  private callRows(): Row[] {
    const start = this.sess?.startSeq ?? Infinity;
    return sortedRows(useStore.getState().transcripts[this.botId]).filter((r) => r.seq > start);
  }

  private watchChat() {
    this.unsubStore = useStore.subscribe((s, prev) => {
      if (this.ended) return;
      if (s.transcripts[this.botId] !== prev.transcripts[this.botId]) this.readNew();
      if (s.live[this.botId] !== prev.live[this.botId]) this.syncWorking();
    });
  }

  /** Speak whatever new complete sentences the bot has written since the call started. */
  private readNew() {
    for (const r of this.callRows()) {
      const b = r.body;
      if (b.type === 'message' && b.role === 'assistant') {
        const s = this.spoken.get(r.seq) ?? { offset: 0, skipped: false };
        this.spoken.set(r.seq, s);
        const text = b.text ?? '';
        const end = b.streaming ? lastSentenceEnd(text) : text.length;
        if (end > s.offset) {
          const chunk = text.slice(s.offset, end);
          s.offset = end;
          if (!s.skipped) this.say(chunk, `a-${r.seq}`);
        }
        this.caption(`a-${r.seq}`, 'assistant', speakable(text), !b.streaming);
      } else if (b.type === 'card' && b.card === 'approval' && b.status === 'pending' && !this.announcedCards.has(r.seq)) {
        this.announcedCards.add(r.seq);
        const what = b.title.replace(/^Allow \S+ to /, '').replace(/\?$/, '');
        const byVoice = !b.mail && !!this.sess?.approvalsByVoice && !!b.approvalId && !!b.digest;
        // Only once this card has actually been read out does a spoken yes or no answer it, and only it.
        const card = byVoice ? { approvalId: b.approvalId as string, digest: b.digest as string } : null;
        this.say(`I need your OK to ${what}. ${byVoice ? 'Say yes to approve, or no to cancel.' : 'It is waiting for you on screen.'}`, 'approval', card ? () => { void this.bindWhenHeard(card); } : undefined);
      } else if (b.type === 'card' && b.card === 'question' && b.status === 'pending' && !this.announcedCards.has(r.seq)) {
        this.announcedCards.add(r.seq);
        this.say(`${b.question} The choices are on screen, or just tell me.`, 'question');
      }
    }
    this.syncThinking();
  }

  private syncWorking() {
    const live = useStore.getState().live[this.botId];
    setV({ working: live?.isRunning && this.lastTurn ? [{ seq: this.lastTurn.seq, request: this.lastTurn.text }] : [] });
    this.syncThinking();
  }

  private syncThinking() {
    const live = useStore.getState().live[this.botId];
    setV({ thinking: this.pendingTurns > 0 || (!!live?.isRunning && !this.player.playing) });
  }

  /** While the bot works in silence, say so now and then, so a quiet call doesn't feel dropped. */
  private statusUpdate() {
    if (this.ended) return;
    const live = useStore.getState().live[this.botId];
    if (!live?.isRunning || live.awaiting || this.player.playing || useVoice.getState().listening) return;
    const quietFor = Date.now() - Math.max(this.lastHeardAt, this.lastSpokeAt);
    const sinceStatus = Date.now() - this.lastStatusAt;
    if (quietFor < 9000 || sinceStatus < 25_000) return;
    this.lastStatusAt = Date.now();
    const detail = live.activity?.detail;
    this.say(detail ? `Still working on it, in ${detail}.` : 'Still working on it.', 'status');
  }

  private caption(id: string, role: Caption['role'], text: string, final: boolean) {
    if (!text) return;
    const caps = useVoice.getState().captions;
    const i = caps.findIndex((c) => c.id === id);
    if (i < 0) { setV({ captions: [...caps, { id, role, text, final }].slice(-200) }); return; }
    const copy = caps.slice();
    copy[i] = { ...caps[i], text, final };
    setV({ captions: copy });
  }

  transcript() {
    return useVoice.getState().captions.filter((c) => c.text.trim()).map((c) => ({ role: c.role, text: clip(c.text.trim(), 2000) }));
  }

  // ---------- teardown ----------

  end(error?: string) {
    if (this.ended) return;
    this.ended = true;
    window.removeEventListener('pagehide', this.onUnload);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.unsubStore?.();
    void this.wakeLock?.release().catch(() => {});
    this.mic?.stop();
    this.player.dispose();
    void this.ctx.close().catch(() => {});
    const transcript = this.transcript();
    if (this.sess) void voiceApi.end(this.botId, this.sess.callId, transcript, error).catch((e) => console.warn('[voice] end failed', e));
    if (current === this) current = null;
    if (error) {
      setV({ status: 'error', error, speaking: false, listening: false, thinking: false, working: [] });
      setTimeout(() => { if (useVoice.getState().status === 'error' && !current) setV({ status: 'idle', botId: null, error: null }); }, 6000);
    } else {
      setV({ status: 'idle', botId: null, callId: null, speaking: false, listening: false, thinking: false, working: [], startedAt: null });
    }
  }
}

// ---------- voice samples (play buttons in the voice settings) ----------

let sample: { audio: HTMLAudioElement; voice: string } | null = null;
const sampleListeners = new Set<(voice: string | null) => void>();
const announce = (v: string | null) => sampleListeners.forEach((f) => f(v));

/** Which voice's sample is playing, for the play/stop buttons. */
export function onSampleChange(f: (voice: string | null) => void): () => void {
  sampleListeners.add(f);
  return () => { sampleListeners.delete(f); };
}

export function stopSample(): void {
  if (!sample) return;
  sample.audio.pause();
  sample = null;
  announce(null);
}

/** Play a voice's sample clip; tapping the one that is playing stops it. Resolves when it ends. */
export function playSample(voice: string, speed = 1): Promise<void> {
  const same = sample?.voice === voice;
  stopSample();
  if (same) return Promise.resolve();
  const audio = new Audio(voiceApi.sampleUrl(voice, speed));
  const mine = { audio, voice };
  sample = mine;
  announce(voice);
  return new Promise<void>((resolve, reject) => {
    const done = (err?: Error) => {
      const current = sample === mine;
      if (current) { sample = null; announce(null); }
      // Stopped on purpose (another voice, or the same button again): not an error.
      if (err && current) reject(err); else resolve();
    };
    audio.onended = () => done();
    audio.onerror = () => done(new Error('Couldn’t play that voice. Is the speech server running?'));
    audio.play().catch((e) => done(e instanceof Error ? e : new Error(String(e))));
  });
}
