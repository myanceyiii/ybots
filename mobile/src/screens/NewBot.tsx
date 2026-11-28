import { useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { KeyboardSafe } from '../components/KeyboardSafe';
import type { Bot, Client } from '../api';
import type { AvatarColor, AvatarShape } from '@shared/types';
import { BotShape } from '../components/BotAvatar';
import { ShapePicker } from '../components/ShapePicker';
import { Header, HeaderAction, HeaderTitle, ListGroup, ListRow, Notice, RoundButton } from '../components/ui';
import { color } from '../theme';

/** New bot (from the + menu): a big preview, its name, then shape and colour, or a custom look. */
export function NewBot({ api, onBack, onCreated }: { api: Client; onBack: () => void; onCreated: (b: Bot, customLook: boolean) => void }) {
  const [name, setName] = useState('');
  const [shape, setShape] = useState<AvatarShape>('blob');
  const [tint, setTint] = useState<AvatarColor>('blue');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (customLook: boolean) => {
    if (!name.trim()) { setError('Give the bot a name first.'); return; }
    setBusy(true);
    setError(null);
    try { onCreated((await api.createBot({ name: name.trim(), avatarShape: shape, avatarColor: tint })).bot, customLook); }
    catch (e: any) { setError(e?.message ?? 'Could not create the bot.'); }
    finally { setBusy(false); }
  };

  return (
    <KeyboardSafe style={{ backgroundColor: color.ground }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>New bot</HeaderTitle>
        <HeaderAction title="Create" onPress={() => create(false)} disabled={busy || !name.trim()} />
      </Header>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
        <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 16 }}><BotShape shape={shape} color={tint} size={112} /></View>
        <TextInput value={name} onChangeText={setName} placeholder="Name your bot" placeholderTextColor={color.timestamp} autoFocus maxLength={60}
          accessibilityLabel="Bot name" returnKeyType="done"
          style={{ fontSize: 24, fontWeight: '600', textAlign: 'center', color: color.ink, paddingVertical: 6, marginBottom: 20 }} />
        {error && <View style={{ marginBottom: 16 }}><Notice tone="problem">{error}</Notice></View>}
        <ShapePicker shape={shape} tint={tint} onShape={setShape} onTint={setTint} />
        <ListGroup style={{ marginTop: 18 }}>
          <ListRow icon="sparkle" title="Make a custom look instead" detail="Describe it or upload a photo, then pick one." onPress={() => create(true)} disabled={busy} last />
        </ListGroup>
      </ScrollView>
    </KeyboardSafe>
  );
}
