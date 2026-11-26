// Search every message: the open conversations and the earlier ones. The same search as the web's
// (server/src/chat-extras.ts GET /api/search); a tap opens the chat at that message.
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { Bot, Client, SearchHit } from '../api';
import { BotAvatar } from '../components/BotAvatar';
import { Icon } from '../components/Icon';
import { Header, RoundButton } from '../components/ui';
import { color, type } from '../theme';

const day = (t: number) => {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};

/** The snippet with the found words in bold. */
function Snippet({ text, q }: { text: string; q: string }) {
  const words = q.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return <Text numberOfLines={3} style={[type.preview, { lineHeight: 20 }]}>{text}</Text>;
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'));
  return (
    <Text numberOfLines={3} style={[type.preview, { lineHeight: 20 }]}>
      {parts.map((p, i) => (i % 2 ? <Text key={i} style={{ fontWeight: '700', color: color.ink }}>{p}</Text> : p))}
    </Text>
  );
}

/** Messages with all the words of `query`, found a moment after typing stops. Nothing under two letters. */
export function MessageHits({ api, bots, query, onOpen }: { api: Client; bots: Bot[]; query: string; onOpen: (hit: SearchHit) => void }) {
  const q = query.trim();
  const [state, setState] = useState<{ q: string; hits: SearchHit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    setError(null);
    if (q.length < 2) { setState(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      api.search(q).then((r) => { if (alive) setState({ q, hits: r.hits }); }, (e) => { if (alive) setError(e?.message ?? 'The search did not work.'); });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [api, q, again]);
  if (q.length < 2) return null;
  const loading = !error && state?.q !== q;
  return (
    <View>
      <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase', color: color.inkMuted, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6 }}>Messages{state && !loading ? ` · ${state.hits.length}${state.hits.length >= 60 ? '+' : ''}` : ''}</Text>
      {loading && <ActivityIndicator style={{ marginVertical: 14 }} color={color.inkMuted} />}
      {!!error && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18 }}>
          <Text style={[type.caption, { flex: 1, color: color.problemInk }]}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={() => setAgain((n) => n + 1)} hitSlop={8}><Text style={{ fontSize: 14, fontWeight: '600', color: color.ink }}>Try again</Text></Pressable>
        </View>
      )}
      {!loading && state && !state.hits.length && <Text style={[type.caption, { paddingHorizontal: 18, paddingVertical: 6 }]}>No messages have “{q}”.</Text>}
      {!loading && state?.hits.map((h) => {
        const bot = bots.find((b) => b.id === h.botId);
        if (!bot) return null;
        return (
          <Pressable key={`${h.chatId}:${h.generation}:${h.seq}`} accessibilityRole="button" accessibilityLabel={`${bot.name}, ${h.who === 'you' ? 'you' : h.from ?? bot.name}: ${h.snippet}`} onPress={() => onOpen(h)}
            style={({ pressed }) => ({ flexDirection: 'row', gap: 12, paddingVertical: 10, paddingHorizontal: 16, backgroundColor: pressed ? color.pressed : 'transparent' })}>
            <BotAvatar bot={bot} size={40} server={api.server} auth={api.authHeader} still crop="portrait" />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 15, fontWeight: '600', color: color.ink }}>{bot.name}{h.sideTitle ? ` · ${h.sideTitle}` : ''}</Text>
                {!h.current && <View style={{ paddingHorizontal: 6, borderRadius: 4, backgroundColor: color.fill }}><Text style={{ fontSize: 11, lineHeight: 16, fontWeight: '600', color: color.inkMuted }}>Earlier</Text></View>}
                <View style={{ flex: 1 }} />
                <Text style={[type.time, { fontSize: 12.5 }]}>{day(h.createdAt)}</Text>
              </View>
              <Text numberOfLines={1} style={[type.caption, { fontSize: 12.5 }]}>{h.who === 'you' ? 'You' : h.from ?? bot.name}</Text>
              <Snippet text={h.snippet} q={q} />
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The search on its own screen (from a chat's + menu; the bot list has it in its own search). */
export function Search({ api, bots, onBack, onOpen }: { api: Client; bots: Bot[]; onBack: () => void; onOpen: (hit: SearchHit) => void }) {
  const [query, setQuery] = useState('');
  return (
    <View style={{ flex: 1, backgroundColor: color.ground }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <View style={{ flex: 1, height: 46, borderRadius: 23, backgroundColor: color.fill, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14 }}>
          <Icon name="search" size={19} color={color.inkMuted} />
          <TextInput autoFocus value={query} onChangeText={setQuery} placeholder="Search messages" placeholderTextColor={color.timestamp} returnKeyType="search"
            style={{ flex: 1, fontSize: 16, color: color.ink, paddingVertical: 0 }} />
          {!!query && <Pressable accessibilityRole="button" accessibilityLabel="Clear" onPress={() => setQuery('')} hitSlop={8}><Icon name="close" size={16} color={color.inkMuted} /></Pressable>}
        </View>
      </Header>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: 24 }}>
        {query.trim().length < 2
          ? <Text style={[type.caption, { textAlign: 'center', padding: 32 }]}>Type a word or two. Every message is searched, in the open conversations and the earlier ones.</Text>
          : <MessageHits api={api} bots={bots} query={query} onOpen={onOpen} />}
      </ScrollView>
    </View>
  );
}
