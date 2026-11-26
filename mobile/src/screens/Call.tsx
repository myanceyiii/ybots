import { useEffect, useRef, useState } from 'react';
import { tap } from '../haptics';
import { Animated, Pressable, ScrollView, Text, View, type ScrollViewInstance } from 'react-native';
import type { Bot, Client, Row } from '../api';
import { BotAvatar } from '../components/BotAvatar';
import { Icon, type IconName } from '../components/Icon';
import { Header, Notice, PillButton, RoundButton } from '../components/ui';
import { color } from '../theme';
import { callLevels, dismissCallError, endCall, isCallActive, startCall, toggleMute, useCall, type CallState } from '../voice/call';

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function callStatusLine(v: CallState): string {
  if (v.status === 'connecting') return 'Connecting…';
  if (v.status === 'error') return v.error ?? 'Call ended';
  if (v.speaking) return 'Speaking';
  if (v.listening) return 'Listening';
  if (v.working) return 'Working on it…';
  if (v.thinking) return 'Thinking…';
  if (v.muted) return 'Muted';
  return 'Listening';
}

/**
 * The voice call, laid out like Grok Bot's: the bot large in the middle with a ring that moves with
 * its voice, its name, status and the last thing said, then Mute, Hang up and Transcript along the
 * bottom. Opening the screen starts the call; Back keeps it going (a bar in the chat brings you back).
 * `demo` shows a call's look without a microphone (the web preview).
 */
export function Call({ api, bot, rows, onBack, demo }: { api: Client; bot: Bot; rows: Row[]; onBack: () => void; demo?: CallState }) {
  const real = useCall();
  const v = demo ?? real;
  const mine = v.botId === bot.id;
  const active = mine && isCallActive(v);
  const [showLog, setShowLog] = useState(false);
  const [now, setNow] = useState(Date.now());
  const ring = useRef(new Animated.Value(0)).current;
  const log = useRef<ScrollViewInstance>(null);

  // Opening the screen calls the bot (unless this call is already on).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    if (demo) return;
    if (!(real.botId === bot.id && isCallActive(real))) startCall(api, bot, rowsRef.current);
    // Only on opening: the call itself carries on when this screen is left.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (v.status !== 'live') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [v.status]);

  // The ring follows the bot's voice (or yours) about twelve times a second.
  useEffect(() => {
    if (!active || demo) return;
    let level = 0;
    const t = setInterval(() => {
      const l = callLevels();
      level = level * 0.6 + Math.min(1, Math.max(l.out, l.mic * 2)) * 0.4;
      Animated.timing(ring, { toValue: level, duration: 80, useNativeDriver: true }).start();
    }, 80);
    return () => { clearInterval(t); ring.setValue(0); };
  }, [active, demo, ring]);

  const hangUp = () => { tap('medium'); endCall(); onBack(); };
  const lines = mine ? v.captions.filter((c) => c.text.trim()) : [];
  const last = lines.slice(-2);
  const size = 180;
  const scale = ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.28] });
  const opacity = ring.interpolate({ inputRange: [0, 1], outputRange: [v.speaking || v.listening ? 0.25 : 0.12, 0.5] });
  const halo = v.listening ? color.primary : bot.avatarColor || color.primary;

  return (
    <View style={{ flex: 1, backgroundColor: color.ground }}>
      <Header><RoundButton icon="back" label={active ? 'Back to the chat (the call stays on)' : 'Back'} onPress={onBack} /></Header>
      {showLog ? (
        <ScrollView ref={log} style={{ flex: 1 }} contentContainerStyle={{ padding: 20, gap: 14 }} onContentSizeChange={() => log.current?.scrollToEnd({ animated: false })}>
          {lines.length ? lines.map((c) => (
            <View key={c.id} style={{ alignSelf: c.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '86%' }}>
              <Text style={{ fontSize: 13, color: color.inkMuted, marginBottom: 2, textAlign: c.role === 'user' ? 'right' : 'left' }}>{c.role === 'user' ? 'You' : bot.name}</Text>
              <Text selectable style={{ fontSize: 16, lineHeight: 22, color: c.final ? color.ink : color.inkSecondary }}>{c.text}</Text>
            </View>
          )) : <Text style={{ fontSize: 15, color: color.inkMuted, textAlign: 'center', marginTop: 40 }}>Nothing said yet.</Text>}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 28 }}>
          <View style={{ width: size * 1.35, height: size * 1.35, alignItems: 'center', justifyContent: 'center' }}>
            <Animated.View pointerEvents="none" style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: halo, opacity, transform: [{ scale }] }} />
            <BotAvatar bot={bot} size={size} server={api.server} auth={api.authHeader} />
          </View>
          <Text style={{ fontSize: 28, fontWeight: '600', color: color.ink }}>{bot.name}</Text>
          {mine && v.status === 'error' ? (
            <View style={{ alignItems: 'center', gap: 14 }}>
              <Notice tone="problem">{v.error ?? 'The call ended.'}</Notice>
              <PillButton title="Call again" onPress={() => { dismissCallError(); startCall(api, bot, rows); }} />
            </View>
          ) : (
            <>
              <Text accessibilityLiveRegion="polite" style={{ fontSize: 16, color: color.inkSecondary }}>
                {mine ? callStatusLine(v) : 'Connecting…'}{v.status === 'live' && v.startedAt ? `  ·  ${fmt(now - v.startedAt)}` : ''}
              </Text>
              {!!v.working && mine && <Text numberOfLines={1} style={{ fontSize: 14, color: color.inkMuted, maxWidth: '100%' }}>{v.working}</Text>}
              <View style={{ minHeight: 72, marginTop: 8, gap: 6, alignSelf: 'stretch' }}>
                {v.status === 'live' && (last.length ? last.map((c) => (
                  <Text key={c.id} numberOfLines={3} style={{ fontSize: 16, lineHeight: 22, textAlign: 'center', color: c.role === 'user' ? color.inkSecondary : color.ink }}>
                    {c.role === 'user' ? `“${c.text}”` : c.text}
                  </Text>
                )) : <Text style={{ fontSize: 16, textAlign: 'center', color: color.inkMuted }}>{v.muted ? 'You’re muted.' : `Say hi to ${bot.name}.`}</Text>)}
              </View>
            </>
          )}
        </View>
      )}
      <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-start', gap: 36, paddingBottom: 40, paddingTop: 12 }}>
        <Control icon={v.muted ? 'mic' : 'micoff'} label={v.muted ? 'Unmute' : 'Mute'} on={v.muted} disabled={!active || v.status !== 'live'} onPress={() => { tap('select'); toggleMute(); }} />
        <View style={{ alignItems: 'center', gap: 8 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Hang up" onPress={hangUp}
            style={({ pressed }) => ({ width: 72, height: 72, borderRadius: 36, backgroundColor: color.danger, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.8 : 1 })}>
            <Icon name="phone" size={30} color="#FFFFFF" />
          </Pressable>
          <Text style={{ fontSize: 13, color: color.inkMuted }}>Hang up</Text>
        </View>
        <Control icon="text" label={showLog ? 'Hide' : 'Transcript'} on={showLog} onPress={() => setShowLog((s) => !s)} />
      </View>
    </View>
  );
}

