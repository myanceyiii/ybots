/**
 * A thin bar under the status bar while the phone cannot reach the server: it says so in plain words,
 * says that what is on screen may be out of date, and offers Try now. Nothing shows for a short blip
 * (src/connection.ts), and the bar goes away by itself when the connection is back.
 */
import { useEffect, useRef, useState } from 'react';
import { usePending } from '../outbox';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { Connection } from '../connection';
import { color } from '../theme';

export function ConnectionBanner({ state, saved, onRetry }: { state: Connection; /** The screen was drawn from the phone's saved copy. */ saved?: boolean; onRetry: () => void }) {
  const updating = state === 'updating';
  const down = state === 'offline' || state === 'reconnecting' || updating;
  // Messages written meanwhile are counted, so it is clear they were kept.
  const waiting = usePending().filter((p) => p.state !== 'failed').length;
  // "Back online" for a moment after an outage that was shown, so the bar does not just vanish.
  const [back, setBack] = useState(false);
  const was = useRef(false);
  useEffect(() => {
    if (down) { was.current = true; setBack(false); return; }
    if (state !== 'ok' || !was.current) return;
    was.current = false;
    setBack(true);
    const t = setTimeout(() => setBack(false), 2200);
    return () => clearTimeout(t);
  }, [down, state]);
  // Try now spins for a moment so the tap is seen even when nothing changes.
  const [trying, setTrying] = useState(false);
  useEffect(() => { if (!trying) return; const t = setTimeout(() => setTrying(false), 2500); return () => clearTimeout(t); }, [trying]);
  if (!down && !back) return null;
  if (back) {
    return (
      <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 16, backgroundColor: color.infoFill }}>
        <Text style={{ fontSize: 13.5, fontWeight: '600', color: color.link }}>Back online</Text>
      </View>
    );
  }
  const offline = state === 'offline';
  if (updating) {
    return (
      <View accessibilityLiveRegion="polite" accessibilityRole="alert" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 16, backgroundColor: color.fill }}>
        <ActivityIndicator size="small" color={color.inkMuted} />
        <Text style={{ flex: 1, fontSize: 13.5, lineHeight: 18, color: color.inkSecondary }}>
          <Text style={{ fontWeight: '700' }}>The server is updating. </Text>
          It is back in under a minute.{waiting > 0 ? ` ${waiting} ${waiting === 1 ? 'message is' : 'messages are'} waiting and will send by ${waiting === 1 ? 'itself' : 'themselves'}.` : ''}
        </Text>
      </View>
    );
  }
  return (
    <View accessibilityLiveRegion="polite" accessibilityRole="alert" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7, paddingLeft: 16, paddingRight: 8, backgroundColor: offline ? color.problemFill : color.fill }}>
      {!offline && <ActivityIndicator size="small" color={color.inkMuted} />}
      <Text style={{ flex: 1, fontSize: 13.5, lineHeight: 18, color: offline ? color.problemInk : color.inkSecondary }}>
        <Text style={{ fontWeight: '700' }}>{offline ? 'No connection. ' : 'Reconnecting… '}</Text>
        {offline ? (saved ? 'Showing what this phone saved. ' : 'What you see may be out of date. ') : 'New messages may be a moment late. '}
        {waiting > 0 ? `${waiting} ${waiting === 1 ? 'message is' : 'messages are'} waiting and will send by ${waiting === 1 ? 'itself' : 'themselves'}.` : offline ? 'Messages you send go out when it is back.' : ''}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Try to connect now" onPress={() => { setTrying(true); onRetry(); }} hitSlop={8} disabled={trying}
        style={({ pressed }) => ({ minHeight: 34, paddingHorizontal: 12, borderRadius: 17, justifyContent: 'center', backgroundColor: pressed ? color.pressed : 'transparent', opacity: trying ? 0.5 : 1 })}>
        <Text style={{ fontSize: 13.5, fontWeight: '700', color: offline ? color.problemInk : color.ink }}>{trying ? 'Trying…' : 'Try now'}</Text>
      </Pressable>
    </View>
  );
}
