import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import type { Bot, Client } from '../api';
import { BotPicker, groupable } from '../components/BotPicker';
import { Icon } from '../components/Icon';
import { KeyboardSafe } from '../components/KeyboardSafe';
import { Header, HeaderAction, HeaderTitle, Label, Notice, PillButton, RoundButton } from '../components/ui';
import { tap } from '../haptics';
import { color, type } from '../theme';

/**
 * New group (from the + menu): name it, tick at least two bots, then Create opens the group's chat.
 * Same rules as the web app's New group chat window (server/src/routes-rooms.ts checks them again).
 */
export function NewGroup({ api, bots, onBack, onCreated }: { api: Client; bots: Bot[]; onBack: () => void; onCreated: (roomId: string) => Promise<void> | void }) {
  const choices = groupable(bots);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim().length > 0 && picked.length >= 2 && !busy;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const create = async () => {
    if (!name.trim()) { setError('Give the group a name first.'); return; }
    if (picked.length < 2) { setError('Pick at least 2 bots.'); return; }
    setBusy(true);
    setError(null);
    try { const id = (await api.createRoom(name.trim(), picked)).id; tap('success'); await onCreated(id); }
    catch (e: any) { setError(e?.message ?? 'Could not create the group.'); setBusy(false); }
  };

  const status = picked.length === 0 ? 'Pick at least 2 bots' : picked.length === 1 ? '1 bot picked, pick 1 more' : `${picked.length} bots picked`;

  return (
    <KeyboardSafe style={{ backgroundColor: color.ground }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>New group</HeaderTitle>
        <HeaderAction title="Create" onPress={create} disabled={!ready} />
      </Header>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
        <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 12 }}>
          <View style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: color.fill, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="group" size={48} color={color.ink} strokeWidth={1.6} />
          </View>
        </View>
        <TextInput value={name} onChangeText={setName} placeholder="Name your group" placeholderTextColor={color.timestamp} autoFocus maxLength={60}
          accessibilityLabel="Group name" returnKeyType="done"
          style={{ fontSize: 24, fontWeight: '600', textAlign: 'center', color: color.ink, paddingVertical: 6, marginBottom: 20 }} />
        {error && <View style={{ marginBottom: 16 }}><Notice tone="problem">{error}</Notice></View>}
        <Label>Bots in this group</Label>
        <BotPicker api={api} bots={choices} picked={picked} onToggle={(id) => { tap('select'); toggle(id); setError(null); }} disabled={busy} />
        <Text style={[type.caption, { fontSize: 13, marginTop: 8, marginHorizontal: 4 }]}>{status}. @name a bot to ask just them; otherwise the group answers.</Text>
        <PillButton title={busy ? 'Creating…' : 'Create group'} onPress={create} disabled={!ready} style={{ marginTop: 22 }} />
      </ScrollView>
    </KeyboardSafe>
  );
}
