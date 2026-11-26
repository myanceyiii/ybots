// A voice call with a bot on the phone: the same call as on the web and Windows (web/src/voice/call.ts).
//
// The microphone is listened to on the phone (modules/cleft-voice: Android's voice-communication path,
// so the phone's echo cancellation keeps the bot's voice out of it). When you stop talking, what you
// said goes to the server as a WAV file, is transcribed by the server's own speech server and sent to
// the bot as a message. The bot's replies, as they stream into the chat, are spoken back sentence by
// sentence in the bot's voice (whatever voice the server offers; the phone only plays what it is sent).
// While it works the call says so now and then; an action waiting for your OK is read out, and when
// the server allows it you can answer that one card by saying yes or no. Talking over the bot stops
// it. "Goodbye" ends the call.
import { useSyncExternalStore } from 'react';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import type { Bot, Client, Row, VoiceSession } from '../api';
import { getLive, subscribeLive } from '../live';
import { nativeReason, voiceNative } from '../../modules/cleft-voice/src';
import { postRecording, UploadError, type Uploaded } from './upload';
import { speakable, lastSentenceEnd } from './speakable';

export interface Caption { id: string; role: 'user' | 'assistant'; text: string; final: boolean }
export type CallStatus = 'idle' | 'connecting' | 'live' | 'error';

export interface CallState {
  status: CallStatus;
  botId: string | null;
  muted: boolean;
  /** The bot's voice is playing. */
  speaking: boolean;
  /** You are talking (speech detected). */
  listening: boolean;
  /** What you said is being transcribed, or the bot has not answered yet. */
  thinking: boolean;
  /** What the bot is working on from the call, while it works. */
  working: string | null;
  captions: Caption[];
  error: string | null;
  startedAt: number | null;
}

