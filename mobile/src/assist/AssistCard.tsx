// The assistant card (Android): what the phone's assistant gesture shows when YBots is the
// default digital assistant. A card at the bottom of whatever app is open, as Google's assistant does it,
// drawn in its own see-through screen (modules/cleft-assist, AssistActivity):
//  - it starts listening at once (Settings › Phone assistant › Start listening), shows your words as you
//    speak, and sends them by itself when you stop talking (voice/quickAsk.ts EndOfSpeech);
//  - the answer appears on the card and is read out in the Bot's voice when you asked by voice;
//  - Share screen adds the screenshot Android took of the app underneath, only when you tap it, and you can
//    take it off again before sending; Photos and Camera add pictures; you can type instead;
//  - Open in app goes on in the Bot's chat; tapping above the card, Back or Home closes it.
// Everything goes to the one Bot this card talks to. Nothing here can approve anything: an approval or a
// question the Bot asks waits for you in the app, and the card says so.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Dimensions, Image, Keyboard, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { toByteArray } from 'base64-js';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import { client, loadSession, type Bot, type ChatFile, type Client, type Row } from '../api';
import { assistantBot, assistantPrefs } from '../assist';
import { BotAvatar } from '../components/BotAvatar';
import { Icon, type IconName } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { MicWave } from '../components/MicWave';
import { pick, type Picked } from '../components/Attachments';
import { applyScheme, color, useScheme } from '../theme';
import type { LiveState } from '../poses';
import { nativeReason, voiceNative } from '../../modules/cleft-voice/src';
import { assistNative, type AssistState } from '../../modules/cleft-assist/src';
import { LiveEngine } from '../voice/liveEngine';
import { transcribe } from '../voice/dictation';
import type { LiveText } from '../voice/liveDictation';
import { EndOfSpeech, replyAfter, SpeechQueue, type EndReason } from '../voice/quickAsk';
import { speakable } from '../voice/speakable';

type Phase = 'loading' | 'signin' | 'idle' | 'listening' | 'sending' | 'waiting' | 'answer' | 'error';

const POLL_MS = 150;
const linkScheme = 'cleftbot';

export default function AssistRoot() {
  return <SafeAreaProvider><AssistCard /></SafeAreaProvider>;
}

