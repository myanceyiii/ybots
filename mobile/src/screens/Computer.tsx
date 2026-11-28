import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, Keyboard, Pressable, Text, View } from 'react-native';
import * as NavigationBar from 'expo-navigation-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { Bot, Client, ComputerState } from '../api';
import { BotAvatar } from '../components/BotAvatar';
import { Icon } from '../components/Icon';
import { Header, RoundButton, Sheet, SheetRow } from '../components/ui';
import { ScreenLink, type LinkEnd, type ToPage } from '../screenLink';
import { screenFailureText, screenRetryDelay } from '../screenRetry';
import { botColor, color } from '../theme';
import { runClip } from '../remoteClip';
import { SCREEN_PAGE } from '../vnc/page.generated';
import { useTeach } from './TeachReview';

type Mode = 'watch' | 'control';
type Conn = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';
type Phase = 'live' | 'switching' | 'waking' | 'asleep' | 'error';

const HELP_KEY = 'cleftbot.screenHelpSeen';
/** Where the screen page pretends to live. `.invalid` never resolves, so nothing can be loaded from it. */
const PAGE_BASE = 'https://screen.cleft.invalid/';

export function statusText(c: ComputerState | null): string {
  switch (c?.status) {
    case 'running': return 'Awake';
    case 'starting': case 'resuming': return 'Waking up…';
    case 'creating': return 'Setting up…';
    case 'suspending': return 'Going to sleep…';
    case 'error': return 'Unreachable';
    default: return 'Asleep';
  }
}

/** The bot's colour as a button on the dark screen. Black and grey bots get a white button. */
function actionColors(bot: Bot): { action: string; onAction: string } {
  const fill = botColor[bot.avatarColor];
  if (!fill || bot.avatarColor === 'black' || bot.avatarColor === 'gray') return { action: '#FFFFFF', onAction: '#111111' };
  return { action: fill, onAction: '#FFFFFF' };
}

/**
 * A bot's computer, as in the web app's large view: its live screen (noVNC in a WebView, see vnc/page.js),
 * watched by default. "Take control" reconnects in control mode and brings up the touch bar under the
 * picture: tap to click, hold or two-finger tap to right-click, two fingers to scroll, Keyboard, Keys, Zoom,
 * full screen and Hand back. Full screen hides the header and the system bars, and the view turns with the
 * phone, so an unfolded foldable or a phone on its side shows the desktop large.
 */
