import { useCallback, useEffect, useState } from 'react';
import { AppState, Pressable, Switch, Text, View } from 'react-native';
import { APP_NAME, background } from '../background';
import { color, type } from '../theme';
import { Chip } from './ui';
import type { Bot } from '../api';
import { assistantBot, assistantChoices, setAssistantBot, setAssistantListen, useAssistantPrefs } from '../assist';

/**
 * Settings › Assistant (Android): make this app the phone's default digital assistant, so holding the power
 * or home button (or swiping up from a bottom corner, as the phone allows) opens a Bot's chat. Android
 * does not let an app ask for this with a pop-up, so "Open Android settings" goes to the system screen where
 * the person picks the app. Which Bot opens, and whether it starts listening, are kept on this phone.
 */
export function AssistantSettings({ bots }: { bots?: Bot[] }) {
  const [held, setHeld] = useState(background.assistantHeld());
  const refresh = useCallback(() => setHeld(background.assistantHeld()), []);
  // The answer comes from Android's settings screen, so read it again on the way back.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') refresh(); });
    return () => sub.remove();
  }, [refresh]);
  const prefs = useAssistantPrefs();
  if (!background.assistantAvailable) return null;

  const choices = assistantChoices(bots ?? []);
  const current = assistantBot(bots ?? []);
  const who = current?.name ?? 'your main Bot';
  const status = held === true
    ? `On. Hold the power button (or use your phone's assistant gesture) and a card for ${who} opens over whatever you are doing. To share your screen with ${who}, turn on "Use screenshot" in Android's assistant settings.`
    : held === false
      ? `Off. Pick ${APP_NAME} as the default digital assistant app in Android's settings, then hold the power or home button to talk to ${who}.`
      : `Pick ${APP_NAME} as the default digital assistant app in Android's settings, then hold the power or home button to talk to ${who}.`;

  return (
    <View style={{ backgroundColor: color.fill, borderRadius: 18, paddingVertical: 13, paddingHorizontal: 16, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[type.body, { fontWeight: '500' }]}>Phone assistant</Text>
          <Text style={[type.caption, { fontSize: 13 }]}>{status}</Text>
        </View>
        <Small title={held ? 'Change' : 'Open Android settings'} onPress={() => { background.openAssistantSettings(); }} />
      </View>
      {choices.length > 1 && (
        <>
          <View style={{ gap: 2, marginTop: 4 }}>
            <Text style={[type.body, { fontWeight: '500' }]}>Opens</Text>
            <Text style={[type.caption, { fontSize: 13 }]}>The Bot the assistant card talks to.</Text>
          </View>
          <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {choices.map((b) => <Chip key={b.id} onCard title={b.name} selected={current?.id === b.id} onPress={() => setAssistantBot(b.id)} />)}
          </View>
        </>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[type.body, { fontWeight: '500' }]}>Start listening</Text>
          <Text style={[type.caption, { fontSize: 13 }]}>The card listens as soon as it opens and sends what you said when you stop talking. Off: tap the mic first, or type.</Text>
        </View>
        <Switch accessibilityLabel="Start listening" value={prefs.listen} onValueChange={setAssistantListen} trackColor={{ true: color.primary, false: color.secondaryBorder }} />
      </View>
    </View>
  );
}

function Small({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}
      style={({ pressed }) => ({ minHeight: 36, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, justifyContent: 'center', backgroundColor: color.surface, borderWidth: 1, borderColor: color.secondaryBorder, opacity: pressed ? 0.7 : 1, maxWidth: 150 })}>
      <Text style={{ fontSize: 14, fontWeight: '500', color: color.ink, textAlign: 'center' }}>{title}</Text>
    </Pressable>
  );
}
