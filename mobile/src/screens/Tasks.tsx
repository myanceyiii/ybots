import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSimple } from '../simple';
import { usePoll } from '../poll';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { Bot, Client, RemovedTask, Task } from '../api';
import { BotAvatar } from '../components/BotAvatar';
import { Icon } from '../components/Icon';
import { Chip, Field, Header, HeaderTitle, Notice, PillButton, RoundButton, Sheet, SheetRow, UndoBar, refreshLook } from '../components/ui';
import { color, type, appName } from '../theme';

type Filter = 'open' | 'done' | 'all';

const STATE_LABEL: Record<Task['state'], string> = { working: 'Working on it', needs_input: 'Waiting on you', done: 'Done' };
const RANK: Record<Task['state'], number> = { needs_input: 0, working: 1, done: 2 };
const chipLabel = (t: Task) => (t.stale ? 'Stalled' : STATE_LABEL[t.state]);

function when(t: Task): string {
  const m = Math.round((Date.now() - t.updatedAt) / 60_000);
  const ago = m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : m < 48 * 60 ? 'yesterday' : `${Math.round(m / 1440)} days ago`;
  if (t.stale) return `No update since ${ago}`;
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
  // The row whose Done / Edit / Delete sheet is open, the task being edited, and the last delete (10 s Undo).
  const [menu, setMenu] = useState<Task | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const [draft, setDraft] = useState<{ title: string; note: string; state: Task['state'] }>({ title: '', note: '', state: 'working' });
  const [undo, setUndo] = useState<{ botId: string; task: RemovedTask } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(undoTimer.current), []);
  const botId = bot?.id;
  const load = useCallback(async () => {
    try { setTasks((botId ? await api.botTasks(botId) : await api.tasks()).tasks); setError(null); } catch (e: any) { setError(e?.message ?? 'Couldn’t reach your server.'); }
  }, [api, botId]);
  // Only while the app is open in front (src/poll.ts).
  usePoll(load, 10_000, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (e: any) { setError(e?.message ?? 'That didn’t work. Try again.'); }
    await load();
  };
  const markDone = (t: Task) => { setMenu(null); act(() => api.editTask(t.botId, t.id, { state: 'done' })); };
  const startEdit = (t: Task) => { setMenu(null); setDraft({ title: t.title, note: t.note, state: t.state }); setEditing(t); };
  const saveEdit = () => {
    const t = editing;
    if (!t || !draft.title.trim()) return;
    setEditing(null);
    act(() => api.editTask(t.botId, t.id, { title: draft.title.trim(), note: draft.note.trim(), state: draft.state }));
  };
  const remove = (t: Task) => {
    setMenu(null);
    setTasks((l) => l && l.filter((x) => x.id !== t.id));
    act(async () => {
      const r = await api.deleteTask(t.botId, t.id);
      setUndo({ botId: t.botId, task: r.removed });
      clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => setUndo(null), 10_000);
    });
  };
  const undoDelete = () => { if (!undo) return; const u = undo; setUndo(null); act(() => api.restoreTask(u.botId, u.task)); };

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
            <Pressable key={t.id} accessibilityRole="button" accessibilityLabel={`${t.title}. ${chipLabel(t)}.${b ? ` Open ${b.name}` : ''}`} disabled={!b} onPress={() => b && onOpen(b.id)} onLongPress={() => setMenu(t)}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14, borderRadius: 18, backgroundColor: pressed ? color.pressed : color.surface, borderWidth: 1, borderColor: need ? color.alertBorder : color.hairline })}>
              <View style={{ width: 22, height: 22, marginTop: 1, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: done ? color.primary : 'transparent', borderWidth: done ? 0 : 2, borderColor: need ? color.problemInk : color.secondaryBorder }}>
                {done && <Icon name="check" size={14} color={color.onPrimary} strokeWidth={2.6} />}
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                  <Text style={{ flex: 1, fontSize: 16, lineHeight: 22, fontWeight: '500', color: done ? color.inkMuted : color.ink }}>{t.title}</Text>
                  <Pressable accessibilityRole="button" accessibilityLabel={`More for ${t.title}`} hitSlop={10} onPress={() => setMenu(t)}
                    style={({ pressed }) => ({ width: 28, height: 28, marginTop: -3, marginRight: -4, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.fill : 'transparent' })}>
                    <Icon name="more" size={20} color={color.inkMuted} />
                  </Pressable>
                </View>
                {!!t.note && <Text style={{ fontSize: 14, lineHeight: 20, color: color.inkSecondary }}>{t.note}</Text>}
                {t.stale && <Text style={{ fontSize: 14, lineHeight: 20, color: color.inkSecondary }}>{b?.name ?? 'The bot'} isn’t working on this now. Mark it done or delete it if it’s finished.</Text>}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
                  {!bot && b && <><BotAvatar bot={b} size={18} server={api.server} auth={api.authHeader} /><Text style={{ fontSize: 13, color: color.inkMuted }}>{b.name} ·</Text></>}
                  <Text style={{ fontSize: 13, color: color.inkMuted }}>{when(t)}</Text>
                  <View style={{ flexGrow: 1 }} />
                  <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: need ? color.problemFill : done || t.stale ? color.fill : color.infoFill }}>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: need ? color.problemInk : done || t.stale ? color.inkMuted : color.link }}>{chipLabel(t)}</Text>
                  </View>
                </View>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
      <Sheet visible={!!menu} onClose={() => setMenu(null)} title={menu?.title}>
        {menu && menu.state !== 'done' && <SheetRow icon="check" title="Mark done" onPress={() => markDone(menu)} />}
        {menu && <SheetRow icon="edit" title="Edit" onPress={() => startEdit(menu)} />}
        {menu && <SheetRow icon="trash" title="Delete" danger onPress={() => remove(menu)} />}
      </Sheet>
      <Sheet visible={!!editing} onClose={() => setEditing(null)} title="Edit task">
        <View style={{ gap: 10, paddingHorizontal: 4 }}>
          <Field value={draft.title} onChangeText={(v) => setDraft((d) => ({ ...d, title: v }))} placeholder="Title" accessibilityLabel="Task title" maxLength={300} />
          <Field value={draft.note} onChangeText={(v) => setDraft((d) => ({ ...d, note: v }))} placeholder="Note (optional)" accessibilityLabel="Note" multiline maxLength={2000} style={{ borderRadius: 18 }} />
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {(['working', 'needs_input', 'done'] as const).map((st) => <Chip key={st} title={STATE_LABEL[st]} selected={draft.state === st} onPress={() => setDraft((d) => ({ ...d, state: st }))} />)}
          </View>
          <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'flex-end', paddingTop: 4 }}>
            <PillButton title="Cancel" kind="secondary" onPress={() => setEditing(null)} />
            <PillButton title="Save" onPress={saveEdit} disabled={!draft.title.trim()} />
          </View>
        </View>
      </Sheet>
      {undo && <UndoBar text={`Deleted “${undo.task.title}”`} onPress={undoDelete} />}
    </View>
  );
}
