import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from '../toast';
import { usePoll } from '../poll';
import { Linking, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { Bot, Client, OutsideExchange } from '../api';
import { BotAvatar } from '../components/BotAvatar';
import { Chip, Header, HeaderTitle, Notice, OutsideTag, PillButton, RoundButton, refreshLook } from '../components/ui';
import { color, type } from '../theme';

const STATUS_TEXT: Record<string, string> = {
  ready: 'Linked through Slack',
  paused: 'Paused. Nothing goes out until you turn it back on.',
  offline: 'Slack is not reachable right now. Messages wait here.',
  'not-set-up': 'The Slack link is not set up on this server yet.',
};

function when(ms: number) {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function gap(a: number, b: number) {
  const s = Math.round((b - a) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
}

function stateText(x: OutsideExchange) {
  if (x.direction === 'in') return 'Received';
  if (x.state === 'answered' && x.answeredAt) return x.type === 'A' || x.type === 'FYI' ? 'Sent' : `Answered in ${gap(x.createdAt, x.answeredAt)}`;
  if (x.state === 'sent' || x.state === 'sending') return 'Waiting';
  if (x.state === 'no-answer') return 'No answer';
  if (x.state === 'failed') return 'Failed';
  return x.state;
}

/**
 * A bot outside the app (Sheldon, through Slack): the link's state, Pause, and every exchange the other
 * bots had with it, as the web's details panel (web/src/components/OutsideDetails.tsx).
 */
export function Exchanges({ api, bot, bots, onBack, onOpenChatGPT }: { api: Client; bot: Bot; bots: Bot[]; onBack: () => void; onOpenChatGPT: () => void }) {
  const o = bot.outside!;
  const [list, setList] = useState<OutsideExchange[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { const r = await api.exchanges(bot.id); setList(r.exchanges); setErr(r.error); } catch (e: any) { setErr(e?.message ?? 'Couldn’t load the exchanges.'); }
  }, [api, bot.id]);
  usePoll(load, 15_000, [load, bot.lastActivityAt]);

  const askers = useMemo(() => {
    const names = new Map<string, string>();
    for (const x of list ?? []) if (x.botId && x.botName) names.set(x.botId, bots.find((b) => b.id === x.botId)?.name ?? x.botName);
    return [...names];
  }, [list, bots]);
  const shown = (list ?? []).filter((x) => (filter === 'all' ? true : filter === 'waiting' ? x.direction === 'out' && (x.state === 'sent' || x.state === 'sending') : x.botId === filter));

  const togglePause = async () => {
    setBusy(true);
    try { await api.setLinkPaused(bot.id, o.status !== 'paused'); } catch (e: any) { setErr(e?.message ?? 'Could not change the link.'); } finally { setBusy(false); }
  };

  const stateInk = (s: string) => (s === 'failed' || s === 'no-answer' ? color.problemInk : s === 'sent' || s === 'sending' ? color.link : color.inkMuted);

  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>{`Exchanges with ${bot.name}`}</HeaderTitle>
      </Header>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 48 }}
        refreshControl={<RefreshControl {...refreshLook()} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        <View style={{ alignItems: 'center', gap: 8 }}>
          <BotAvatar bot={bot} size={64} />
          <View style={{ alignSelf: 'center' }}><OutsideTag bot={bot} /></View>
          <Text style={[type.caption, { textAlign: 'center' }]}>{STATUS_TEXT[o.status] ?? o.status} · #{o.channelName}</Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {!!o.callUrl && <PillButton title="Open in ChatGPT" onPress={onOpenChatGPT} />}
            {(o.status === 'ready' || o.status === 'paused') && <PillButton kind="secondary" disabled={busy} title={o.status === 'paused' ? 'Turn the link back on' : 'Pause the link'} onPress={togglePause} />}
          </View>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          <Chip title="All" selected={filter === 'all'} onPress={() => setFilter('all')} />
          {askers.map(([id, name]) => <Chip key={id} title={name} selected={filter === id} onPress={() => setFilter(id)} />)}
          <Chip title={`Waiting${o.waiting ? ` (${o.waiting})` : ''}`} selected={filter === 'waiting'} onPress={() => setFilter('waiting')} />
        </ScrollView>
        {!!err && <Notice tone="problem">{err}</Notice>}
        {list === null ? <Text style={type.caption}>Loading…</Text> : shown.length === 0 ? (
          <Text style={type.caption}>Nothing here yet. When a bot messages {bot.name}, or {bot.name} writes to one, it shows up here.</Text>
        ) : shown.map((x) => (
          <View key={x.id} style={{ backgroundColor: x.direction === 'in' ? color.fill : color.surface, borderRadius: 16, borderWidth: 1, borderColor: color.hairline, padding: 14, gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, fontWeight: '600', color: color.ink }}>{x.direction === 'out' ? `${x.botName ?? 'You'} → ${bot.name}` : `${bot.name} → ${x.botName ?? 'group'}`}</Text>
              {!!x.type && <Text style={{ fontSize: 11, fontWeight: '700', color: color.inkMuted, letterSpacing: 0.5 }}>{x.type}</Text>}
              <Text style={{ fontSize: 12, color: color.timestamp }}>{when(x.createdAt)}</Text>
            </View>
            <Text selectable style={[type.body, { fontSize: 15, lineHeight: 21 }]}>{x.text}</Text>
            {x.replies.map((r, i) => (
              <View key={i} style={{ borderLeftWidth: 2, borderLeftColor: color.secondaryBorder, paddingLeft: 10, gap: 2 }}>
                <Text style={{ fontSize: 12, color: color.inkMuted }}>{bot.name} · {gap(x.createdAt, r.createdAt)} later</Text>
                <Text selectable style={[type.body, { fontSize: 15, lineHeight: 21 }]}>{r.text}</Text>
              </View>
            ))}
            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: stateInk(x.state) }}>{stateText(x)}</Text>
              {!!x.error && <Text style={{ fontSize: 12, color: color.problemInk, flexShrink: 1 }}>{x.error}</Text>}
              {!!x.link && (
                <Pressable accessibilityRole="link" hitSlop={8} onPress={() => Linking.openURL(x.link!).catch(() => toast("Couldn't open that link."))}>
                  <Text style={{ fontSize: 12, color: color.link }}>Open in Slack ↗</Text>
                </Pressable>
              )}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