function Control({ icon, label, onPress, on, disabled }: { icon: IconName; label: string; onPress: () => void; on?: boolean; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!on, disabled: !!disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => ({ alignItems: 'center', gap: 8, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 })}>
      <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: on ? color.ink : color.fill, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={26} color={on ? color.ground : color.ink} />
      </View>
      <Text style={{ fontSize: 13, color: color.inkMuted }}>{label}</Text>
    </Pressable>
  );
}

/** A slim bar at the top of a chat while a call is on (or just failed): back to the call, or hang up. */
export function CallBar({ bot, onOpen }: { bot: Bot; onOpen: () => void }) {
  const v = useCall();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (v.status !== 'live') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [v.status]);
  if (v.botId !== bot.id || v.status === 'idle') return null;
  const active = isCallActive(v);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Voice call with ${bot.name}. Open the call`} onPress={onOpen}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 12, marginBottom: 6, paddingLeft: 14, paddingRight: 6, paddingVertical: 6, borderRadius: 22, backgroundColor: active ? color.primary : color.fill, opacity: pressed ? 0.85 : 1 })}>
      <Icon name="voice" size={18} color={active ? color.onPrimary : color.ink} />
      <Text numberOfLines={1} style={{ flex: 1, fontSize: 15, fontWeight: '500', color: active ? color.onPrimary : color.ink }}>
        {callStatusLine(v)}{v.status === 'live' && v.startedAt ? ` · ${fmt(now - v.startedAt)}` : ''}
      </Text>
      {active ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Hang up" onPress={endCall} hitSlop={6}
          style={({ pressed }) => ({ width: 34, height: 34, borderRadius: 17, backgroundColor: color.danger, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.8 : 1 })}>
          <Icon name="phone" size={18} color="#FFFFFF" />
        </Pressable>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={dismissCallError} hitSlop={6} style={{ width: 34, height: 34, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="close" size={16} color={color.inkSecondary} />
        </Pressable>
      )}
    </Pressable>
  );
}
