// A chat's earlier conversations: "New conversation" never deletes anything, so each one can be read
// again, carried on, or shared. The same feature as the web's Earlier conversations window (HistoryModal.tsx).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBack } from '../back';
import { tap } from '../haptics';
import { toast } from '../toast';
import { ActivityIndicator, Alert, FlatList, Platform, Pressable, ScrollView, Share, Text, View } from 'react-native';
import { File as FsFile, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { Bot, Client, ConversationInfo, Row } from '../api';
import { MessageAttachments } from '../components/Attachments';
import { Markdown } from '../components/Markdown';
import { Header, HeaderTitle, Notice, PillButton, RoundButton } from '../components/ui';
import { splitReply } from '../messageText';
import { sized } from '../prefs';
import { color, type } from '../theme';

const day = (t: number) => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Hand a conversation to another app (or save it) as a Markdown file. Without a number: the open conversation. */
export async function shareConversation(api: Client, chatId: string, generation?: number) {
  const { name, markdown } = await api.exportChat(chatId, generation);
  if (Platform.OS === 'web' || !(await Sharing.isAvailableAsync())) { await Share.share({ message: markdown, title: name }); return; }
  const file = new FsFile(Paths.cache, name.replace(/[^\w .()-]+/g, '_') || 'Conversation.md');
  if (file.exists) file.delete();
  file.create({ intermediates: true });
  file.write(markdown);
  await Sharing.shareAsync(file.uri, { mimeType: 'text/markdown', dialogTitle: name });
}

export function History({ api, bot, chatId, startGeneration, focusSeq, onBack, onContinued }: {
  api: Client;
  /** The bot the chat belongs to (its name, and the Library its files live in). */
  bot: Bot;
  /** The chat: the bot's own id for its main chat, or a side chat's id. */
  chatId: string;
  /** Open straight on one conversation (a search result), optionally at one message. */
  startGeneration?: number; focusSeq?: number;
  onBack: () => void;
  /** An earlier conversation was reopened: the chat now shows it. */
  onContinued: () => void;
}) {
  const [list, setList] = useState<ConversationInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(startGeneration ?? null);
  const load = useCallback(() => {
    setError(null);
    api.conversations(chatId).then((r) => setList(r.conversations), (e) => setError(e?.message ?? 'Could not load the conversations.'));
  }, [api, chatId]);
  useEffect(load, [load]);
  // Hold an earlier conversation to delete it for good (never the open one). Asks first: there is no undo.
  const remove = (c: ConversationInfo) => {
    tap('medium');
    Alert.alert('Delete this conversation?', `"${c.title}" and its ${c.messages} ${c.messages === 1 ? 'message' : 'messages'} are removed for good. ${bot.name} will no longer be able to look back at it.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { api.deleteConversation(chatId, c.generation).then((r) => { setList(r.conversations); tap('success'); toast('Conversation deleted'); }, (e: any) => { tap('error'); setError(e?.message ?? 'Could not delete it.'); }); } },
    ]);
  };
  // The phone's back button returns to the list from a conversation opened out of it.
  useBack(open !== null && !(startGeneration != null && open === startGeneration), () => setOpen(null));

  if (open !== null) {
    return <Reading api={api} bot={bot} chatId={chatId} generation={open} info={list?.find((c) => c.generation === open)} focusSeq={open === startGeneration ? focusSeq : undefined}
      onBack={() => (startGeneration != null && open === startGeneration ? onBack() : setOpen(null))} onContinued={onContinued} />;
  }
  const earlier = (list ?? []).filter((c) => !c.current);
  return (
    <View style={{ flex: 1, backgroundColor: color.ground }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>Earlier conversations</HeaderTitle>
      </Header>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
        <Text style={[type.caption, { marginHorizontal: 4 }]}>Every conversation with {bot.name} is kept. Open one to read it, carry it on or share it. Hold one to delete it.</Text>
        {error && <Notice tone="problem">{error}</Notice>}
        {error && <PillButton title="Try again" kind="secondary" onPress={load} />}
        {!list && !error && <ActivityIndicator style={{ marginTop: 24 }} color={color.inkMuted} />}
        {list && !earlier.length && <Notice>No earlier conversations yet. When you start a new conversation, the one before it shows up here.</Notice>}
        {(list ?? []).map((c) => (
          <Pressable key={c.generation} accessibilityRole="button" accessibilityLabel={`${c.title}, ${c.messages} messages, ${day(c.lastAt)}${c.current ? ', open now' : ''}`} onPress={() => setOpen(c.generation)} onLongPress={c.current ? undefined : () => remove(c)}
            accessibilityActions={c.current ? undefined : [{ name: 'delete', label: 'Delete' }]} onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'delete') remove(c); }}
            style={({ pressed }) => ({ backgroundColor: pressed ? color.pressed : color.fill, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 16, gap: 4 })}>
            <Text numberOfLines={2} style={[type.body, { fontWeight: '500' }]}>{c.title}</Text>
            <Text style={[type.caption, { fontSize: 13 }]}>{c.current ? 'Open now · ' : ''}{day(c.lastAt)} · {c.messages} {c.messages === 1 ? 'message' : 'messages'}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

/** One conversation, read-only: the messages as they were, with Continue and Share underneath. */
function Reading({ api, bot, chatId, generation, info, focusSeq, onBack, onContinued }: { api: Client; bot: Bot; chatId: string; generation: number; info?: ConversationInfo; focusSeq?: number; onBack: () => void; onContinued: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'earlier' | 'open' | 'share' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const listRef = useRef<FlatList<Row>>(null);
  const load = useCallback(() => {
    setError(null);
    api.conversationRows(chatId, generation).then((r) => setRows(r.rows), (e) => setError(e?.message ?? 'Could not load this conversation.'));
  }, [api, chatId, generation]);
  useEffect(load, [load]);
  const shown = (rows ?? []).filter((r) => (r.body.type === 'message' && (r.body.text || r.body.attachments?.length)) || (r.body.type === 'card' && r.body.title) || (r.body.type === 'notice' && r.body.text));
  const first = rows?.[0]?.seq ?? 1;
  const earlier = () => {
    if (busy || first <= 1) return;
    setBusy('earlier');
    api.conversationRows(chatId, generation, first).then((r) => setRows((cur) => [...r.rows, ...(cur ?? [])]), (e) => setNote(e?.message ?? 'Could not load earlier messages.')).finally(() => setBusy(null));
  };
  // A search result's message: bring it into view (loading earlier pages until it is there).
  const focused = useRef(false);
  useEffect(() => {
    if (!focusSeq || focused.current || !rows) return;
    const i = shown.findIndex((r) => r.seq === focusSeq);
    if (i >= 0) { focused.current = true; setTimeout(() => listRef.current?.scrollToIndex({ index: i, viewPosition: 0.3, animated: false }), 80); }
    else if (first > focusSeq) earlier();
    else focused.current = true;
  /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [rows, focusSeq]);
  const current = info?.current;
  return (
    <View style={{ flex: 1, backgroundColor: color.ground }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <View style={{ flex: 1, marginLeft: 4 }}>
          <Text numberOfLines={1} style={[type.screenTitle, { fontSize: 18 }]}>{info?.title ?? 'Conversation'}</Text>
          <Text numberOfLines={1} style={[type.caption, { fontSize: 13 }]}>{bot.name}{info ? ` · ${day(info.lastAt)}` : ''}{current ? ' · open now' : ''}</Text>
        </View>
      </Header>
      {error ? (
        <View style={{ padding: 16, gap: 10 }}><Notice tone="problem">{error}</Notice><PillButton title="Try again" kind="secondary" onPress={load} /></View>
      ) : !rows ? <ActivityIndicator style={{ marginTop: 32 }} color={color.inkMuted} /> : (
        <FlatList ref={listRef} data={shown} keyExtractor={(r) => String(r.seq)} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10, gap: 10 }}
          onScrollToIndexFailed={(info: { averageItemLength: number; index: number }) => listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })}
          ListHeaderComponent={first > 1 ? <PillButton title={busy === 'earlier' ? 'Loading…' : 'Show earlier messages'} kind="secondary" disabled={!!busy} onPress={earlier} /> : undefined}
          ListEmptyComponent={<Text style={[type.caption, { textAlign: 'center', paddingTop: 40 }]}>Nothing was said in this conversation.</Text>}
          renderItem={({ item: r }) => {
            const b = r.body;
            const lit = r.seq === focusSeq ? { backgroundColor: color.infoFill, borderRadius: 14, padding: 6, margin: -6 } : null;
            if (b.type === 'notice') return <Text style={[type.caption, { alignSelf: 'center', textAlign: 'center', fontSize: 13 }]}>{b.text}</Text>;
            if (b.type === 'card') return <Text style={[type.caption, { fontSize: 13, color: color.inkMuted }]}>Card: {b.title}</Text>;
            const mine = b.role === 'user' && (!b.from || b.from.kind === 'voice');
            const who = b.role === 'user' ? (b.from?.name ?? null) : (b.from?.name ?? bot.name);
            return (
              <View style={lit}>
                {!!b.attachments?.length && <MessageAttachments api={api} ownerId={bot.id} files={b.attachments} mine={mine} />}
                {!!b.text && (
                  <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '86%', backgroundColor: mine ? color.bubbleMine : color.fill, borderRadius: 20, paddingVertical: 10, paddingHorizontal: 15 }}>
                    {!mine && !!who && <Text style={[type.caption, { fontSize: 13, fontWeight: '600', marginBottom: 2 }]}>{who}</Text>}
                    {mine ? <Text selectable style={{ color: color.onBubbleMine, fontSize: sized(16), lineHeight: sized(22) }}>{splitReply(b.text).body}</Text> : <Markdown text={b.text} />}
                  </View>
                )}
                <Text style={[type.time, { alignSelf: mine ? 'flex-end' : 'flex-start', marginTop: 3, marginHorizontal: 6 }]}>{day(r.createdAt)} {clock(r.createdAt)}</Text>
              </View>
            );
          }} />
      )}
      {!!note && <Text accessibilityLiveRegion="polite" style={[type.caption, { color: color.problemInk, marginHorizontal: 20, marginBottom: 6 }]}>{note}</Text>}
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 14 }}>
        {!current && (
          <PillButton title={busy === 'open' ? 'Opening…' : 'Continue'} disabled={!!busy || !rows} style={{ flex: 1.6 }} onPress={() => {
            setBusy('open'); setNote(null);
            api.openConversation(chatId, generation).then(() => onContinued(), (e) => { setNote(e?.message ?? 'Could not open it.'); setBusy(null); });
          }} />
        )}
        <PillButton title={busy === 'share' ? 'Getting it ready…' : 'Share'} icon="share" kind="secondary" disabled={!!busy || !rows} style={{ flex: 1 }} onPress={() => {
          setBusy('share'); setNote(null);
          shareConversation(api, chatId, generation).catch((e) => setNote(e?.message ?? 'Could not share it.')).finally(() => setBusy(null));
        }} />
      </View>
    </View>
  );
}
