import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import type { Bot, SideChat } from '../api';
import { useLive } from '../live';
import { color, type } from '../theme';
import { Icon } from './Icon';
import { Sheet } from './ui';

/**
 * Side chats (server/src/side-chats.ts), as on the web (web/src/components/SideChats.tsx): more conversations
 * with the same bot, each with its own history, running at the same time as the main chat. On the phone the
 * open chat's name sits under the bot's name as a chip; tapping it opens a sheet with Main chat, the side
 * chats (rename, delete with Undo) and New side chat.
 */

export const canHaveSideChats = (bot: Bot) => bot.kind !== 'room' && !bot.outside;

function Dot({ tone }: { tone: 'working' | 'attention' | 'unread' }) {
  const bg = tone === 'attention' ? color.danger : tone === 'unread' ? color.primary : color.link;
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: bg }} />;
}

/** The chip under the bot's name: which chat is open, with a dot when another chat is busy or has news. */
export function SideChatChip({ chats, openId, onPress }: { chats: SideChat[]; openId: string | null; onPress: () => void }) {
  const open = chats.find((c) => c.id === openId);
  const others = chats.filter((c) => c.id !== open?.id);
  const unread = others.some((c) => c.unread > 0);
  const busy = others.some((c) => c.live?.isRunning || c.live?.awaiting);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${open ? open.title : 'Main chat'}. Switch chats`} onPress={onPress} hitSlop={6}
      style={({ pressed }) => ({ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 280, height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: pressed ? color.pressed : color.fill, marginTop: 4 })}>
      <Icon name="chat" size={15} color={color.inkSecondary} />
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 14, fontWeight: '500', color: color.ink }}>{open ? open.title : 'Main chat'}</Text>
      {(unread || busy) && <Dot tone={unread ? 'unread' : 'working'} />}
      <View style={{ transform: [{ rotate: '90deg' }] }}><Icon name="chevron" size={13} color={color.inkMuted} /></View>
    </Pressable>
  );
}

function Status({ c }: { c: SideChat }) {
  const live = useLive(c.id) ?? c.live;
  if (live?.awaiting) return <Dot tone="attention" />;
  if (live?.isRunning) return <ActivityIndicator size="small" color={color.inkSecondary} />;
  if (c.unread > 0) {
    return (
      <View style={{ minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: color.primary, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 12, fontWeight: '700', color: color.onPrimary }}>{c.unread > 99 ? '99+' : c.unread}</Text>
      </View>
    );
  }
  return null;
}

function MainStatus({ botId }: { botId: string }) {
  const live = useLive(botId);
  if (live?.awaiting) return <Dot tone="attention" />;
  if (live?.isRunning) return <ActivityIndicator size="small" color={color.inkSecondary} />;
  return null;
}

function SmallButton({ icon, label, onPress, danger }: { icon: 'edit' | 'trash'; label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4}
      style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.fill : 'transparent' })}>
      <Icon name={icon} size={18} color={danger ? color.danger : color.inkSecondary} />
    </Pressable>
  );
}

/**
 * The chats in the order they had when the list opened (Android) or a rename began (web), new ones first.
 * The server lists side chats most recent first, and a running chat jumps up on every step; moving a row
 * while its name is being edited took the field away from under the person's fingers.
 */
export function keepOrder<T extends { id: string }>(chats: T[], order: string[]): T[] {
  const at = new Map(order.map((id, i) => [id, i] as const));
  const fresh = chats.filter((c) => !at.has(c.id));
  const kept = chats.filter((c) => at.has(c.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  return [...fresh, ...kept];
}

/** The sheet: Main chat, the side chats, and New side chat. */
export function SideChatSheet({ visible, onClose, bot, chats, openId, onPick, onNew, onRename, onDelete }: {
  visible: boolean; onClose: () => void; bot: Bot; chats: SideChat[]; openId: string | null;
  onPick: (id: string | null) => void; onNew: () => Promise<void>; onRename: (id: string, title: string) => Promise<void>; onDelete: (c: SideChat) => Promise<void>;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { height } = useWindowDimensions();
  useEffect(() => { if (!visible) { setRenaming(null); setError(null); } }, [visible]);
  // Rows keep their places while the sheet is open, so a running chat can be renamed (see keepOrder).
  const order = useRef<string[]>([]);
  if (!visible) order.current = chats.map((c) => c.id);
  const rows = keepOrder(chats, order.current);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e: any) { setError(e?.message ?? 'Something went wrong. Try again.'); } finally { setBusy(false); }
  };
  const saveName = (c: SideChat) => {
    const t = name.trim();
    if (!t || t === c.title) { setRenaming(null); return; }
    void run(async () => { await onRename(c.id, t); setRenaming(null); });
  };
  const rowStyle = (selected: boolean) => ({ flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, minHeight: 52, paddingLeft: 12, paddingRight: 4, borderRadius: 14, backgroundColor: selected ? color.fill : 'transparent' });
  return (
    <Sheet visible={visible} onClose={onClose} title={`Chats with ${bot.name}`}>
      <ScrollView style={{ maxHeight: Math.round(height * 0.6), flexShrink: 1 }} keyboardShouldPersistTaps="handled">
        <Pressable accessibilityRole="button" accessibilityState={{ selected: !openId }} onPress={() => onPick(null)} style={({ pressed }) => [rowStyle(!openId), pressed && { backgroundColor: color.pressed }]}>
          <Icon name="chat" size={20} color={color.ink} />
          <Text numberOfLines={1} style={[type.body, { flex: 1, fontWeight: !openId ? '600' : '500', color: color.ink }]}>Main chat</Text>
          <View style={{ paddingRight: 12 }}><MainStatus botId={bot.id} /></View>
        </Pressable>
        <Text style={[type.caption, { color: color.inkMuted, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 }]}>Side chats</Text>
        {chats.length === 0 && (
          <Text style={[type.caption, { color: color.inkSecondary, paddingHorizontal: 12, paddingBottom: 8 }]}>Start another conversation with {bot.name}. It runs alongside the main chat, with its own history.</Text>
        )}
        {rows.map((c) => (
          <View key={c.id} style={rowStyle(openId === c.id)}>
            {renaming === c.id ? (
              <TextInput value={name} onChangeText={setName} autoFocus selectTextOnFocus maxLength={60} returnKeyType="done" accessibilityLabel="Chat name"
                onSubmitEditing={() => saveName(c)} onBlur={() => saveName(c)}
                style={{ flex: 1, fontSize: 16, color: color.ink, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: color.primary }} />
            ) : (
              <Pressable accessibilityRole="button" accessibilityState={{ selected: openId === c.id }} onPress={() => onPick(c.id)} onLongPress={() => { setName(c.title); setRenaming(c.id); }}
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52 }}>
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={[type.body, { fontWeight: openId === c.id ? '600' : '500', color: color.ink }]}>{c.title}</Text>
                  {!!c.lastPreview && <Text numberOfLines={1} style={[type.caption, { color: color.inkSecondary }]}>{c.lastPreview}</Text>}
                </View>
                <Status c={c} />
              </Pressable>
            )}
            {renaming !== c.id && (
              <>
                <SmallButton icon="edit" label={`Rename ${c.title}`} onPress={() => { setName(c.title); setRenaming(c.id); }} />
                <SmallButton icon="trash" label={`Delete ${c.title}`} danger onPress={() => run(() => onDelete(c))} />
              </>
            )}
          </View>
        ))}
      </ScrollView>
      {!!error && <Text accessibilityLiveRegion="polite" style={[type.caption, { color: color.danger, paddingHorizontal: 12, paddingTop: 6 }]}>{error}</Text>}
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => run(onNew)}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, height: 54, marginTop: 6, paddingHorizontal: 12, borderRadius: 14, backgroundColor: pressed ? color.fill : 'transparent', opacity: busy ? 0.6 : 1 })}>
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: color.primary, alignItems: 'center', justifyContent: 'center' }}>
          {busy ? <ActivityIndicator size="small" color={color.onPrimary} /> : <Icon name="plus" size={20} color={color.onPrimary} />}
        </View>
        <Text style={[type.body, { fontWeight: '600', color: color.ink }]}>New side chat</Text>
      </Pressable>
    </Sheet>
  );
}
