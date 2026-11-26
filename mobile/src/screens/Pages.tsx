import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSimple } from '../simple';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import type { Bot, Client, PageShelfItem } from '../api';
import { Icon, type IconName } from '../components/Icon';
import { Header, HeaderTitle, Notice, PillButton, RoundButton, Sheet, SheetRow, refreshLook } from '../components/ui';
import { onPageEvent, onPagesEvent } from '../pageBus';
import { color, type } from '../theme';

/**
 * A bot's Pages, as in the web and Windows app's Pages tab (web/src/components/config/PagesTab.tsx): the
 * living documents and calculators it made or you saved from a chat answer (server/src/page-shelf.ts).
 * A row opens the Page (PageScreen), where it keeps working. Long press or ⋯ for pin, rename and delete;
 * a delete can be undone for a few seconds. The bot's other files stay in its files screen.
 */

const KIND: Record<PageShelfItem['kind'], { icon: IconName; label: string }> = {
  calculator: { icon: 'calc', label: 'Calculator' },
  chart: { icon: 'chart', label: 'Chart' },
  form: { icon: 'check', label: 'Form' },
  checklist: { icon: 'tasks', label: 'Checklist' },
  table: { icon: 'table', label: 'Table' },
  doc: { icon: 'file', label: 'Page' },
};

function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : m < 48 * 60 ? 'yesterday' : `${Math.round(m / 1440)} days ago`;
}
const originText = (p: PageShelfItem) =>
  !p.origin ? '' : p.origin.kind === 'view' ? `saved from ${p.origin.chatTitle}` : p.origin.kind === 'person' ? `made by you in ${p.origin.chatTitle}` : `made in ${p.origin.chatTitle}`;