const IDLE: CallState = { status: 'idle', botId: null, muted: false, speaking: false, listening: false, thinking: false, working: null, captions: [], error: null, startedAt: null };
let state: CallState = IDLE;
const listeners = new Set<() => void>();
const setV = (p: Partial<CallState>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useCall(): CallState { return useSyncExternalStore(subscribe, () => state); }
export const getCall = () => state;
export const isCallActive = (s: CallState = state) => s.status === 'connecting' || s.status === 'live';
/** Whether this phone can make calls (the app has the voice module; not the web preview). */
export const callsAvailable = voiceNative.available;

let current: VoiceCall | null = null;

/** Start a call with a bot. A call with another bot is ended first. */
export function startCall(api: Client, bot: Bot, rows: Row[]) {
  if (current && !current.ended) {
    if (current.botId === bot.id) return;
    current.end();
  }
  current = new VoiceCall(api, bot);
  current.rows = rows;
  void current.start();
}
export function endCall() { current?.end(); }
export function toggleMute() { current?.setMuted(!state.muted); }
export function dismissCallError() { if (state.status === 'error') setV({ ...IDLE }); }
/** Levels 0..1 for the speaking animation. */
export function callLevels(): { out: number; mic: number } {
  return current && !current.ended ? voiceNative.levels() : { out: 0, mic: 0 };
}
/** The app hands every change to a chat's rows here; the call reads the bot's new replies out. */
export function feedCallRows(botId: string, rows: Row[] | undefined) {
  if (current && !current.ended && current.botId === botId && rows) { current.rows = rows; current.readNew(); }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
interface Spoken { offset: number; skipped: boolean }
type Card = { approvalId: string; digest: string };

class VoiceCall {
  ended = false;
  rows: Row[] = [];
  readonly botId: string;
  private sess: VoiceSession | null = null;
  /** Bumped when you talk over the bot: speech fetched for an older generation is thrown away. */
  private gen = 0;
  private playChain: Promise<void> = Promise.resolve();
  private queued = 0;
  private spoken = new Map<number, Spoken>();
  private announcedCards = new Set<number>();
  /** The approval card whose "say yes or no" was last read out, and the one in play when you started speaking. */
  private heardCard: Card | null = null;
  private cardAtSpeech: Card | null = null;
  private lastHeardAt = 0;
  private lastSpokeAt = 0;
  private lastStatusAt = 0;
  private lastTurn: { seq: number; text: string } | null = null;
  private pendingTurns = 0;
  private subs: (() => void)[] = [];
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor(private api: Client, bot: Bot) { this.botId = bot.id; }

  async start() {
    setV({ ...IDLE, status: 'connecting', botId: this.botId });
    if (!voiceNative.available) { this.end('Voice calls only work in the Android app.'); return; }
    try {
      const p = await requestRecordingPermissionsAsync();
      if (!p.granted) { this.end('Microphone access is off for this app. Allow it in Android settings to talk to your bot.'); return; }
    } catch { /* asked below by Android itself */ }
    if (this.ended) return;
    try {
      this.sess = await this.api.voiceSession(this.botId);
    } catch (e) {
      this.end((e as Error).message || 'Could not start the call');
      return;
    }
    if (this.ended) { void this.api.voiceEnd(this.botId, this.sess.callId, [], 'Cancelled').catch(() => {}); return; }
    this.subs.push(
      voiceNative.on('onSpeechStart', () => this.speechStarted()),
      voiceNative.on('onUtterance', (e) => { setV({ listening: false }); if (e.path) void this.sendTurn(e.path); }),
      voiceNative.on('onPlayback', (e) => {
        if (e.playing) setV({ speaking: true });
        else { this.lastSpokeAt = Date.now(); setV({ speaking: false }); this.idleWaiters.splice(0).forEach((f) => f()); this.syncThinking(); }
      }),
      voiceNative.on('onError', (e) => { if (!this.ended) this.end(e.message); }),
      subscribeLive(() => this.syncWorking()),
    );
    try {
      voiceNative.start('call');
    } catch (e) {
      this.end(nativeReason(e, 'Could not open the microphone.'));
      return;
    }
    setV({ status: 'live', startedAt: Date.now() });
    void activateKeepAwakeAsync('cleft-call').catch(() => {});
    // Replies already in the chat are not read out; only what comes after the call started.
    this.markSpokenToEnd();
    this.statusTimer = setInterval(() => this.statusUpdate(), 2000);
    this.say(this.sess.greeting, 'greeting');
  }

  setMuted(m: boolean) {
    voiceNative.setMuted(m);
    setV({ muted: m, listening: false });
  }

  // ---------- you talking ----------

  private speechStarted() {
    if (this.ended) return;
    setV({ listening: true });
    this.cardAtSpeech = this.heardCard;
    // Talking over the bot: stop it, drop what it still had to say, and listen.
    if (state.speaking || this.queued > 0) {
      this.gen++;
      voiceNative.clear();
      for (const s of this.spoken.values()) s.skipped = true;
      this.markSpokenToEnd();
    }
  }

  private async sendTurn(path: string) {
    if (this.ended || !this.sess) { voiceNative.discard(path); return; }
    this.pendingTurns++;
    setV({ thinking: true });
    const card = this.cardAtSpeech;
    this.cardAtSpeech = null;
    try {
      let res: Uploaded;
      try {
        // The approval card the call had read out before you spoke: a spoken yes or no answers only that one.
        res = await postRecording(this.api, '/api/voice/turn', path, 'turn.wav', { botId: this.botId, callId: this.sess.callId, approvalId: card?.approvalId, digest: card?.digest });
      } catch (e) { throw new Error(e instanceof UploadError ? e.message : "couldn't reach the server"); }
      const r = (await res.json().catch(() => ({}))) as { text?: string; seq?: number; action?: string; reason?: string; error?: string };
      if (!res.ok) throw new Error(r.error || 'Could not hear that');
      if (this.ended || !r.text) return;
      this.lastHeardAt = Date.now();
      this.caption(`u-${Date.now()}`, 'user', r.text, true);
      if (r.action === 'hangup') { this.say('Okay, talk soon.', 'bye'); await this.playChain; await this.whenIdle(5000); this.end(); return; }
      if (r.action === 'review-card') { this.say(r.reason || 'Open the approval card in chat to review this action.', 'ack'); return; }
      if (r.action === 'approved' || r.action === 'declined') {
        if (card && this.heardCard?.approvalId === card.approvalId) this.heardCard = null;
        this.say(r.action === 'approved' ? 'Approved.' : 'Okay, cancelled.', 'ack');
        return;
      }
      if (r.seq) {
        this.lastTurn = { seq: r.seq, text: r.text };
        // A new request: older replies still streaming are not read out any more.
        this.markSpokenToEnd();
        this.syncWorking();
      }
    } catch (e) {
      const m = (e as Error).message;
      if (!this.ended) this.say(m.includes('reach the server') ? "Sorry, I can't reach the server right now, so I didn't hear that." : m.includes('read on this phone') ? "Sorry, the phone couldn't save what you said. Please say it again." : `Sorry, I didn't catch that. ${m.includes('speech server') ? 'The speech server is not answering.' : ''}`.trim(), 'error');
    } finally {
      voiceNative.discard(path);
      this.pendingTurns--;
      this.syncThinking();
    }
  }

  // ---------- the bot talking ----------

  /** Queue text to be spoken, in order, after anything already queued. */
  private say(text: string, captionId: string, onPlay?: () => void) {
    const clean = speakable(text);
    if (!clean || this.ended) return;
    const gen = this.gen;
    this.queued++;
    if (voiceNative.playStream) {
      // Queued on the phone now, in order, and played as it arrives: the first words play while the
      // rest of the sentence is still being made.
      const started = voiceNative.playStream(`${this.api.server}/api/voice/speak`, this.api.authHeader, { botId: this.botId, text: clean, stream: true }).catch(() => false);
      this.playChain = this.playChain.then(async () => {
        const ok = await started;
        this.queued--;
        if (!ok || this.ended || gen !== this.gen) return;
        this.lastSpokeAt = Date.now();
        onPlay?.();
      });
      if (!captionId.startsWith('a-')) this.caption(`${captionId}-${Date.now()}`, 'assistant', clean, true);
      return;
    }
    const audio = voiceNative.fetchAudio(`${this.api.server}/api/voice/speak`, this.api.authHeader, { botId: this.botId, text: clean }).catch(() => null);
    this.playChain = this.playChain.then(async () => {
      const path = await audio;
      this.queued--;
      if (!path) return;
      if (this.ended || gen !== this.gen) { voiceNative.discard(path); return; }
      voiceNative.play(path);
      this.lastSpokeAt = Date.now();
      onPlay?.();
    });
    if (!captionId.startsWith('a-')) this.caption(`${captionId}-${Date.now()}`, 'assistant', clean, true);
  }

  private whenIdle(maxMs: number): Promise<void> {
    if (!voiceNative.isPlaying()) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, maxMs);
      this.idleWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  private callRows(): Row[] {
    const start = this.sess?.startSeq ?? Infinity;
    return this.rows.filter((r) => r.seq > start).sort((a, b) => a.seq - b.seq);
  }

  private markSpokenToEnd() {
    for (const r of this.callRows()) {
      if (r.body?.type !== 'message' || r.body.role !== 'assistant') continue;
      this.spoken.set(r.seq, { offset: String(r.body.text ?? '').length, skipped: true });
    }
  }

  /** Speak whatever new complete sentences the bot has written since the call started. */
  readNew() {
    if (this.ended || !this.sess || state.status !== 'live') return;
    for (const r of this.callRows()) {
      const b = r.body;
      if (b?.type === 'message' && b.role === 'assistant') {
        const s = this.spoken.get(r.seq) ?? { offset: 0, skipped: false };
        this.spoken.set(r.seq, s);
        const text: string = b.text ?? '';
        const end = b.streaming ? lastSentenceEnd(text) : text.length;
        if (end > s.offset) {
          const chunk = text.slice(s.offset, end);
          s.offset = end;
          if (!s.skipped) this.say(chunk, `a-${r.seq}`);
        }
        this.caption(`a-${r.seq}`, 'assistant', speakable(text), !b.streaming);
      } else if (b?.type === 'card' && b.card === 'approval' && b.status === 'pending' && !this.announcedCards.has(r.seq)) {
        this.announcedCards.add(r.seq);
        const what = String(b.title ?? 'do something').replace(/^Allow \S+ to /, '').replace(/\?$/, '');
        const byVoice = !b.mail && !!this.sess?.approvalsByVoice && !!b.approvalId && !!b.digest;
        // Only once this card has been read out does a spoken yes or no answer it, and only it.
        const card = byVoice ? { approvalId: b.approvalId as string, digest: b.digest as string } : null;
        this.say(`I need your OK to ${what}. ${byVoice ? 'Say yes to approve, or no to cancel.' : 'It is waiting for you on screen.'}`, 'approval', card ? () => { this.heardCard = card; } : undefined);
      } else if (b?.type === 'card' && b.card === 'question' && b.status === 'pending' && !this.announcedCards.has(r.seq)) {
        this.announcedCards.add(r.seq);
        this.say(`${b.question} The choices are on screen, or just tell me.`, 'question');
      }
    }
    this.syncThinking();
  }

  private syncWorking() {
    if (this.ended) return;
    const live = getLive(this.botId);
    const working = live?.isRunning && this.lastTurn ? this.lastTurn.text : null;
    if (working !== state.working) setV({ working });
    this.syncThinking();
  }

  private syncThinking() {
    if (this.ended) return;
    const live = getLive(this.botId);
    const thinking = this.pendingTurns > 0 || (!!live?.isRunning && !state.speaking);
    if (thinking !== state.thinking) setV({ thinking });
  }

  /** While the bot works in silence, say so now and then, so a quiet call doesn't feel dropped. */
  private statusUpdate() {
    if (this.ended) return;
    const live = getLive(this.botId);
    if (!live?.isRunning || live.awaiting || state.speaking || state.listening) return;
    const quietFor = Date.now() - Math.max(this.lastHeardAt, this.lastSpokeAt);
    if (quietFor < 9000 || Date.now() - this.lastStatusAt < 25_000) return;
    this.lastStatusAt = Date.now();
    const detail = live.activity?.detail;
    this.say(detail ? `Still working on it, in ${detail}.` : 'Still working on it.', 'status');
  }

  private caption(id: string, role: Caption['role'], text: string, final: boolean) {
    if (!text) return;
    const caps = state.captions;
    const i = caps.findIndex((c) => c.id === id);
    if (i < 0) { setV({ captions: [...caps, { id, role, text, final }].slice(-200) }); return; }
    if (caps[i].text === text && caps[i].final === final) return;
    const copy = caps.slice();
    copy[i] = { ...caps[i], text, final };
    setV({ captions: copy });
  }

  private transcript() {
    return state.captions.filter((c) => c.text.trim()).map((c) => ({ role: c.role, text: clip(c.text.trim(), 2000) }));
  }

  // ---------- hanging up ----------

  end(error?: string) {
    if (this.ended) return;
    this.ended = true;
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.subs.splice(0).forEach((f) => f());
    try { voiceNative.end(); } catch { /* not started */ }
    deactivateKeepAwake('cleft-call');
    this.idleWaiters.splice(0).forEach((f) => f());
    const transcript = this.transcript();
    if (this.sess) void this.api.voiceEnd(this.botId, this.sess.callId, transcript, error).catch(() => {});
    if (current === this) current = null;
    if (error) {
      setV({ status: 'error', error, speaking: false, listening: false, thinking: false, working: null });
      setTimeout(() => { if (state.status === 'error' && !current) setV({ ...IDLE }); }, 8000);
    } else {
      setV({ ...IDLE });
    }
  }
}
