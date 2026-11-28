// The quick-ask card: `/?talk` in a browser, and the Windows app's Talk popup (Alt+Shift+L, the page
// /?talk&popup=1 in a small window at the bottom of the screen). The same as the phone's assistant card
// (mobile/src/assist/AssistCard.tsx):
//  - it listens at once, shows your words as you speak, and sends them by itself when you stop talking
//    (voice/quickAsk.ts EndOfSpeech); tap the mic to send sooner;
//  - the answer shows on the card, read out in the Bot's voice when you asked by voice;
//  - Share screen adds a picture of your screen only when pressed (Windows: the screen you are on; a browser
//    asks you which screen or window), shown on the card, removable before sending; Photo adds pictures;
//    you can type instead;
//  - Open in app goes on in the full chat.
// Everything goes to the one Bot (Leonard if there is one, else the main Bot; `/?talk=<bot id>` picks one).
// Nothing here can approve anything: an approval or a question waits in the chat, and the card says so.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Bot, ChatFile, Row } from '@shared/types';
import { useStore } from '../store';
import { api } from '../lib/api';
import { talkBot } from '../lib/talk';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { voiceApi } from '../voice/api';
import { createAudioContext, MicCapture, micErrorMessage, openMic, PcmPlayer, pcmToWav, wavPieces } from '../voice/audio';
import { rmsOf, type LiveText } from '../voice/liveDictation';
import { LiveEngine } from '../voice/liveEngine';
import { EndOfSpeech, replyAfter, SpeechQueue, type EndReason } from '../voice/quickAsk';
import { speakable } from '../voice/speakable';
import '../styles/quickask.css';

const RATE = 16000;
type Phase = 'idle' | 'listening' | 'sending' | 'waiting' | 'answer' | 'error';
interface Pic { name: string; blob: Blob; url: string; screen?: boolean }