export function Pages({ api, bot, onBack, onOpen }: { api: Client; bot: Bot; onBack: () => void; onOpen: (path: string) => void }) {
  const simple = useSimple();
  const [pages, setPages] = useState<PageShelfItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [menu, setMenu] = useState<PageShelfItem | null>(null);
  const [renaming, setRenaming] = useState<PageShelfItem | null>(null);
  const [name, setName] = useState('');
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    try { setPages((await api.pageList(bot.id)).pages); setError(null); }
    catch (e: any) { setError(e?.message ?? 'Couldn’t reach your server.'); }
  }, [api, bot.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const again = (ev: { botId: string }) => { if (ev.botId === bot.id) { clearTimeout(t); t = setTimeout(load, 400); } };
    const a = onPageEvent(again);
    const b = onPagesEvent(again);
    return () => { a(); b(); clearTimeout(t); };
  }, [bot.id, load]);
  useEffect(() => () => clearTimeout(undoTimer.current), []);

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!pages || !words.length) return pages ?? [];
    return pages.filter((p) => { const hay = `${p.title} ${p.snippet} ${KIND[p.kind].label}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  }, [pages, q]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await load(); } catch (e: any) { setError(e?.message ?? 'That didn’t go through'); }
  };
  const pin = (p: PageShelfItem) => {
    setMenu(null);
    setPages((l) => l && l.map((x) => (x.path === p.path ? { ...x, pinned: !p.pinned } : x)));
    act(() => api.pagePin(bot.id, p.path, !p.pinned));
  };
  const remove = (p: PageShelfItem) => {
    setMenu(null);
    setPages((l) => l && l.filter((x) => x.path !== p.path));
    act(async () => {
      const r = await api.pageDelete(bot.id, p.path);
      setUndo({ id: r.id, title: p.title });
      clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => setUndo(null), 10_000);
    });
  };
  const rename = () => {
    const p = renaming;
    setRenaming(null);
    const t = name.trim();
    if (!p || !t || t === p.title) return;
    setPages((l) => l && l.map((x) => (x.path === p.path ? { ...x, title: t } : x)));
    act(() => api.pageRename(bot.id, p.path, t));
  };

  return (
    <View style={{ flex: 1 }}>
      <Header>
        <RoundButton icon="back" label="Back" onPress={onBack} />
        <HeaderTitle>{simple ? 'Lists and pages' : `${bot.name}'s pages`}</HeaderTitle>
      </Header>
      {!!pages && pages.length > 3 && (
        <View style={{ marginHorizontal: 16, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, height: 42, borderRadius: 21, backgroundColor: color.fill }}>
          <Icon name="search" size={17} color={color.inkMuted} />
          <TextInput value={q} onChangeText={setQ} placeholder="Search Pages" placeholderTextColor={color.inkMuted} accessibilityLabel="Search Pages" returnKeyType="search" autoCorrect={false}
            style={{ flex: 1, fontSize: 16, color: color.ink, paddingVertical: 0 }} />
          {!!q && <Pressable accessibilityRole="button" accessibilityLabel="Clear" onPress={() => setQ('')} hitSlop={10}><Icon name="close" size={16} color={color.inkMuted} /></Pressable>}
        </View>
      )}
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 48, gap: 10 }}
        refreshControl={<RefreshControl {...refreshLook()} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        {undo && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 14, backgroundColor: color.fill }}>
            <Text style={[type.caption, { flex: 1, fontSize: 15 }]} numberOfLines={1}>Deleted “{undo.title}”</Text>
            <PillButton title="Undo" kind="secondary" onPress={() => { const id = undo.id; setUndo(null); act(() => api.pageUndelete(bot.id, id)); }} />
          </View>
        )}
        {error && <Notice tone="problem">{error}</Notice>}
        {pages === null && !error ? <ActivityIndicator color={color.inkMuted} style={{ marginTop: 32 }} /> : !pages?.length && !error ? (
          <View style={{ alignItems: 'center', paddingTop: 56, paddingHorizontal: 24, gap: 8 }}>
            <Text style={{ fontSize: 17, fontWeight: '600', color: color.ink }}>No Pages yet</Text>
            <Text style={[type.caption, { textAlign: 'center', fontSize: 15, lineHeight: 21 }]}>Interactive pages {bot.name} makes, like calculators, checklists and plans, are kept here. Tap “Save to Pages” under an answer to keep one.</Text>
          </View>
        ) : !shown.length && q ? (
          <Text style={[type.caption, { textAlign: 'center', fontSize: 15, marginTop: 32 }]}>No Page matches “{q}”.</Text>
        ) : shown.map((p) => {
          const K = KIND[p.kind];
          return (
            <Pressable key={p.path} accessibilityRole="button" accessibilityLabel={`${p.title}. ${K.label}${p.pinned ? ', pinned' : ''}. Updated ${ago(p.updatedAt)}.`}
              onPress={() => onOpen(p.path)} onLongPress={() => setMenu(p)}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 18, backgroundColor: pressed ? color.pressed : color.surface, borderWidth: 1, borderColor: color.hairline })}>
              <View style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: color.fill }}>
                <Icon name={K.icon} size={20} color={color.ink} />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  {p.pinned && <Icon name="pin" size={13} color={color.inkMuted} />}
                  <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 16, lineHeight: 22, fontWeight: '500', color: color.ink }}>{p.title}</Text>
                </View>
                {!!p.snippet && <Text numberOfLines={1} style={{ fontSize: 14, lineHeight: 20, color: color.inkSecondary }}>{p.snippet}</Text>}
                <Text numberOfLines={1} style={{ fontSize: 13, color: color.inkMuted }}>{K.label} · {ago(p.updatedAt)}{p.origin ? ` · ${originText(p)}` : ''}</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={`More for ${p.title}`} hitSlop={10} onPress={() => setMenu(p)} style={{ padding: 6 }}>
                <Icon name="more" size={20} color={color.inkMuted} />
              </Pressable>
            </Pressable>
          );
        })}
      </ScrollView>
      <Sheet visible={!!menu} onClose={() => setMenu(null)} title={menu?.title}>
        {menu && <>
          <SheetRow icon="pin" title={menu.pinned ? 'Unpin' : 'Pin to the top'} onPress={() => pin(menu)} />
          <SheetRow icon="edit" title="Rename" onPress={() => { setName(menu.title); setRenaming(menu); setMenu(null); }} />
          <SheetRow icon="trash" title="Delete" danger onPress={() => remove(menu)} />
        </>}
      </Sheet>
      <Sheet visible={!!renaming} onClose={() => setRenaming(null)} title="Rename Page">
        <View style={{ gap: 12, paddingHorizontal: 12, paddingBottom: 8 }}>
          <TextInput value={name} onChangeText={setName} autoFocus selectTextOnFocus onSubmitEditing={rename} returnKeyType="done" accessibilityLabel="Page name"
            style={{ fontSize: 17, color: color.ink, paddingHorizontal: 14, height: 48, borderRadius: 14, backgroundColor: color.fill }} />
          <PillButton title="Save" onPress={rename} disabled={!name.trim()} />
        </View>
      </Sheet>
    </View>
  );
}
