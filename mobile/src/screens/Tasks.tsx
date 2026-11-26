import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSimple } from '../simple';
import { usePoll } from '../poll';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { Bot, Client, Task } from '../api';
import { BotAvatar } from '../components/BotAvatar';
import { Icon } from '../components/Icon';
import { Chip, Header, HeaderTitle, Notice, RoundButton, refreshLook } from '../components/ui';
import { color, type } from '../theme';

type Filter = 'open' | 'done' | 'all';

const STATE_LABEL: Record<Task['state'], string> = { working: 'Working on it', needs_input: 'Waiting on you', done: 'Done' };
const RANK: Record<Task['state'], number> = { needs_input: 0, working: 1, done: 2 };

function when(t: Task): string {
  const m = Math.round((Date.now() - t.updatedAt) / 60_000);
  const ago = m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : m < 48 * 60 ? 'yesterday' : `${Math.round(m / 1440)} days ago`;
  return t.state === 'done' ? `Completed ${ago}` : t.state === 'needs_input' ? `Asked ${ago}` : `Updated ${ago}`;
}

/**
 * Tasks, as on the web and Windows app's Tasks page: every piece of a multi-part request a bot is tracking,
 * waiting-on-you first. With `bot` it lists that bot's tasks only (opened from its chat). A row opens the bot's chat.
 */
export function Tasks({ api, bots, bot, onBack, onOpen }: { api: Client; bots: Bot[]; bot?: Bot; onBack: () => void; onOpen: (botId: string) => void }) {
  const simple = useSimple();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const [refreshing, setRefreshing] = useState(false);
  const botId = bot?.id;
  const load = useCallback(async () => {
    try { setTasks((botId ? await api.botTasks(botId) : await api.tasks()).tasks); setError(null); } catch (e: any) { setError(e?.message ?? 'Couldn’t reach your server.'); }
  }, [api, botId]);
  // Only while the app is open in front (src/poll.ts).
  usePoll(load, 10_000, [load]);

  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const open = tasks?.filter((t) => t.state !== 'done').length ?? 0;
  const shown = useMemo(() => (tasks ?? [])
    .filter((t) => filter === 'all' || (filter === 'done' ? t.state === 'done' : t.state !== 'done'))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || b.updatedAt - a.updatedAt), [tasks, filter]);

  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>{bot ? (simple ? `What ${bot.name} is working on` : `${bot.name}'s tasks`) : 'Tasks'}</HeaderTitle>
      </Header>
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 10 }}>
        <Chip title={open ? `In progress ${open}` : 'In progress'} selected={filter === 'open'} onPress={() => setFilter('open')} />
        <Chip title="Done" selected={filter === 'done'} onPress={() => setFilter('done')} />
        <Chip title="All" selected={filter === 'all'} onPress={() => setFilter('all')} />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 48, gap: 10 }}
        refreshControl={<RefreshControl {...refreshLook()} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        {error && <Notice tone="problem">{error}</Notice>}
        {tasks === null && !error ? <ActivityIndicator color={color.inkMuted} style={{ marginTop: 32 }} /> : shown.length === 0 && !error ? (
          <View style={{ alignItems: 'center', paddingTop: 56, paddingHorizontal: 24, gap: 8 }}>
            <Text style={{ fontSize: 17, fontWeight: '600', color: color.ink }}>{filter === 'done' ? 'Nothing finished yet' : filter === 'all' ? 'No tasks yet' : 'Nothing in progress'}</Text>
            <Text style={[type.caption, { textAlign: 'center', fontSize: 15, lineHeight: 21 }]}>{bot ? `Ask ${bot.name} for something with several parts and each part gets its own row here, so you can see how far along it is.` : 'Give a bot a request with several parts and each part gets its own row here, so progress is easy to follow.'}</Text>
          </View>
        ) : shown.map((t) => {
          const b = byId.get(t.botId);
          const need = t.state === 'needs_input';
          const done = t.state === 'done';
          return (
            <Pressable key={t.id} accessibilityRole="button" accessibilityLabel={`${t.title}. ${STATE_LABEL[t.state]}.${b ? ` Open ${b.name}` : ''}`} disabled={!b} onPress={() => b && onOpen(b.id)}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14, borderRadius: 18, backgroundColor: pressed ? color.pressed : color.surface, borderWidth: 1, borderColor: need ? color.alertBorder : color.hairline })}>
              <View style={{ width: 22, height: 22, marginTop: 1, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: done ? color.primary : 'transparent', borderWidth: done ? 0 : 2, borderColor: need ? color.problemInk : color.secondaryBorder }}>
                {done && <Icon name="check" size={14} color={color.onPrimary} strokeWidth={2.6} />}
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: '500', color: done ? color.inkMuted : color.ink }}>{t.title}</Text>
                {!!t.note && <Text style={{ fontSize: 14, lineHeight: 20, color: color.inkSecondary }}>{t.note}</Text>}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
                  {!bot && b && <><BotAvatar bot={b} size={18} server={api.server} auth={api.authHeader} /><Text style={{ fontSize: 13, color: color.inkMuted }}>{b.name} ·</Text></>}
                  <Text style={{ fontSize: 13, color: color.inkMuted }}>{when(t)}</Text>
                  <View style={{ flexGrow: 1 }} />
                  <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: need ? color.problemFill : done ? color.fill : color.infoFill }}>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: need ? color.problemInk : done ? color.inkMuted : color.link }}>{STATE_LABEL[t.state]}</Text>
                  </View>
                </View>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