function AssistCard() {
  applyScheme(useScheme().scheme);
  const insets = useSafeAreaInsets();
  const [api, setApi] = useState<Client | null>(null);
  const [bot, setBot] = useState<Bot | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [note, setNote] = useState<string | null>(null);
  const [words, setWords] = useState<LiveText>({ settled: '', pending: '' });
  const [typed, setTyped] = useState('');
  const [asked, setAsked] = useState('');
  const [rows, setRows] = useState<Record<number, Row>>({});
  const [live, setLive] = useState<LiveState | null>(null);
  const [screen, setScreen] = useState<AssistState>(assistNative.state());
  const [shareScreen, setShareScreen] = useState(false);
  const [photos, setPhotos] = useState<Picked[]>([]);
  const [sentSeq, setSentSeq] = useState<number | null>(null);
  const [kb, setKb] = useState(0);
  const listenRef = useRef<{ engine: LiveEngine; poll: ReturnType<typeof setInterval>; end: EndOfSpeech; seen: number; finishing: boolean } | null>(null);
  const spoken = useRef<SpeechQueue | null>(null);
  const speakOut = useRef(false);
  const alive = useRef(true);

  // ---- leaving ----
  const stopVoice = useCallback(() => {
    const l = listenRef.current;
    listenRef.current = null;
    if (l) { clearInterval(l.poll); l.engine.cancel(); try { const p = voiceNative.stop(); if (p) voiceNative.discard(p); } catch { /* not started */ } }
    try { voiceNative.clear(); } catch { /* nothing playing */ }
  }, []);
  const close = useCallback(() => { stopVoice(); assistNative.close(); }, [stopVoice]);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true; });
    const a = Keyboard.addListener('keyboardDidShow', (e) => setKb(e.endCoordinates.height));
    const b = Keyboard.addListener('keyboardDidHide', () => setKb(0));
    return () => { alive.current = false; sub.remove(); a.remove(); b.remove(); stopVoice(); };
  }, [close, stopVoice]);

  // ---- the screenshot Android took (kept on the phone until Share screen is tapped) ----
  useEffect(() => {
    const s = assistNative.onScreen((st) => setScreen(st));
    // A new press while the card was open starts over.
    const i = assistNative.onInvoke(() => { setScreen(assistNative.state()); setShareScreen(false); });
    return () => { s.remove(); i.remove(); };
  }, []);

  // ---- who this card talks to, and the live event stream for its answers ----
  useEffect(() => {
    let closeEvents: (() => void) | null = null;
    (async () => {
      const s = await loadSession();
      if (!s) { setPhase('signin'); return; }
      const a = client(s);
      setApi(a);
      let list: Bot[] = [];
      let lives: LiveState[] = [];
      try { const r = await a.bots(); list = r.bots; lives = r.live; } catch (e) { setPhase('error'); setNote((e as Error).message || 'Could not reach your server.'); return; }
      const b = assistantBot(list);
      if (!b) { setPhase('error'); setNote('There is no Bot to talk to yet.'); return; }
      if (!alive.current) return;
      setBot(b);
      setLive(lives.find((l) => l.botId === b.id) ?? null);
      closeEvents = a.events((ev) => {
        if (ev.type === 'rows' && ev.botId === b.id) setRows((all) => { const n = { ...all }; for (const r of ev.rows as Row[]) n[r.seq] = r; return n; });
        else if (ev.type === 'live' && ev.state?.botId === b.id) setLive(ev.state);
      });
      setPhase('idle');
      if (assistantPrefs().listen) void startListening(a, b);
    })();
    return () => { closeEvents?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- listening, and sending when you stop talking ----
  const startListening = useCallback(async (a: Client | null = api, b: Bot | null = bot) => {
    if (!a || !b || listenRef.current) return;
    try { voiceNative.clear(); } catch { /* nothing playing */ }
    if (!voiceNative.available || !voiceNative.liveDictation) { setNote('Talking needs a newer build of the app. Type instead.'); return; }
    const p = await requestRecordingPermissionsAsync().catch(() => null);
    if (p && !p.granted) { setNote('Microphone access is off for this app. Allow it in Android settings, or type instead.'); return; }
    try { voiceNative.start('dictate'); } catch (e) { setNote(nativeReason(e, 'Could not open the microphone.')); return; }
    setWords({ settled: '', pending: '' });
    setNote(null);
    const clip = async (from: number, to: number) => {
      const path = voiceNative.dictationClip(from, to);
      if (!path) return '';
      try { return await transcribe(a, path); } finally { voiceNative.discard(path); }
    };
    const opts = voiceNative.liveStream ? await a.voiceOptions().catch(() => null) : null;
    const sock = opts?.live ? a.liveSocket() : null;
    const WS = WebSocket as unknown as new (url: string, protocols: string[] | undefined, o: { headers: Record<string, string> }) => WebSocket;
    let latest: LiveText = { settled: '', pending: '' };
    const engine = new LiveEngine({ socketUrl: sock?.url ?? null, openSocket: (u) => new WS(u, undefined, { headers: sock!.headers }), clip, onText: (t) => { latest = t; setWords(t); } });
    const end = new EndOfSpeech();
    const state = { engine, end, seen: 0, finishing: false, poll: 0 as unknown as ReturnType<typeof setInterval> };
    state.poll = setInterval(() => {
      try {
        const levels = voiceNative.dictationLevels(state.seen);
        if (!levels.length) return;
        const b64 = engine.mode === 'live' ? voiceNative.dictationPcm(state.seen) : '';
        state.seen += levels.length;
        const bytes = b64 ? toByteArray(b64) : null;
        engine.push(bytes ? new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2)) : null, levels);
        const why = end.push(levels, `${latest.settled} ${latest.pending}`);
        if (why) void finishRef.current(why);
      } catch { /* stopped */ }
    }, POLL_MS);
    listenRef.current = state;
    setPhase('listening');
  }, [api, bot]); // eslint-disable-line react-hooks/exhaustive-deps

  const finishListening = useCallback(async (why: EndReason | 'tap') => {
    const l = listenRef.current;
    if (!l || l.finishing) return;
    l.finishing = true;
    clearInterval(l.poll);
    const heard = l.end.heard || why === 'tap';
    let text = '';
    if (why === 'nothing' && !l.end.heard) l.engine.cancel();
    else { try { text = (await l.engine.finish()).text.trim(); } catch { /* nothing written down */ } }
    try { const p = voiceNative.stop(); if (p) voiceNative.discard(p); } catch { /* already stopped */ }
    listenRef.current = null;
    if (!alive.current) return;
    if (!heard || !text) { setPhase(sentSeq !== null ? 'answer' : 'idle'); setNote(why === 'nothing' ? 'I didn’t hear anything. Tap the mic to talk, or type.' : 'I didn’t catch that. Tap the mic to try again.'); return; }
    void sendRef.current(text, true);
  }, [sentSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- sending ----
  const send = useCallback(async (text: string, byVoice: boolean) => {
    if (!api || !bot) return;
    const words = text.trim();
    if (!words && !photos.length && !(shareScreen && screen.screenshot)) return;
    setPhase('sending');
    setNote(null);
    setAsked(words);
    setTyped('');
    Keyboard.dismiss();
    try {
      const files: ChatFile[] = [];
      if (shareScreen && screen.screenshot) files.push(await api.attach(bot.id, screen.screenshot, `Screen ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.jpg`));
      for (const p of photos) files.push(await api.attach(bot.id, p.uri, p.name));
      // What the shared screen is, so the Bot knows without being told.
      const extra = shareScreen && screen.screenshot ? `\n\n(Shared my screen from the phone${screen.pageUrl ? `: ${screen.pageUrl}` : ''}.)` : '';
      const r = await api.send(bot.id, (words || 'What do you make of this?') + extra, { attachments: files.map((f) => f.path), clientId: `assist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
      if (!alive.current) return;
      // Pictures go once: a follow-up does not send them again.
      if (shareScreen) { setShareScreen(false); assistNative.dropScreenshot(); }
      setPhotos([]);
      speakOut.current = byVoice;
      spoken.current = new SpeechQueue(r.row.seq);
      setSentSeq(r.row.seq);
      setPhase('waiting');
      // Whatever the stream sent before the send was answered, and after.
      api.rows(bot.id).then((x) => setRows((all) => { const n = { ...all }; for (const row of x.rows) n[row.seq] = row; return n; })).catch(() => {});
    } catch (e) {
      if (!alive.current) return;
      setPhase('error');
      setNote((e as Error).message || 'That did not send.');
    }
  }, [api, bot, photos, shareScreen, screen]);

  const finishRef = useRef(finishListening);
  finishRef.current = finishListening;
  const sendRef = useRef(send);
  sendRef.current = send;

  // ---- the answer ----
  const list = useMemo(() => Object.values(rows), [rows]);
  const reply = useMemo(() => (sentSeq === null ? null : replyAfter(list, sentSeq)), [list, sentSeq]);
  const working = !!live?.isRunning;
  useEffect(() => {
    if (!reply || !api || !bot) return;
    if (speakOut.current && spoken.current && voiceNative.playStream) {
      for (const piece of spoken.current.feed(list)) {
        const say = speakable(piece);
        if (!say) continue;
        voiceNative.setMedia?.(true);
        void voiceNative.playStream(`${api.server}/api/voice/speak`, api.authHeader, { botId: bot.id, text: say, stream: true }).catch(() => false);
      }
    }
    if ((phase === 'waiting') && (reply.text || reply.waiting) && !reply.streaming && !working) setPhase('answer');
  }, [reply, working]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- pictures ----
  const addPictures = async (source: 'photos' | 'camera') => {
    stopVoice();
    if (phase === 'listening') setPhase(sentSeq !== null ? 'answer' : 'idle');
    assistNative.keepOpen(true);
    try { const got = await pick(source); setPhotos((l) => [...l, ...got].slice(0, 4)); } catch (e) { setNote((e as Error).message); } finally { assistNative.keepOpen(false); }
  };

  const openInApp = () => { stopVoice(); if (bot) assistNative.openApp(`${linkScheme}://ask?bot=${encodeURIComponent(bot.id)}`); else assistNative.openApp(`${linkScheme}://assist`); };

  // ---- drawing ----
  const name = bot?.name ?? 'your Bot';
  const maxAnswer = Dimensions.get('window').height * 0.42;
  const listening = phase === 'listening';
  const busy = phase === 'sending' || (phase === 'waiting' && !reply?.text);
  const canSend = !!typed.trim() || (!listening && (photos.length > 0 || (shareScreen && !!screen.screenshot)));

  return (
    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
      {/* Above the card: the app you were in. A tap there closes the card. */}
      <Pressable accessibilityLabel="Close" onPress={close} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.18)' }} />
      <View style={{ marginHorizontal: 8, marginBottom: Math.max(insets.bottom, 8) + kb, backgroundColor: color.surface, borderRadius: 28, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12, gap: 10, elevation: 12, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 16 }}>
        {/* Who you are talking to, Open in app, close */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {bot && api ? <BotAvatar bot={bot} size={28} server={api.server} auth={api.authHeader} crop="portrait" /> : <View style={{ width: 28, height: 28 }} />}
          <Text style={{ flex: 1, fontSize: 16, fontWeight: '600', color: color.ink }} numberOfLines={1}>{name}</Text>
          {bot && <Round icon="expand" label="Open in app" onPress={openInApp} />}
          <Round icon="close" label="Close" onPress={close} />
        </View>

        {/* What you said, and the answer */}
        {(asked || reply) && phase !== 'listening' && (
          <ScrollView style={{ maxHeight: maxAnswer }} contentContainerStyle={{ gap: 8 }}>
            {!!asked && <Text style={{ fontSize: 14, color: color.inkMuted }} numberOfLines={3}>{asked}</Text>}
            {reply?.text ? <Markdown text={reply.text} /> : null}
            {reply?.waiting && (
              <Pressable onPress={openInApp} accessibilityRole="button" style={{ backgroundColor: color.fill, borderRadius: 14, padding: 12, gap: 4 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: color.ink }}>{name} is waiting on you</Text>
                <Text style={{ fontSize: 13, color: color.inkSecondary }}>{reply.waiting} Answer it in the app: Open in app.</Text>
              </Pressable>
            )}
          </ScrollView>
        )}
        {busy && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator size="small" color={color.inkSecondary} />
            <Text style={{ fontSize: 14, color: color.inkSecondary, flex: 1 }} numberOfLines={2}>{phase === 'sending' ? 'Sending…' : live?.caption || `${name} is thinking…`}</Text>
          </View>
        )}
        {listening && (
          <View style={{ gap: 4, minHeight: 44 }}>
            <Text style={{ fontSize: 20, lineHeight: 27, color: color.ink }}>
              {words.settled || words.pending ? <>{words.settled}{words.settled && words.pending ? ' ' : ''}<Text style={{ color: color.inkMuted }}>{words.pending}</Text></> : <Text style={{ color: color.inkMuted }}>Listening…</Text>}
            </Text>
          </View>
        )}
        {phase === 'signin' && <Text style={{ fontSize: 15, color: color.ink }}>Sign in to YBots first. Open the app to scan your sign-in code.</Text>}
        {!!note && <Text style={{ fontSize: 13, color: phase === 'error' ? color.problemInk : color.inkSecondary }}>{note}</Text>}

        {/* Things that go with the next message: the screen (only once tapped) and pictures */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {shareScreen && screen.screenshot ? (
            <Attached uri={screen.screenshot} label="Your screen" onRemove={() => { setShareScreen(false); }} />
          ) : bot && phase !== 'signin' ? (
            <Chip icon="monitor" label={screen.screen === 'waiting' ? 'Getting screen…' : 'Share screen'} onPress={() => {
              if (screen.screenshot) { setShareScreen(true); return; }
              if (screen.screen === 'waiting') return;
              setNote(screen.screen === 'blocked'
                ? 'The app on screen doesn’t allow screenshots, so there is nothing to share.'
                : 'Android didn’t give a screenshot. Turn on “Use screenshot” for the assistant in Android settings, then try again.');
            }} />
          ) : null}
          {photos.map((p, i) => <Attached key={`${p.uri}-${i}`} uri={p.uri} label={p.name} onRemove={() => setPhotos((l) => l.filter((_, j) => j !== i))} />)}
          {phase !== 'signin' && !shareScreen && !screen.screenshot && screen.screen !== 'waiting' && note?.includes('Use screenshot') && (
            <Chip icon="sliders" label="Android settings" onPress={() => { stopVoice(); assistNative.openSettings(); }} />
          )}
        </View>

        {/* Pictures, type instead, the mic (or send) */}
        {phase === 'signin' ? (
          <Pressable accessibilityRole="button" onPress={() => assistNative.openApp(`${linkScheme}://assist`)} style={{ backgroundColor: color.primary, borderRadius: 22, paddingVertical: 12, alignItems: 'center' }}>
            <Text style={{ color: color.onPrimary, fontSize: 15, fontWeight: '600' }}>Open YBots</Text>
          </Pressable>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Round icon="image" label="Add a photo" onPress={() => void addPictures('photos')} />
            <Round icon="camera" label="Take a photo" onPress={() => void addPictures('camera')} />
            <View style={{ flex: 1, minHeight: 44, borderRadius: 22, backgroundColor: color.fill, paddingHorizontal: 14, justifyContent: 'center' }}>
              {listening ? (
                <MicWave level={() => voiceNative.levels().mic} busy={false} />
              ) : (
                <TextInput value={typed} onChangeText={setTyped} placeholder={`Ask ${name}`} placeholderTextColor={color.inkMuted}
                  onFocus={() => { stopVoice(); }} multiline style={{ fontSize: 16, color: color.ink, maxHeight: 110, paddingVertical: 8 }}
                  accessibilityLabel={`Ask ${name}`} />
              )}
            </View>
            {canSend && !listening ? (
              <Big icon="send" label="Send" onPress={() => void send(typed, false)} />
            ) : (
              <Big icon={listening ? 'check' : 'mic'} label={listening ? 'Done talking' : 'Talk'} active={listening}
                onPress={() => { if (listening) void finishListening('tap'); else void startListening(); }} />
            )}
          </View>
        )}
      </View>
    </View>
  );
}

function Round({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={6}
      style={({ pressed }) => ({ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.pressed : 'transparent' })}>
      <Icon name={icon} size={21} color={color.inkSecondary} />
    </Pressable>
  );
}

function Big({ icon, label, onPress, active }: { icon: IconName; label: string; onPress: () => void; active?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => ({ width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? color.danger : color.primary, opacity: pressed ? 0.8 : 1 })}>
      <Icon name={icon} size={22} color={color.onPrimary} />
    </Pressable>
  );
}

function Chip({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 16, borderWidth: 1, borderColor: color.secondaryBorder, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: pressed ? color.pressed : 'transparent' })}>
      <Icon name={icon} size={16} color={color.ink} />
      <Text style={{ fontSize: 14, color: color.ink }}>{label}</Text>
    </Pressable>
  );
}

function Attached({ uri, label, onRemove }: { uri: string; label: string; onRemove: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, backgroundColor: color.fill, paddingLeft: 4, paddingRight: 2, paddingVertical: 4, maxWidth: 220 }}>
      <Image source={{ uri }} style={{ width: 34, height: 34, borderRadius: 9, backgroundColor: color.secondaryButton }} />
      <Text style={{ fontSize: 13, color: color.ink, flexShrink: 1 }} numberOfLines={1}>{label}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${label}`} onPress={onRemove} hitSlop={8} style={{ padding: 6 }}>
        <Icon name="close" size={15} color={color.inkSecondary} />
      </Pressable>
    </View>
  );
}
