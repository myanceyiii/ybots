import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Keyboard, Text, View } from 'react-native';
import * as NavigationBar from 'expo-navigation-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { Client, Machine } from '../api';
import { Header, PillButton, RoundButton } from '../components/ui';
import { ScreenLink, type ToPage } from '../screenLink';
import { color } from '../theme';
import { runClip } from '../remoteClip';
import { SCREEN_PAGE } from '../vnc/page.generated';

type Mode = 'watch' | 'control';
const PAGE_BASE = 'https://screen.cleft.invalid/';
const HELP_KEY = 'cleftbot.screenHelpSeen';

/**
 * A paired PC's screen (docs/remote-pc.md): the same noVNC page as a bot's computer, over
 * /api/machines/<id>/screen. Watched by default; "Take control" (when the PC allows it) reconnects in
 * control mode with the same touch bar as a bot's computer: tap to click, hold to right-click, two fingers
 * to scroll, Keyboard, Keys, Zoom, full screen and Hand back. The PC shows a bar the whole time, and its
 * Stop ends this view.
 */
export function PcScreen({ api, machine, startMode = 'watch', onBack }: { api: Client; machine: Machine; startMode?: Mode; onBack: () => void }) {
  const web = useRef<React.ComponentRef<typeof WebView>>(null);
  const link = useRef<ScreenLink | null>(null);
  const box = useRef<React.ComponentRef<typeof View>>(null);
  const helpSeen = useRef(false);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>(startMode === 'control' && machine.control ? 'control' : 'watch');
  const [conn, setConn] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting');
  const [attempt, setAttempt] = useState(0);
  const [pageKey, setPageKey] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [kbPad, setKbPad] = useState(0);
  useKeepAwake();

  const toPage = useCallback((m: object) => {
    web.current?.injectJavaScript(`window.__cleft && window.__cleft(${JSON.stringify(m)});true;`);
  }, []);

  useEffect(() => { SecureStore.getItemAsync(HELP_KEY).then((v) => { helpSeen.current = v === '1'; }).catch(() => {}); }, []);

  useEffect(() => {
    if (!ready) return;
    setConn('connecting');
    toPage({ t: 'start', clip: mode === 'control' && !!machine.clipboard, mode, zoom: false, help: mode === 'control' && !helpSeen.current, fullscreen, name: machine.name, action: '#FFFFFF', onAction: '#111111' });
    const { url, headers } = api.pcScreenSocket(machine.id, mode);
    const l = new ScreenLink(url, headers, (m: ToPage) => toPage(m));
    link.current = l;
    return () => { l.close(); if (link.current === l) link.current = null; toPage({ t: 'stop' }); };
  }, [api, machine.id, machine.name, ready, mode, attempt, pageKey, toPage]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    toPage({ t: 'fullscreen', on: fullscreen });
    NavigationBar.setVisibilityAsync(fullscreen ? 'hidden' : 'visible').catch(() => {});
    if (!fullscreen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setFullscreen(false); return true; });
    return () => sub.remove();
  }, [fullscreen, toPage]);

  useEffect(() => {
    ScreenOrientation.unlockAsync().catch(() => {});
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
      NavigationBar.setVisibilityAsync('visible').catch(() => {});
    };
  }, []);

  // Keep the touch bar above the phone keyboard.
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
      case 'ready': setReady(true); break;
      case 'send': link.current?.send(m.d); break;
      case 'close': link.current?.close(); break;
      case 'state': setConn(m.s); break;
      case 'handback': setMode('watch'); setFullscreen(false); break;
      case 'fullscreen': setFullscreen((f) => !f); break;
      case 'clipPaste': runClip(api, { kind: 'pc', id: machine.id, name: machine.name }, 'paste', toPage); break;
      case 'clipCopy': runClip(api, { kind: 'pc', id: machine.id, name: machine.name }, 'copy', toPage); break;
      case 'helpSeen': helpSeen.current = true; SecureStore.setItemAsync(HELP_KEY, '1').catch(() => {}); break;
    }
  };

  const driving = mode === 'control';
  return (
    <View ref={box} style={{ flex: 1, backgroundColor: color.computer, paddingBottom: kbPad }}>
      <StatusBar style="light" hidden={fullscreen} />
      {!fullscreen && (
        <Header dark>
          <RoundButton icon="back" label="Back" onPress={onBack} dark />
          <View style={{ flexShrink: 1, height: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 22, backgroundColor: color.computerControl }}>
            <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', color: '#FFFFFF' }}>{machine.name}</Text>
            <Text numberOfLines={1} style={{ fontSize: 12, color: '#FFFFFF99' }}>{conn === 'connected' ? (driving ? 'You’re driving' : 'Watching · view only') : conn === 'connecting' ? 'Connecting…' : 'Not connected'}</Text>
          </View>
          <View style={{ flex: 1 }} />
          {!driving && machine.control && <RoundButton icon="pointer" label="Take control" onPress={() => setMode('control')} dark />}
          <RoundButton icon="expand" label="Full screen" onPress={() => setFullscreen(true)} dark />
        </Header>
      )}
      <View style={{ flex: 1 }}>
        <WebView
          key={pageKey}
          ref={web}
          source={{ html: SCREEN_PAGE, baseUrl: PAGE_BASE }}
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={(r: { url: string }) => r.url === PAGE_BASE || r.url === 'about:blank'}
          onMessage={onMessage}
          onRenderProcessGone={() => { link.current?.close(); setReady(false); setPageKey((k) => k + 1); }}
          style={{ flex: 1, backgroundColor: color.computer }}
        />
        {conn !== 'connected' && (
          <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 32 }} pointerEvents="box-none">
            {conn === 'connecting' ? <ActivityIndicator color="#FFFFFF" /> : (
              <>
                <Text style={{ color: '#FFFFFF', fontSize: 16, textAlign: 'center' }}>
                  {driving ? 'Control ended. Someone at the PC may have pressed Stop or turned taking control off.' : 'The screen closed. Someone at the PC may have pressed Stop or turned viewing off.'}
                </Text>
                <PillButton title="Try again" onPress={() => setAttempt((n) => n + 1)} />
                {driving && <PillButton title="Just watch" kind="secondary" onPress={() => setMode('watch')} />}
              </>
            )}
          </View>
        )}
      </View>
    </View>
  );
}