export function QuickAsk({ wanted, popup, onOpenApp }: { wanted: string | null; popup: boolean; onOpenApp: (botId: string | null) => void }) {
  const bots = useStore((s) => s.bots);
  const bot = useMemo(() => talkBot(bots, wanted), [bots, wanted]);
  const transcript = useStore((s) => (bot ? s.transcripts[bot.id] : undefined));
  const live = useStore((s) => (bot ? s.live[bot.id] : undefined));
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [words, setWords] = useState<LiveText>({ settled: '', pending: '' });
  const [typed, setTyped] = useState('');
  const [asked, setAsked] = useState('');
  const [pics, setPics] = useState<Pic[]>([]);
  const [sentSeq, setSentSeq] = useState<number | null>(null);
  const [level, setLevel] = useState(0);
  const rec = useRef<{ ctx: AudioContext; mic: MicCapture; live: LiveEngine; end: EndOfSpeech; latest: LiveText; finishing: boolean } | null>(null);
  const out = useRef<{ ctx: AudioContext; player: PcmPlayer; chain: Promise<void>; gen: number } | null>(null);
  const spoken = useRef<SpeechQueue | null>(null);
  const byVoice = useRef(false);
  const card = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // ---- the Bot's voice ----
  const stopSpeaking = useCallback(() => { if (out.current) { out.current.gen++; out.current.player.clear(); } }, []);
  const say = useCallback((text: string) => {
    if (!bot) return;
    const clean = speakable(text);
    if (!clean) return;
    if (!out.current) { const ctx = createAudioContext(); out.current = { ctx, player: new PcmPlayer(ctx), chain: Promise.resolve(), gen: 0 }; }
    const o = out.current;
    const gen = o.gen;
    const ctl = new AbortController();
    const audio = voiceApi.speakStream(bot.id, clean, ctl.signal).catch(() => null);
    o.chain = o.chain.then(async () => {
      const res = await audio;
      if (!res || gen !== o.gen) { ctl.abort(); return; }
      try {
        for await (const piece of wavPieces(res)) {
          if (gen !== o.gen) { ctl.abort(); return; }
          if ('pcm' in piece) o.player.push(piece.pcm, piece.rate);
          else o.player.pushBuffer(await o.ctx.decodeAudioData(piece.whole));
        }
      } catch { /* cut off */ }
    });
  }, [bot]);

  // ---- listening, and sending when you stop talking ----
  const stopMic = useCallback(() => {
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    r.live.cancel();
    r.mic.stop();
    void r.ctx.close().catch(() => {});
  }, []);

  const sendRef = useRef<(text: string, voice: boolean) => Promise<void>>(async () => {});
  const finish = useCallback(async (why: EndReason | 'tap') => {
    const r = rec.current;
    if (!r || r.finishing) return;
    r.finishing = true;
    r.mic.stop();
    let text = '';
    if (why === 'nothing' && !r.end.heard) r.live.cancel();
    else { try { text = (await r.live.finish()).text.trim(); } catch { /* nothing written down */ } }
    void r.ctx.close().catch(() => {});
    rec.current = null;
    setLevel(0);
    if (!text) { setPhase((p) => (p === 'listening' ? (sentSeq !== null ? 'answer' : 'idle') : p)); setNote(why === 'nothing' ? 'I didn’t hear anything. Press the mic to talk, or type.' : 'I didn’t catch that. Press the mic to try again.'); return; }
    void sendRef.current(text, true);
  }, [sentSeq]);
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const listen = useCallback(async () => {
    if (rec.current || !bot) return;
    stopSpeaking();
    if (typeof AudioWorkletNode === 'undefined') { setNote('Talking isn’t supported in this browser. Type instead.'); return; }
    const ctx = createAudioContext();
    try {
      const stream = await openMic();
      const frames: Int16Array[] = [];
      const clip = (from: number, to: number) => {
        const part = frames.slice(from, to);
        const pcm = new Int16Array(part.reduce((n, f) => n + f.length, 0));
        let o = 0;
        for (const f of part) { pcm.set(f, o); o += f.length; }
        return voiceApi.transcribe(pcmToWav(pcm, RATE));
      };
      const opts = await voiceApi.options().catch(() => null);
      const socketUrl = opts?.live ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/voice/live` : null;
      const state = { ctx, mic: null as unknown as MicCapture, live: null as unknown as LiveEngine, end: new EndOfSpeech(), latest: { settled: '', pending: '' }, finishing: false };
      state.live = new LiveEngine({ socketUrl, clip, onText: (t) => { state.latest = t; setWords(t); } });
      state.mic = new MicCapture(ctx, stream, (pcm) => {
        if (state.finishing) return;
        frames.push(pcm);
        const lv = rmsOf(pcm);
        state.live.push(pcm, [lv]);
        const why = state.end.push([lv], `${state.latest.settled} ${state.latest.pending}`);
        if (why) void finishRef.current(why);
      }, RATE);
      await state.mic.start();
      if (ctx.state === 'suspended') { state.mic.stop(); void ctx.close(); setNote('Press the mic to talk.'); return; }
      rec.current = state;
      setWords({ settled: '', pending: '' });
      setNote(null);
      setPhase('listening');
    } catch (e) {
      void ctx.close().catch(() => {});
      setNote(micErrorMessage(e));
    }
  }, [bot, stopSpeaking]);

  // The mic wave.
  useEffect(() => {
    if (phase !== 'listening') return;
    const t = setInterval(() => setLevel(rec.current?.mic.level ?? 0), 90);
    return () => clearInterval(t);
  }, [phase]);

  // ---- sending ----
  const send = useCallback(async (text: string, voice: boolean) => {
    if (!bot) return;
    const words = text.trim();
    if (!words && !pics.length) return;
    stopSpeaking();
    setPhase('sending');
    setNote(null);
    setAsked(words);
    setTyped('');
    try {
      const files: ChatFile[] = [];
      for (const p of pics) files.push(await api.attach(bot.id, p.blob, p.name));
      const screen = pics.some((p) => p.screen) ? `\n\n(Shared my screen${popup ? ' from my PC' : ''}.)` : '';
      const r = await api.send(bot.id, (words || 'What do you make of this?') + screen, { attachments: files.map((f) => f.path), clientId: `talk-${crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}` });
      for (const p of pics) URL.revokeObjectURL(p.url);
      setPics([]);
      byVoice.current = voice;
      spoken.current = new SpeechQueue(r.row.seq);
      useStore.getState().upsertRows(bot.id, r.row.generation, [r.row]);
      setSentSeq(r.row.seq);
      setPhase('waiting');
    } catch (e) {
      setPhase('error');
      setNote((e as Error).message || 'That did not send.');
    }
  }, [bot, pics, popup, stopSpeaking]);
  sendRef.current = send;

  // ---- the answer ----
  const rows = useMemo(() => Object.values(transcript?.bySeq ?? {}) as Row[], [transcript]);
  const reply = useMemo(() => (sentSeq === null ? null : replyAfter(rows, sentSeq)), [rows, sentSeq]);
  const working = !!live?.isRunning;
  useEffect(() => {
    if (!reply) return;
    if (byVoice.current && spoken.current) for (const piece of spoken.current.feed(rows)) say(piece);
    if (phase === 'waiting' && (reply.text || reply.waiting) && !reply.streaming && !working) setPhase('answer');
  }, [reply, working]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- starting, again (the Windows popup shown again), and leaving ----
  const reset = useCallback(() => {
    stopMic(); stopSpeaking();
    setPhase('idle'); setNote(null); setAsked(''); setTyped(''); setSentSeq(null); setWords({ settled: '', pending: '' });
    setPics((l) => { for (const p of l) URL.revokeObjectURL(p.url); return []; });
  }, [stopMic, stopSpeaking]);
  const botKnown = !!bot;
  useEffect(() => { if (botKnown) void listen(); }, [botKnown]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const p = window.cleftShell?.talkPopup;
    if (!p) return;
    p.onStart(() => { reset(); setTimeout(() => { void listenRef.current(); }, 50); });
    p.onStop(() => { reset(); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const listenRef = useRef(listen);
  listenRef.current = listen;
  useEffect(() => () => { stopMic(); stopSpeaking(); void out.current?.ctx.close().catch(() => {}); }, [stopMic, stopSpeaking]);

  const close = useCallback(() => {
    reset();
    if (window.cleftShell?.talkPopup) void window.cleftShell.talkPopup.close();
    else onOpenApp(null);
  }, [reset, onOpenApp]);
  const openApp = () => {
    reset();
    if (window.cleftShell?.talkPopup) void window.cleftShell.talkPopup.openChat(bot?.id ?? null);
    else onOpenApp(bot?.id ?? null);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close]);

  // The Windows popup is as tall as the card.
  useLayoutEffect(() => {
    const el = card.current;
    const p = window.cleftShell?.talkPopup;
    if (!el || !p) return;
    const ro = new ResizeObserver(() => { void p.resize(Math.ceil(el.getBoundingClientRect().height) + 2); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- pictures ----
  const shareScreen = async () => {
    stopMic();
    if (phase === 'listening') setPhase(sentSeq !== null ? 'answer' : 'idle');
    try {
      let blob: Blob;
      const shell = window.cleftShell?.talkPopup;
      if (shell) {
        const got = await shell.captureScreen();
        blob = new Blob([Uint8Array.from(atob(got.data), (c) => c.charCodeAt(0))], { type: got.type });
      } else {
        if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('This browser can’t share the screen.');
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        try {
          const v = document.createElement('video');
          v.srcObject = stream; v.muted = true;
          await v.play();
          await new Promise((r) => setTimeout(r, 150));
          const c = document.createElement('canvas');
          c.width = v.videoWidth; c.height = v.videoHeight;
          c.getContext('2d')!.drawImage(v, 0, 0);
          blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('The screen could not be captured.'))), 'image/jpeg', 0.85));
        } finally { for (const t of stream.getTracks()) t.stop(); }
      }
      setPics((l) => [...l.filter((p) => !p.screen), { name: 'Screen.jpg', blob, url: URL.createObjectURL(blob), screen: true }]);
    } catch (e) {
      const n = (e as { name?: string })?.name;
      if (n !== 'NotAllowedError' && n !== 'AbortError') setNote((e as Error).message || 'The screen could not be captured.');
    }
  };
  const addPhotos = (files: FileList | null) => {
    void window.cleftShell?.talkPopup?.busy(false);
    if (!files) return;
    const add = Array.from(files).filter((f) => f.type.startsWith('image/')).slice(0, 4).map((f) => ({ name: f.name || 'Picture.jpg', blob: f as Blob, url: URL.createObjectURL(f) }));
    setPics((l) => [...l, ...add].slice(0, 5));
  };

  // ---- drawing ----
  const name = bot?.name ?? 'your Bot';
  const listening = phase === 'listening';
  const busy = phase === 'sending' || (phase === 'waiting' && !reply?.text);
  const canSend = !!typed.trim() || (!listening && pics.length > 0);
  const hasScreen = pics.some((p) => p.screen);

  return (
    <div className={`quickask${popup ? ' quickask--popup' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget && !popup) close(); }}>
      <div className="quickask__card" ref={card} role="dialog" aria-label={`Talk to ${name}`}>
        <div className="quickask__head">
          {bot ? <BotAvatarFor bot={bot as Bot} size={28} head still /> : <span style={{ width: 28 }} />}
          <span className="quickask__name">{name}</span>
          {bot && <button type="button" className="quickask__round" onClick={openApp} title="Open in app" aria-label="Open in app"><Icon name="expand" size={17} /></button>}
          <button type="button" className="quickask__round" onClick={close} title="Close (Esc)" aria-label="Close"><Icon name="close" size={17} /></button>
        </div>

        {(asked || reply) && !listening && (
          <div className="quickask__answer">
            {asked && <div className="quickask__asked">{asked}</div>}
            {reply?.text && <Markdown text={reply.text} />}
            {reply?.waiting && (
              <button type="button" className="quickask__waiting" onClick={openApp}>
                <strong>{name} is waiting on you</strong>
                <span>{reply.waiting} Answer it in the app: Open in app.</span>
              </button>
            )}
          </div>
        )}
        {busy && <div className="quickask__status"><span className="quickask__dots" aria-hidden />{phase === 'sending' ? 'Sending…' : live?.caption || `${name} is thinking…`}</div>}
        {listening && (
          <div className="quickask__words" aria-live="polite">
            {words.settled || words.pending ? <>{words.settled}{words.settled && words.pending ? ' ' : ''}<span className="quickask__pending">{words.pending}</span></> : <span className="quickask__pending">Listening…</span>}
          </div>
        )}
        {!bot && <div className="quickask__note">There is no Bot to talk to yet.</div>}
        {note && <div className={`quickask__note${phase === 'error' ? ' quickask__note--bad' : ''}`}>{note}</div>}

        <div className="quickask__chips">
          {!hasScreen && bot && <button type="button" className="quickask__chip" onClick={() => void shareScreen()}><Icon name="monitor" size={15} />Share screen</button>}
          {pics.map((p, i) => (
            <span key={p.url} className="quickask__pic">
              <img src={p.url} alt="" />
              <span>{p.screen ? 'Your screen' : p.name}</span>
              <button type="button" aria-label={`Remove ${p.screen ? 'your screen' : p.name}`} onClick={() => setPics((l) => { URL.revokeObjectURL(l[i].url); return l.filter((_, j) => j !== i); })}><Icon name="close" size={13} /></button>
            </span>
          ))}
        </div>

        <div className="quickask__bar">
          <button type="button" className="quickask__round" title="Add a photo" aria-label="Add a photo" onClick={() => { stopMic(); if (listening) setPhase(sentSeq !== null ? 'answer' : 'idle'); void window.cleftShell?.talkPopup?.busy(true); fileInput.current?.click(); }}><Icon name="image" size={18} /></button>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { addPhotos(e.target.files); e.target.value = ''; }} />
          <div className="quickask__field">
            {listening ? (
              <div className="quickask__wave" aria-label="Listening">{Array.from({ length: 18 }, (_, i) => <span key={i} style={{ height: `${Math.max(3, Math.round(22 * Math.min(1, Math.sqrt(level) * 1.6 * (0.6 + 0.4 * Math.sin(i * 1.7 + Date.now() / 180)))))}px` }} />)}</div>
            ) : (
              <input value={typed} onChange={(e) => setTyped(e.target.value)} onFocus={() => stopSpeaking()} placeholder={`Ask ${name}`} aria-label={`Ask ${name}`}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && canSend) { e.preventDefault(); void send(typed, false); } }} />
            )}
          </div>
          {canSend && !listening ? (
            <button type="button" className="quickask__big" onClick={() => void send(typed, false)} aria-label="Send" title="Send"><Icon name="arrow_up" size={19} /></button>
          ) : (
            <button type="button" className={`quickask__big${listening ? ' quickask__big--on' : ''}`} onClick={() => { if (listening) void finish('tap'); else void listen(); }}
              aria-label={listening ? 'Done talking' : 'Talk'} title={listening ? 'Done talking (sends now)' : 'Talk'}>
              <Icon name={listening ? 'check' : 'mic'} size={19} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