export function Computer({ api, bot, onBack, onTeachReview }: { api: Client; bot: Bot; onBack: () => void; /** Teach a bot: open the review after Stop. */ onTeachReview?: () => void }) {
  const web = useRef<React.ComponentRef<typeof WebView>>(null);
  const link = useRef<ScreenLink | null>(null);
  const box = useRef<React.ComponentRef<typeof View>>(null);
  const hadFrame = useRef(false);
  const autoWoke = useRef(false);
  const helpSeen = useRef(false);
  // Quiet retries: failures since the screen last showed, how the last link ended, and the pending retry.
  const failures = useRef(0);
  const lastEnd = useRef<LinkEnd | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Names each connection given to the page; a report about an earlier one is ignored.
  const sid = useRef(0);

  const [computer, setComputer] = useState<ComputerState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('watch');
  const [conn, setConn] = useState<Conn>('idle');
  const [attempt, setAttempt] = useState(0);
  const [pageReady, setPageReady] = useState(false);
  const [pageKey, setPageKey] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [waking, setWaking] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  // Teach a bot (server/src/teach.ts): Record what you do in the bot's browser while you drive; Stop opens the review.
  const teach = useTeach(api, bot.id);
  const [teachBusy, setTeachBusy] = useState(false);
  const recording = teach.state?.recording?.status === 'recording';
  const canTeach = !!onTeachReview && !!teach.state && !teach.state.blocked && !bot.outside;
  const teachSteps = teach.state?.recording?.steps.length ?? 0;
  const toggleRecord = async () => {
    setTeachBusy(true);
    try {
      if (recording) { teach.setState(await api.teachStop(bot.id)); onTeachReview?.(); }
      else teach.setState(await api.teachStart(bot.id));
    } catch (e: any) { Alert.alert(recording ? 'Couldn’t stop recording' : 'Couldn’t start recording', e?.message ?? 'Try again.'); } finally { setTeachBusy(false); }
  };
  const [kbPad, setKbPad] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const connRef = useRef<Conn>('idle');
  connRef.current = conn;
  const [cause, setCause] = useState<string | null>(null);

  const status = computer?.status;
  const running = status === 'running';
  const busy = status === 'creating' || status === 'starting' || status === 'resuming';
  const wantLive = running && pageReady;
  const driving = mode === 'control';
  const { action, onAction } = actionColors(bot);

  useKeepAwake();

  const toPage = useCallback((m: object) => {
    web.current?.injectJavaScript(`window.__cleft && window.__cleft(${JSON.stringify(m)});true;`);
  }, []);

  // The computer's state, checked every few seconds while this screen is open.
  const load = useCallback(async () => {
    try { setComputer((await api.computer()).computer); setLoadError(null); }
    catch (e: any) { setLoadError(e?.message || 'Couldn’t reach your server.'); }
  }, [api]);
  useEffect(() => {
    load();
    const t = setInterval(load, running ? 8000 : 3000);
    return () => clearInterval(t);
  }, [load, running]);

  const wake = useCallback(() => {
    setWaking(true); setWakeError(null);
    api.ensureComputer()
      .then((r) => setComputer(r.computer))
      .catch((e: Error) => setWakeError(e.message || 'The computer did not start.'))
      .finally(() => setWaking(false));
  }, [api]);

  // Opening the computer is a request to see it, so wake it without another tap.
  useEffect(() => {
    if (autoWoke.current || !computer) return;
    if (status === 'suspended' || status === 'stopped' || status === 'absent') { autoWoke.current = true; wake(); }
  }, [computer, status, wake]);

  useEffect(() => { SecureStore.getItemAsync(HELP_KEY).then((v) => { helpSeen.current = v === '1'; }).catch(() => {}); }, []);

  // The screen socket: opened by the app, bridged into the page.
  useEffect(() => {
    if (!wantLive) { setConn('idle'); return; }
    setConn('connecting');
    sid.current += 1;
    toPage({ t: 'start', sid: sid.current, clip: mode === 'control', mode, zoom: false, help: mode === 'control' && !helpSeen.current, fullscreen, name: bot.name, action, onAction });
    const { url, headers } = api.screenSocket(bot.id, mode);
    lastEnd.current = null;
    const l = new ScreenLink(url, headers, (m: ToPage) => toPage(m), (e) => { if (link.current === l) lastEnd.current = e; });
    link.current = l;
    return () => {
      l.close();
      if (link.current === l) link.current = null;
      toPage({ t: 'stop' });
    };
    // fullscreen and colours are sent on their own; a change there must not reconnect.
  }, [api, bot.id, wantLive, mode, attempt, pageKey, toPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const handBack = useCallback(() => {
    setMode('watch');
    // The bot carries on either way; this only tells it sooner.
    api.handback(bot.id).catch(() => {});
  }, [api, bot.id]);

  const clearRetry = () => { if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null; } };
  useEffect(() => clearRetry, []);

  // The link failed or dropped: try again quietly a few times before saying so (screenRetry.ts).
  const onDrop = (s: 'error' | 'disconnected', why?: string) => {
    const text = screenFailureText({ ...(lastEnd.current ?? {}), why });
    const wait = screenRetryDelay(failures.current);
    if (wait === null) {
      setRetrying(false);
      setCause(text);
      setConn(s);
      const e = lastEnd.current;
      api.screenProblem(bot.id, { tries: failures.current + 1, cause: text, code: e?.code, opened: e?.opened, ms: e?.ms }).catch(() => {});
      return;
    }
    failures.current += 1;
    setRetrying(true);
    clearRetry();
    retryTimer.current = setTimeout(() => { retryTimer.current = null; setAttempt((n) => n + 1); }, wait);
  };

  // Back from the background (the phone slept, or switched networks): a screen that gave up tries again.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') return;
      if (connRef.current === 'error' || connRef.current === 'disconnected') { failures.current = 0; setCause(null); setAttempt((n) => n + 1); }
    });
    return () => sub.remove();
  }, []);

  // Leaving while driving hands the screen back, as closing the web app's view does.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => () => { if (modeRef.current === 'control') api.handback(bot.id).catch(() => {}); }, [api, bot.id]);

  // Full screen: no header, no system bars. Back leaves full screen first.
  useEffect(() => {
    toPage({ t: 'fullscreen', on: fullscreen });
    NavigationBar.setVisibilityAsync(fullscreen ? 'hidden' : 'visible').catch(() => {});
    if (!fullscreen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setFullscreen(false); return true; });
    return () => sub.remove();
  }, [fullscreen, toPage]);

  // The desktop is wide: let this screen turn with the phone, and put the app back upright on the way out.
  useEffect(() => {
    ScreenOrientation.unlockAsync().catch(() => {});
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
      NavigationBar.setVisibilityAsync('visible').catch(() => {});
    };
  }, []);

  // Keep the touch bar above the phone keyboard. If Android already shrank the window this works out to 0.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      box.current?.measureInWindow((_x, y, _w, h) => setKbPad(Math.max(0, Math.round(y + h - e.endCoordinates.screenY))));
    });
    // The phone's own close-keyboard button leaves the page's text box focused, so the Keyboard button would
    // still read "on" and need two taps. Tell the page, which lets go of the box and turns the button off.
    const hide = Keyboard.addListener('keyboardDidHide', () => { setKbPad(0); toPage({ t: 'kbHidden' }); });
    return () => { show.remove(); hide.remove(); };
  }, [toPage]);

  const onMessage = (e: WebViewMessageEvent) => {
    let m: any;
    try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    switch (m.t) {
      case 'ready': setPageReady(true); break;
      case 'send': link.current?.send(m.d); break;
      case 'close': link.current?.close(); break;
      case 'state':
        if (m.sid !== undefined && m.sid !== sid.current) break; // about a connection already replaced
        if (m.s === 'connected') { hadFrame.current = true; failures.current = 0; setRetrying(false); setCause(null); }
        if (m.s === 'error' || m.s === 'disconnected') onDrop(m.s, m.why);
        else setConn(m.s);
        break;
      case 'handback': handBack(); break;
      case 'fullscreen': setFullscreen((f) => !f); break;
      case 'clipPaste': runClip(api, { kind: 'bot', id: bot.id, name: bot.name }, 'paste', toPage); break;
      case 'clipCopy': runClip(api, { kind: 'bot', id: bot.id, name: bot.name }, 'copy', toPage); break;
      case 'helpSeen': helpSeen.current = true; SecureStore.setItemAsync(HELP_KEY, '1').catch(() => {}); break;
    }
  };

  // The page lost its renderer (Android can kill it to free memory): load it again.
  const reloadPage = () => { link.current?.close(); setPageReady(false); setPageKey((k) => k + 1); };

  const retry = () => {
    setWakeError(null);
    failures.current = 0;
    setCause(null);
    clearRetry();
    if (running) setAttempt((n) => n + 1);
    else wake();
  };

  const reset = () => {
    setMenu(false);
    Alert.alert(`Reset ${bot.name}’s screen?`, 'This closes every window on it.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: () => { api.resetScreen(bot.id).then(() => setAttempt((n) => n + 1)).catch(() => Alert.alert('Couldn’t reset the screen.')); } },
    ]);
  };

  let phase: Phase;
  if (status === 'error' || wakeError || (!computer && loadError)) phase = 'error';
  else if (!running) phase = !computer || busy || waking ? 'waking' : 'asleep';
  else if (conn === 'error' || conn === 'disconnected') phase = 'error';
  else if (conn === 'connected') phase = 'live';
  else phase = hadFrame.current ? 'switching' : 'waking';

  const errorText = !computer && loadError ? 'Couldn’t reach your server'
    : !running ? `Couldn’t wake ${bot.name}’s computer`
    : conn === 'disconnected' ? 'The screen disconnected' : `Couldn’t reach ${bot.name}’s screen`;
  const errorSub = wakeError ?? (status === 'error' ? computer?.error : null) ?? (!computer ? loadError : null)
    ?? (running && cause ? `${cause} Tried ${failures.current + 1} times.` : null);
  const full = !!computer?.maxScreens && computer.screens.length >= computer.maxScreens && !computer.screens.some((s) => s.botId === bot.id);

  return (
    <View ref={box} style={{ flex: 1, backgroundColor: color.computer, paddingBottom: kbPad }}>
      <StatusBar style="light" hidden={fullscreen} />
      {!fullscreen && (
        <Header dark>
          <RoundButton icon="back" label="Back" onPress={onBack} dark />
          <View style={{ flexShrink: 1, height: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 7, paddingRight: 16, borderRadius: 22, backgroundColor: color.computerControl }}>
            <BotAvatar bot={bot} size={30} server={api.server} auth={api.authHeader} />
            <View style={{ flexShrink: 1 }}>
              <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', color: '#FFFFFF' }}>{bot.name}</Text>
              <Text numberOfLines={1} style={{ fontSize: 12, color: '#FFFFFF99' }}>{driving && phase === 'live' ? 'You’re driving' : statusText(computer)}</Text>
            </View>
          </View>
          <View style={{ flex: 1 }} />
          {canTeach && driving && phase === 'live' && (
            <Pressable accessibilityRole="button" accessibilityLabel={recording ? `Stop recording (${teachSteps} steps)` : 'Record what you do'} onPress={toggleRecord} disabled={teachBusy} hitSlop={4}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, height: 44, paddingHorizontal: 14, borderRadius: 22, backgroundColor: recording ? '#D93025' : color.computerControl, opacity: teachBusy ? 0.5 : pressed ? 0.8 : 1 })}>
              <Icon name={recording ? 'stop' : 'record'} size={16} color="#FFFFFF" />
              <Text style={{ fontSize: 15, fontWeight: '600', color: '#FFFFFF' }}>{recording ? `Stop · ${teachSteps}` : 'Record'}</Text>
            </Pressable>
          )}
          {!(canTeach && driving && phase === 'live') && <RoundButton icon="expand" label="Full screen" onPress={() => setFullscreen(true)} dark />}
          <RoundButton icon="more" label="More" onPress={() => setMenu(true)} dark />
        </Header>
      )}

      <View style={{ flex: 1 }}>
        <WebView
          key={pageKey}
          ref={web}
          // An https base makes the page a secure context, which noVNC needs. Nothing is fetched from it.
          source={{ html: SCREEN_PAGE, baseUrl: PAGE_BASE }}
          originWhitelist={['*']}
          // The page is ours and never navigates; refuse anything that tries.
          onShouldStartLoadWithRequest={(r: { url: string }) => r.url === PAGE_BASE || r.url === 'about:blank'}
          onMessage={onMessage}
          onRenderProcessGone={reloadPage}
          style={{ flex: 1, backgroundColor: '#000000', opacity: phase === 'live' ? 1 : 0 }}
          containerStyle={{ backgroundColor: '#000000' }}
          javaScriptEnabled
          domStorageEnabled={false}
          allowFileAccess={false}
          setSupportMultipleWindows={false}
          setBuiltInZoomControls={false}
          scrollEnabled={false}
          overScrollMode="never"
          textZoom={100}
          mixedContentMode="never"
          cacheEnabled={false}
          hideKeyboardAccessoryView
        />
        {phase !== 'live' && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 32 }}>
            {phase === 'switching' ? <ActivityIndicator color="#FFFFFF" /> : (
              <View style={{ opacity: phase === 'asleep' ? 0.55 : 1 }}>
                <BotAvatar bot={bot} size={64} server={api.server} auth={api.authHeader} />
              </View>
            )}
            <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: '500', color: '#FFFFFF', textAlign: 'center' }}>
              {phase === 'switching' ? (retrying ? 'Reconnecting…' : driving ? 'Taking control…' : 'One moment…')
                : phase === 'waking' ? (running ? (retrying ? `Still opening ${bot.name}’s screen…` : `Opening ${bot.name}’s screen…`) : `Waking ${bot.name}’s computer…`)
                : phase === 'asleep' ? (status === 'suspending' ? 'Going to sleep…' : `${bot.name}’s computer is asleep`)
                : errorText}
            </Text>
            {phase === 'error' && !!errorSub && <Text style={{ fontSize: 13, lineHeight: 18, color: '#FFFFFF99', textAlign: 'center' }}>{errorSub}</Text>}
            {phase === 'error' && running && full && <Text style={{ fontSize: 13, lineHeight: 18, color: '#FFFFFF99', textAlign: 'center' }}>All {computer?.maxScreens} screens are in use. Reset one from the web app’s Settings to free it.</Text>}
            {phase === 'asleep' && status !== 'suspending' && <ScreenButton title="Wake it up" onPress={wake} bg={action} fg={onAction} />}
            {phase === 'error' && <ScreenButton title="Retry" onPress={() => (!computer ? load() : retry())} bg={action} fg={onAction} />}
          </View>
        )}
      </View>

      {/* Watching: one row under the picture. Driving, the touch bar comes from the page itself. */}
      {!driving && phase === 'live' && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 60, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#1B1B1B' }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#28C840', marginLeft: 6 }} />
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: '#FFFFFFD9' }}>Watching {bot.name}</Text>
          {fullscreen && <RoundButton icon="shrink" label="Leave full screen" onPress={() => setFullscreen(false)} dark size={40} />}
          <ScreenButton title="Take control" icon="pointer" onPress={() => setMode('control')} bg={action} fg={onAction} />
        </View>
      )}

      <Sheet visible={menu} onClose={() => setMenu(false)} title={`${bot.name}’s computer`}>
        <SheetRow icon="expand" title="Full screen" onPress={() => { setMenu(false); setFullscreen(true); }} />
        {canTeach && driving && phase === 'live' && <SheetRow icon={recording ? 'stop' : 'record'} title={recording ? `Stop recording (${teachSteps} steps)` : 'Record what you do, to teach a skill'} onPress={() => { setMenu(false); void toggleRecord(); }} />}
        {canTeach && !recording && teach.state?.recording && <SheetRow icon="sparkle" title="Review the last recording" onPress={() => { setMenu(false); onTeachReview?.(); }} />}
        {phase === 'live' && (driving
          ? <SheetRow icon="eye" title={`Hand back to ${bot.name}`} onPress={() => { setMenu(false); handBack(); }} />
          : <SheetRow icon="pointer" title="Take control" onPress={() => { setMenu(false); setMode('control'); }} />)}
        {running && <SheetRow icon="refresh" title="Reconnect" onPress={() => { setMenu(false); retry(); }} />}
        {running && <SheetRow icon="close" title="Reset screen (close all windows)" onPress={reset} danger />}
      </Sheet>
    </View>
  );
}

function ScreenButton({ title, onPress, bg, fg, icon }: { title: string; onPress: () => void; bg: string; fg: string; icon?: 'pointer' }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={4}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 7, height: 44, paddingHorizontal: 18, borderRadius: 22, backgroundColor: bg, opacity: pressed ? 0.8 : 1 })}>
      {icon && <Icon name={icon} size={17} color={fg} />}
      <Text style={{ fontSize: 15, fontWeight: '600', color: fg }}>{title}</Text>
    </Pressable>
  );
}
