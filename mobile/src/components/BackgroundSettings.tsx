import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, Switch, Text, View } from 'react-native';
import { APP_NAME, askForNotifications, background } from '../background';
import { color, setAnswerVisuals, setThemePref, type, useAnswerVisuals, useScheme, type ThemePref } from '../theme';
import { Chip } from './ui';
import { setHaptics, useHaptics } from '../haptics';
import { setTextSize, TEXT_SIZES, useTextSize } from '../prefs';
import type { Bot, Client } from '../api';
import { NotificationSettings } from './NotificationSettings';
import { ChatListSettings } from './ChatListSettings';
import { AssistantSettings } from './AssistantSettings';

/**
 * "Keep running in the background": an opt-in that sends the person to Android's own question about
 * battery optimisation for this app (never asked on its own, never at install), plus notifications and,
 * on Samsung phones, where Samsung's own sleeping-apps lists live. Slow jobs such as drawing pictures
 * already keep going without it (a foreground service follows them); this helps everything else.
 */
export function BackgroundSettings({ api, bots, simple }: { api?: Client; bots?: Bot[]; /** A scoped sign-in's view (simple.ts): no chat list there, so no chat list settings. */ simple?: boolean } = {}) {
  const [st, setSt] = useState(background.status());
  const refresh = useCallback(() => setSt(background.status()), []);
  // The answers come from Settings screens, so read them again on the way back.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh(); });
    return () => sub.remove();
  }, [refresh]);

  if (!background.available) return <View style={{ gap: 12 }}><Appearance />{!!api && !simple && <ChatListSettings api={api} />}</View>;
  const samsung = /samsung/i.test(st.manufacturer);

  // With the notification link (this build and later), notifications have their own settings below.
  const link = !!api && background.notifyAvailable;
  return (
    <View style={{ gap: 12 }}>
    <Appearance />
    {!!api && !simple && <ChatListSettings api={api} />}
    {(simple || (bots?.length ?? 0) > 1) && <AssistantSettings bots={bots} />}
    <View style={{ backgroundColor: color.fill, borderRadius: 18, overflow: 'hidden' }}>
      <Row title={`Keep ${APP_NAME} running in the background`} last={link && !samsung}
        detail={st.ignoringBatteryOptimizations
          ? 'On. Android will not put the app to sleep to save battery. To turn it off, pick the app in the list and choose Optimise.'
          : 'Android may pause the app a while after you leave it. Turn this on so it stays connected. It can use a little more battery.'}
        right={<Switch value={st.ignoringBatteryOptimizations} onValueChange={(on) => { if (on) background.requestBatteryExemption(); else background.openBatterySettings(); }}
          trackColor={{ true: color.primary, false: color.secondaryBorder }} accessibilityLabel={`Keep ${APP_NAME} running in the background`} />} />
      {!link && <Row title="Notifications" last={!samsung}
        detail={st.notificationsAllowed ? 'On. You get a note when slow work, such as drawing pictures, is done while you are away.' : 'Off. Turn them on to hear when pictures are ready while you are in another app.'}
        right={st.notificationsAllowed ? null : <Small title="Turn on" onPress={() => { void askForNotifications().then((ok) => { if (!ok) background.openAppSettings(); refresh(); }); }} />} />}
      {samsung && (
        <Row title="Samsung battery settings" last
          detail={`Samsung phones also have their own lists. In ${APP_NAME}'s settings, set Battery to Unrestricted, and check it is not in Sleeping apps or Deep sleeping apps (Settings, Battery, Background usage limits).`}
          right={<Small title="Open" onPress={() => background.openAppSettings()} />} />
      )}
    </View>
    {link && <NotificationSettings api={api!} bots={bots} />}
    </View>
  );
}

/** Light or dark, as Settings › General › Theme on the web: System follows the phone's own setting. Kept on this phone. */
export function Appearance() {
  const { pref } = useScheme();
  const visuals = useAnswerVisuals();
  const size = useTextSize();
  const haptics = useHaptics();
  const opts: [ThemePref, string][] = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
  return (
    <View style={{ backgroundColor: color.fill, borderRadius: 18, paddingVertical: 13, paddingHorizontal: 16, gap: 10 }}>
      <View style={{ gap: 2 }}>
        <Text style={[type.body, { fontWeight: '500' }]}>Appearance</Text>
        <Text style={[type.caption, { fontSize: 13 }]}>System follows your phone's light or dark setting.</Text>
      </View>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8 }}>
        {opts.map(([v, label]) => <Chip key={v} onCard title={label} selected={pref === v} onPress={() => setThemePref(v)} />)}
      </View>
      <View style={{ gap: 2, marginTop: 4 }}>
        <Text style={[type.body, { fontWeight: '500' }]}>Text size</Text>
        <Text style={[type.caption, { fontSize: 13 }]}>How big the words in chats are on this phone.</Text>
      </View>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {TEXT_SIZES.map((t) => <Chip key={t.id} onCard title={t.label} selected={size === t.id} onPress={() => setTextSize(t.id)} />)}
      </View>
      <View style={{ gap: 2, marginTop: 4 }}>
        <Text style={[type.body, { fontWeight: '500' }]}>Answer visuals</Text>
        <Text style={[type.caption, { fontSize: 13 }]}>{'Rich shows charts, checklists and calculators when a Bot answers with a view. Simple shows the same answer as text. How often each Bot uses them is in that Bot\'s settings.'}</Text>
      </View>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8 }}>
        <Chip onCard title="Rich" selected={visuals === 'rich'} onPress={() => setAnswerVisuals('rich')} />
        <Chip onCard title="Simple" selected={visuals === 'simple'} onPress={() => setAnswerVisuals('simple')} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[type.body, { fontWeight: '500' }]}>Touch feedback</Text>
          <Text style={[type.caption, { fontSize: 13 }]}>A small tap you can feel when a message is sent, a card is answered or a menu opens.</Text>
        </View>
        <Switch accessibilityLabel="Touch feedback" value={haptics} onValueChange={setHaptics} trackColor={{ true: color.primary, false: color.secondaryBorder }} />
      </View>
    </View>
  );
}

function Row({ title, detail, right, last }: { title: string; detail: string; right?: React.ReactNode; last?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 16, borderBottomWidth: last ? 0 : 1, borderBottomColor: color.hairline }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.body, { fontWeight: '500' }]}>{title}</Text>
        <Text style={[type.caption, { fontSize: 13 }]}>{detail}</Text>
      </View>
      {right}
    </View>
  );
}

function Small({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}
      style={({ pressed }) => ({ height: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center', backgroundColor: color.surface, borderWidth: 1, borderColor: color.secondaryBorder, opacity: pressed ? 0.7 : 1 })}>
      <Text style={{ fontSize: 14, fontWeight: '500', color: color.ink }}>{title}</Text>
    </Pressable>
  );
}
