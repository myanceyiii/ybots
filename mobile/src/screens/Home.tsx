import { useEffect, useMemo, useState } from 'react';
import Constants from 'expo-constants';
import { ActivityIndicator, Alert, Platform, Pressable, RefreshControl, ScrollView, Text, TextInput, useWindowDimensions, View, type StyleProp, type TextStyle } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { errorDetails } from '../components/ErrorBoundary';
import { connectionNow } from '../connection';
import { toast } from '../toast';
import { downloadMyData } from '../exportData';
import type { Bot, Client, SearchHit } from '../api';
import { BotAvatar } from '../components/BotAvatar';
import { ModelBadgeOverlay } from '../components/ModelBadge';
import { Icon } from '../components/Icon';
import { Chip, Header, RoundButton, Sheet, SheetRow, refreshLook } from '../components/ui';
import { RAIL } from '../components/SplitPane';
import { BackgroundSettings } from '../components/BackgroundSettings';
import { useAllLive, useBotPose } from '../live';
import { ACTIVITY_LABEL, POSE_LABELS, type LiveState } from '../poses';
import { color, type } from '../theme';
import { useDrafts } from '../drafts';
import { startFresh } from '../fresh';
import { MessageHits } from './Search';
import { useBack } from '../back';
import { tap } from '../haptics';

type Filter = 'all' | 'unread' | 'needs';
/** Is this chat's sound off right now? `until` 0 means until it is turned back on. */
const isMuted = (muted: Record<string, number>, id: string) => id in muted && (muted[id] === 0 || muted[id] > Date.now());

function when(t: number) {
  if (!t) return '';
  const d = new Date(t);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // Whole calendar days, not 24-hour blocks: 11 PM two days ago is not "Yesterday" at 1 AM.
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (days < 2) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const needsYou = (s?: LiveState) => !!s?.awaiting || s?.activity?.kind === 'waiting_for_you';
const awaitingReason = (s?: LiveState) => {
  const r = (s?.awaiting as { reason?: string } | null)?.reason;
  return typeof r === 'string' && r.trim() ? r.trim() : null;
};

/**
 * Home: every bot as a roomy row (a large head-and-shoulders picture, what it is doing now, and up to three
 * lines of its last message), with a "Needs you" strip on top for bots waiting on an approval. Newest first.
 * The + menu makes a bot or a group chat. `selectedId` marks the chat open beside the list on a wide (unfolded) screen.
 */
export function Home({ api, bots: allBots, loading, loadError, onRetry, name, refreshing, onRefresh, onOpen, onNewBot, onNewGroup, onTasks, onPcs, onPlugins, onSignOut, onDeviceLink, onPermissions, onDevices, onSystem, onUsage, onBotsComputer, selectedId, paneWidth, onBot, onHistory, onSettings, onOpenHit }: {
  api: Client; bots: Bot[];
  /** The first load of this sign-in has not answered yet, or could not (with Try again). */
  loading?: boolean; loadError?: string | null; onRetry?: () => void;
  name: string; refreshing: boolean; onRefresh: () => void; onOpen: (b: Bot) => void; onNewBot?: () => void; onNewGroup?: () => void; onTasks?: () => void; onPcs?: () => void; onPlugins?: (create?: boolean) => void; onSignOut: () => void; onDeviceLink?: () => void; onPermissions?: () => void; onDevices?: () => void; onSystem?: () => void; onUsage?: () => void; onBotsComputer?: () => void;
  selectedId?: string | null;
  /** Beside an open chat (SplitPane): the list's width, which may be dragged down to a column of pictures. */
  paneWidth?: number;
  /** A bot the server sent back changed (pinned). */
  onBot?: (b: Bot) => void;
  /** From a row's long-press menu: its earlier conversations and its settings. */
  onHistory?: (b: Bot) => void; onSettings?: (b: Bot) => void;
  /** A message found by the search was tapped. */
  onOpenHit?: (hit: SearchHit) => void;
}) {
  // Bots hidden from this list (Bot.ownerHidden) stay off it, its counts and its search. A line
  // under the list opens or shows them again.
  const bots = useMemo(() => allBots.filter((b) => !b.ownerHidden), [allBots]);
  const hiddenBots = useMemo(() => allBots.filter((b) => b.ownerHidden), [allBots]);
  const [hiddenSheet, setHiddenSheet] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  // The Android back button closes the search box before it leaves the app.
  useBack(query !== null, () => setQuery(null));
  const [menu, setMenu] = useState(false);
  const [profile, setProfile] = useState(false);
  const [phone, setPhone] = useState(false);
  const [exporting, setExporting] = useState(false);
  const { height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const live = useAllLive();
  // Newest first, with the primary bot always on top (emphasised in BotRow), as on the web and Windows.
  // Pinned chats come next, then the rest by what happened last.
  const byRecent = [...bots].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || Number(b.pinned) - Number(a.pinned) || b.lastActivityAt - a.lastActivityAt);
  const q = query?.trim().toLowerCase();
  // All, Unread or Needs you (not kept: the list opens on All, as on the web).
  const [filter, setFilter] = useState<Filter>('all');
  const unreadCount = bots.filter((b) => b.unread > 0).length;
  const needsCount = bots.filter((b) => needsYou(live[b.id])).length;
  const kept = filter === 'unread' ? byRecent.filter((b) => b.unread > 0 || b.id === selectedId) : filter === 'needs' ? byRecent.filter((b) => needsYou(live[b.id])) : byRecent;
  const list = q ? byRecent.filter((b) => `${b.name} ${b.label} ${b.description ?? ''} ${b.lastPreview ?? ''}`.toLowerCase().includes(q)) /* same fields as web search */ : kept;
  const drafts = useDrafts();
  // Muted chats (the same setting as Notifications › Mute a chat), for the bell on a row and the row menu.
  const notifyProfile = 'main' as const;
  const [muted, setMuted] = useState<Record<string, number>>({});
  useEffect(() => { api.notifyPrefs(notifyProfile).then((r) => setMuted(r.prefs.muted ?? {}), () => {}); }, [api, notifyProfile, phone]);
  // A long press on a row: what can be done with that chat.
  const [rowMenu, setRowMenu] = useState<Bot | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 4000); return () => clearTimeout(t); }, [note]);
  const act = (work: Promise<unknown>, fallback: string) => { setRowMenu(null); work.catch((e) => setNote(e?.message ?? fallback)); };
  const mute = (b: Bot, until: number | null) => act(
    api.setNotifyPrefs(notifyProfile, until === null ? { unmute: b.id } : { mute: { botId: b.id, until } }).then((r) => setMuted(r.prefs.muted ?? {})), 'Could not change that.');
  // The server's version, for the line under This phone's settings.
  const [server, setServer] = useState<string | null>(null);
  useEffect(() => { if (phone && !server) api.version().then((v) => setServer(v.version + (v.commit ? ` (${v.commit.slice(0, 7)})` : '')), () => {}); }, [phone, server, api]);
  const waiting = q ? [] : byRecent.filter((b) => needsYou(live[b.id]));
  const fit = fitFor(paneWidth);
  const [stripH, setStripH] = useState(0);

  return (
    <View style={{ flex: 1, backgroundColor: color.ground }}>
      {query === null ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: fit.headerLeft, paddingRight: 16, paddingTop: 8, paddingBottom: 10 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="You" onPress={() => setProfile(true)} hitSlop={6}
            style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, backgroundColor: color.primary, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.8 : 1 })}>
            <Text style={{ fontSize: 18, fontWeight: '600', color: color.onPrimary }}>{(name.match(/\p{L}/u)?.[0] ?? '?').toUpperCase()}</Text>
          </Pressable>
          <Text numberOfLines={1} style={[type.screenTitle, { flex: 1, fontSize: 22, fontWeight: '700', marginLeft: 4, opacity: fit.title }]}>Bots</Text>
          {/* As the list narrows the buttons fade out, then leave (the title gives up its room, so nothing moves). */}
          {fit.tools > 0 && onTasks && <View style={{ opacity: fit.tools }}><RoundButton icon="tasks" label="Tasks" onPress={onTasks} /></View>}
          {fit.tools > 0 && <View style={{ opacity: fit.tools }}><RoundButton icon="search" label="Search" onPress={() => setQuery('')} /></View>}
          {fit.plus > 0 && (onNewBot || onNewGroup || onPlugins) && <View style={{ opacity: fit.plus }}><RoundButton icon="plus" label="New" onPress={() => setMenu(true)} /></View>}
        </View>
      ) : (
        <Header>
          <View style={{ flex: 1, height: 46, borderRadius: 23, backgroundColor: color.fill, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14 }}>
            <Icon name="search" size={19} color={color.inkMuted} />
            <TextInput autoFocus value={query} onChangeText={setQuery} placeholder={onOpenHit ? 'Search bots and messages' : 'Search bots'} placeholderTextColor={color.timestamp}
              returnKeyType="search" autoCorrect={false} accessibilityLabel={onOpenHit ? 'Search bots and messages' : 'Search bots'}
              style={{ flex: 1, fontSize: 16, color: color.ink, paddingVertical: 0 }} />
            {!!query && <Pressable accessibilityRole="button" accessibilityLabel="Clear the search" onPress={() => setQuery('')} hitSlop={10}><Icon name="close" size={16} color={color.inkMuted} /></Pressable>}
          </View>
          <RoundButton icon="close" label="Close search" onPress={() => setQuery(null)} />
        </Header>
      )}
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" refreshControl={<RefreshControl {...refreshLook()} refreshing={refreshing} onRefresh={onRefresh} />} contentContainerStyle={{ paddingBottom: 24 }}>
        {query === null && fit.name === 1 && bots.length > 3 && (
          <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
            <Chip title="All" selected={filter === 'all'} onPress={() => setFilter('all')} />
            <Chip title={unreadCount ? `Unread · ${unreadCount}` : 'Unread'} selected={filter === 'unread'} onPress={() => setFilter('unread')} />
            <Chip title={needsCount ? `Needs you · ${needsCount}` : 'Needs you'} selected={filter === 'needs'} onPress={() => setFilter('needs')} />
          </View>
        )}
        {waiting.length > 0 && fit.strip > 0 && filter === 'all' && (
          // Beside a chat the strip folds away as the list narrows (the rows still show Needs you), its height
          // shrinking with it so the rows below glide up rather than jump.
          <View style={fit.split ? { height: stripH ? stripH * fit.strip : undefined, opacity: fit.strip, overflow: 'hidden' } : undefined}>
            <View style={fit.split ? { width: STRIP_MIN } : undefined} onLayout={(e) => setStripH(e.nativeEvent.layout.height)}>
              <SectionLabel tone="alert">Needs you · {waiting.length}</SectionLabel>
              <View style={{ paddingHorizontal: 14, gap: 8, paddingBottom: 4 }}>
                {waiting.map((b) => <NeedsYouRow key={b.id} api={api} bot={b} reason={awaitingReason(live[b.id])} onOpen={() => onOpen(b)} />)}
              </View>
              <SectionLabel>Chats</SectionLabel>
            </View>
          </View>
        )}
        {list.map((b, i) => (
          <View key={b.id}>
            {i > 0 && !list[i - 1].isPrimary && <View style={{ height: 1, backgroundColor: color.hairline, marginLeft: 106, opacity: 0.6 * fit.name }} />}
            <BotRow api={api} bot={b} live={live[b.id]} selected={b.id === selectedId} onPress={() => onOpen(b)} onLongPress={() => { tap('medium'); setRowMenu(b); }} fit={fit}
              muted={isMuted(muted, b.id)} draft={b.id === selectedId ? undefined : drafts.get(b.id)} />
          </View>
        ))}
        {fit.name > 0 && q !== undefined && q !== '' && !list.length && <Text style={[type.caption, { padding: 24, textAlign: 'center' }]}>No bots match “{query}”.</Text>}
        {fit.name > 0 && !!q && !!onOpenHit && <MessageHits api={api} bots={bots} query={query ?? ''} onOpen={onOpenHit} />}
        {fit.name > 0 && !q && filter !== 'all' && !list.length && (
          <View style={{ alignItems: 'center', gap: 12, padding: 28 }}>
            <Text style={[type.caption, { textAlign: 'center' }]}>{filter === 'unread' ? 'Nothing unread. You are all caught up.' : 'No bot is waiting on you.'}</Text>
            <Chip title="Show all chats" onPress={() => setFilter('all')} />
          </View>
        )}
        {fit.name > 0 && !q && filter === 'unread' && unreadCount > 1 && (
          <View style={{ alignItems: 'center', paddingTop: 14 }}>
            <Chip title={`Mark all ${unreadCount} as read`} onPress={() => {
              tap('light');
              Promise.all(bots.filter((b) => b.unread > 0).map((b) => api.read(b.id))).then(() => onRefresh(), (e) => setNote(e?.message ?? 'Could not mark them read.'));
            }} />
          </View>
        )}
        {/* Before the first answer: say so (it used to say "No bots yet" while still loading, or with no connection). */}
        {fit.name > 0 && !bots.length && loading && (
          <View accessibilityLabel="Loading your bots" style={{ paddingTop: 8 }}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={{ flexDirection: 'row', gap: 14, paddingVertical: 12, paddingHorizontal: 16, opacity: 1 - i * 0.2 }}>
                <View style={{ width: 76, height: 76, borderRadius: 22, backgroundColor: color.fill }} />
                <View style={{ flex: 1, gap: 10, paddingTop: 8 }}>
                  <View style={{ width: '45%', height: 14, borderRadius: 7, backgroundColor: color.fill }} />
                  <View style={{ width: '90%', height: 12, borderRadius: 6, backgroundColor: color.fill }} />
                  <View style={{ width: '70%', height: 12, borderRadius: 6, backgroundColor: color.fill }} />
                </View>
              </View>
            ))}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 10 }}>
              <ActivityIndicator size="small" color={color.inkMuted} /><Text style={type.caption}>Loading your bots…</Text>
            </View>
          </View>
        )}
        {fit.name > 0 && !bots.length && !loading && !!loadError && (
          <View style={{ alignItems: 'center', gap: 12, padding: 32 }}>
            <Text style={[type.body, { fontWeight: '600', textAlign: 'center' }]}>Couldn't load your bots</Text>
            <Text style={[type.caption, { textAlign: 'center', lineHeight: 20 }]}>{loadError}</Text>
            {onRetry && <Chip title="Try again" selected onPress={onRetry} />}
          </View>
        )}
        {fit.name > 0 && !bots.length && !loading && !loadError && <Text style={[type.caption, { padding: 24, textAlign: 'center' }]}>{onNewBot ? 'No bots yet. Tap + to make one.' : 'No bots on this sign-in yet.'}</Text>}
        {fit.name > 0 && !q && filter === 'all' && hiddenBots.length > 0 && (
          <Pressable accessibilityRole="button" accessibilityLabel={`${hiddenBots.map((b) => b.name).join(', ')} hidden. Open or show again`} onPress={() => setHiddenSheet(true)} hitSlop={6}
            style={({ pressed }) => ({ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 12, marginTop: 6, opacity: (pressed ? 0.6 : 1) * fit.name })}>
            <Icon name="eyeoff" size={15} color={color.timestamp} />
            <Text style={[type.caption, { fontSize: 13 }]}>{hiddenBots.length === 1 ? `${hiddenBots[0].name} is hidden` : `${hiddenBots.length} hidden`}</Text>
          </Pressable>
        )}
      </ScrollView>
      <Sheet visible={hiddenSheet} onClose={() => setHiddenSheet(false)} title="Hidden from your list">
        <Text style={[type.caption, { paddingHorizontal: 16, paddingBottom: 8 }]}>They still work and talk to your other bots. You just don’t see them here or get their notifications.</Text>
        {hiddenBots.map((b) => (
          <View key={b.id}>
            <SheetRow icon="chat" title={`Open ${b.name}`} onPress={() => { setHiddenSheet(false); onOpen(b); }} />
            <SheetRow icon="eye" title={`Show ${b.name} again`} onPress={() => { setHiddenSheet(false); act(api.updateBot(b.id, { ownerHidden: false }).then((r) => { onBot?.(r.bot); setNote(`${b.name} is back, with notifications.`); }), 'Could not show it.'); }} />
          </View>
        ))}
      </Sheet>
      <Sheet visible={menu} onClose={() => setMenu(false)}>
        {onNewBot && <SheetRow icon="plus" title="New bot" onPress={() => { setMenu(false); onNewBot(); }} />}
        {onNewGroup && <SheetRow icon="group" title="New group" onPress={() => { setMenu(false); onNewGroup(); }} />}
        {onPlugins && <SheetRow icon="puzzle" title="Create plugin" onPress={() => { setMenu(false); onPlugins(true); }} />}
      </Sheet>
      <Sheet visible={profile} onClose={() => setProfile(false)} title={`Signed in as ${name}`}>
        {onPcs && <SheetRow icon="monitor" title="Your PCs" onPress={() => { setProfile(false); onPcs(); }} />}
        {onPlugins && <SheetRow icon="link" title="Connections" onPress={() => { setProfile(false); onPlugins(); }} />}
        {onBotsComputer && <SheetRow icon="monitor" title="Bots’ computer" onPress={() => { setProfile(false); onBotsComputer(); }} />}
        {onPermissions && <SheetRow icon="check" title="Permissions" onPress={() => { setProfile(false); onPermissions(); }} />}
        {onUsage && <SheetRow icon="table" title="Usage" onPress={() => { setProfile(false); onUsage(); }} />}
        {onSystem && <SheetRow icon="chart" title="System status" onPress={() => { setProfile(false); onSystem(); }} />}
        <SheetRow icon="sliders" title="Appearance and notifications" onPress={() => { setProfile(false); setPhone(true); }} />
        {onDeviceLink && <SheetRow icon="qr" title="Sign in another device" onPress={() => { setProfile(false); onDeviceLink(); }} />}
        <SheetRow icon="download" title={exporting ? 'Getting your data ready…' : 'Download my data'} onPress={() => {
          if (exporting) return;
          setExporting(true);
          toast('Getting your data ready…');
          downloadMyData(api).then(() => setProfile(false), (e: any) => toast(e?.message ?? 'Could not get your data.')).finally(() => setExporting(false));
        }} />
        {onDevices && <SheetRow icon="phone" title="Signed-in devices" onPress={() => { setProfile(false); onDevices(); }} />}
        <SheetRow icon="signout" title="Sign out of this phone" danger onPress={() => {
          setProfile(false);
          // Signing in again needs a new code from another device, so ask first.
          Alert.alert('Sign out of this phone?', 'To sign in again you need a new code from the website or another signed-in device. Messages you have not sent yet stay on this phone.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: onSignOut }]);
        }} />
      </Sheet>
      <Sheet visible={!!rowMenu} onClose={() => setRowMenu(null)} title={rowMenu?.name}>
        {rowMenu && (() => {
          const b = rowMenu;
          const off = isMuted(muted, b.id);
          return (
            <ScrollView style={{ maxHeight: winH * 0.7 }}>
              {!b.isPrimary && <SheetRow icon="pin" title={b.pinned ? 'Unpin' : 'Pin to the top'} onPress={() => act(api.updateBot(b.id, { pinned: !b.pinned }).then((r) => onBot?.(r.bot)), 'Could not change that.')} />}
              {b.unread > 0
                ? <SheetRow icon="check" title="Mark as read" onPress={() => act(api.read(b.id), 'Could not mark it read.')} />
                : <SheetRow icon="chat" title="Mark as unread" onPress={() => act(api.markUnread(b.id), 'Could not mark it unread.')} />}
              {off ? <SheetRow icon="belloff" title="Turn notifications back on" onPress={() => mute(b, null)} /> : (
                <>
                  <SheetRow icon="belloff" title="Mute for 1 hour" onPress={() => mute(b, Date.now() + 3_600_000)} />
                  <SheetRow icon="belloff" title="Mute for 8 hours" onPress={() => mute(b, Date.now() + 8 * 3_600_000)} />
                  <SheetRow icon="belloff" title="Mute until I turn it back on" onPress={() => mute(b, 0)} />
                </>
              )}
              <SheetRow icon="refresh" title="New conversation" onPress={() => act(startFresh(api, b), 'Could not start a new conversation.')} />
              {onHistory && <SheetRow icon="history" title="Earlier conversations" onPress={() => { setRowMenu(null); onHistory(b); }} />}
              {onSettings && <SheetRow icon="sliders" title={b.kind === 'room' ? 'Group settings' : `${b.name}'s settings`} onPress={() => { setRowMenu(null); onSettings(b); }} />}
              {/* onNewBot is only there on a full sign-in: a scoped one (Sam) cannot hide bots. */}
              {!b.isPrimary && !!onNewBot && <SheetRow icon="eyeoff" title="Hide from my list" onPress={() => act(api.updateBot(b.id, { ownerHidden: true }).then((r) => { onBot?.(r.bot); setNote(`${b.name} is hidden, with no notifications. Show again from the bottom of the list.`); }), 'Could not hide it.')} />}
            </ScrollView>
          );
        })()}
      </Sheet>
      {!!note && (
        <View accessibilityLiveRegion="polite" pointerEvents="none" style={{ position: 'absolute', left: 16, right: 16, bottom: Math.max(insets.bottom, 8) + 16, alignItems: 'center' }}>
          <View style={{ backgroundColor: color.primary, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 12, maxWidth: '100%' }}><Text style={{ color: color.onPrimary, fontSize: 15 }}>{note}</Text></View>
        </View>
      )}
      <Sheet visible={phone} onClose={() => setPhone(false)} title="This phone">
        <ScrollView style={{ maxHeight: winH * 0.78 }} contentContainerStyle={{ paddingHorizontal: 4, paddingBottom: 6 }}><BackgroundSettings api={api} bots={allBots} />
          {/* The version, and a tap to copy what someone helping you would ask for (versions, connection, the last things that failed to draw). */}
          <Pressable accessibilityRole="button" accessibilityLabel="Copy details for support" hitSlop={6}
            onPress={() => { Clipboard.setStringAsync(`${errorDetails()}\n\nserver ${server ?? 'unknown'} · connection ${connectionNow()} · Android ${Platform.Version}`).then(() => { tap('light'); toast('Details copied'); }, () => toast("Couldn't copy the details")); }}
            style={({ pressed }) => ({ alignSelf: 'center', marginTop: 12, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 12, backgroundColor: pressed ? color.pressed : 'transparent' })}>
            <Text style={[type.caption, { fontSize: 12.5, textAlign: 'center' }]}>YBots {Constants.expoConfig?.version ?? ''}{server ? ` · server ${server}` : ''} · Copy details</Text>
          </Pressable>
        </ScrollView>
      </Sheet>
    </View>
  );
}

function SectionLabel({ children, tone }: { children: React.ReactNode; tone?: 'alert' }) {
  return (
    <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase', color: tone === 'alert' ? color.problemInk : color.inkMuted, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 8 }}>
      {children}
    </Text>
  );
}

/** One bot waiting on an approval: who, what for, and a button into its chat, where the card is. */
function NeedsYouRow({ api, bot, reason, onOpen }: { api: Client; bot: Bot; reason: string | null; onOpen: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${bot.name} needs you. Review`} onPress={onOpen}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: color.surface, borderWidth: 1, borderColor: color.alertBorder, borderRadius: 16, paddingVertical: 10, paddingHorizontal: 12, opacity: pressed ? 0.8 : 1 })}>
      <BotAvatar bot={bot} size={36} server={api.server} auth={api.authHeader} crop="portrait" />
      <Text numberOfLines={2} style={{ flex: 1, fontSize: 15, lineHeight: 20, color: color.ink }}>
        <Text style={{ fontWeight: '600' }}>{bot.name}</Text>{reason ? ` wants to ${lowerFirst(reason)}` : ' is waiting on you'}
      </Text>
      <View style={{ backgroundColor: color.primary, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 }}>
        <Text style={{ color: color.onPrimary, fontSize: 14, fontWeight: '600' }}>Review</Text>
      </View>
    </Pressable>
  );
}
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

function BotRow({ api, bot, live, selected, onPress, onLongPress, fit, muted, draft }: { api: Client; bot: Bot; live?: LiveState; selected: boolean; onPress: () => void; onLongPress?: () => void; fit: Fit; muted?: boolean; draft?: string }) {
  const waiting = needsYou(live);
  const running = !!live?.isRunning && !waiting;
  const kind = live?.activity?.kind;
  let step: string | null = null;
  if (running) {
    const label = kind ? ACTIVITY_LABEL[kind] ?? 'Working' : 'Thinking';
    const detail = live?.caption || live?.activity?.detail;
    // The pill already says Working, so a plain "working" or "thinking" shows only what it is doing.
    const plain = !kind || kind === 'working' || kind === 'thinking';
    step = kind === 'messaging_named' && live?.activity?.detail ? `Messaging ${live.activity.detail}` : detail ? (plain ? detail : `${label}: ${detail}`) : label;
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${bot.name}${bot.unread ? `, ${bot.unread} unread` : ''}${bot.pinned && !bot.isPrimary ? ', pinned' : ''}${muted ? ', muted' : ''}`} accessibilityHint="Hold for more" onPress={onPress} onLongPress={onLongPress} delayLongPress={350}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: 12, paddingHorizontal: 16,
        // Beside a chat every row keeps one height (the text can't push it), so narrowing never reflows the list.
        ...(fit.split ? { height: fit.avatar + 40, overflow: 'hidden' as const } : null),
        backgroundColor: pressed || selected ? color.pressed : waiting ? color.alertFill : bot.isPrimary ? PRIMARY_TINT : 'transparent',
        ...(bot.isPrimary ? { marginHorizontal: 8, marginBottom: 6, paddingHorizontal: 8, borderRadius: 20, borderWidth: 1, borderColor: PRIMARY_EDGE } : null) })}>
      <View>
        <BotAvatar bot={bot} size={fit.avatar} radius={Math.round(fit.avatar * 0.29)} server={api.server} auth={api.authHeader} crop="portrait" />
        {bot.isPrimary && (
          <View accessibilityLabel="Primary bot" style={{ position: 'absolute', right: -5, bottom: -5, width: 24, height: 24, borderRadius: 12, backgroundColor: '#F59312', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: color.ground }}>
            <Text style={{ color: '#FFFFFF', fontSize: 13, lineHeight: 15, fontWeight: '700' }}>★</Text>
          </View>
        )}
        {bot.unread > 0 && (
          <View style={{ position: 'absolute', right: -5, top: -5, minWidth: 22, height: 22, paddingHorizontal: 5, borderRadius: 11, backgroundColor: muted ? color.inkMuted : color.link, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: color.ground }}>
            <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '700' }}>{bot.unread > 99 ? '99+' : bot.unread}</Text>
          </View>
        )}
        <ModelBadgeOverlay botId={bot.id} />
      </View>
      {fit.name > 0 && (
      // Narrower than TEXT_FIXED_AT the words keep their width and fade out under the pane's edge instead of
      // re-wrapping: the time and status go first, then the message, then the name.
      <View style={fit.textWidth ? { width: fit.textWidth } : { flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text numberOfLines={1} style={[type.name, { fontSize: 18, fontWeight: '600', flexShrink: fit.textWidth ? 0 : 1, opacity: fit.name }]}>{bot.name}</Text>
          <View style={{ opacity: fit.meta }}><StatusPill bot={bot} waiting={waiting} running={running} /></View>
          {bot.pinned && !bot.isPrimary && <View style={{ opacity: fit.meta }}><Icon name="pin" size={14} color={color.inkMuted} /></View>}
          {muted && <View style={{ opacity: fit.meta }}><Icon name="belloff" size={14} color={color.inkMuted} /></View>}
          <View style={{ flexGrow: 1, flexShrink: 0 }} />
          <Text numberOfLines={1} style={[type.time, { opacity: fit.meta, flexShrink: 0, fontSize: 13, color: bot.unread ? color.link : color.timestamp, fontWeight: bot.unread ? '600' : '400' }]}>{when(bot.lastActivityAt)}</Text>
        </View>
        {!!step && <Text numberOfLines={1} style={{ fontSize: 13.5, color: color.link, marginTop: 4, opacity: fit.preview }}>{step}</Text>}
        {draft?.trim() ? (
          <Text numberOfLines={fit.split && step ? 2 : 3} style={[type.preview, { opacity: fit.preview, lineHeight: 21, marginTop: 4, color: color.previewInk }]}><Text style={{ fontWeight: '600', color: color.problemInk }}>Draft: </Text>{draft.trim().replace(/\s+/g, ' ')}</Text>
        ) : <FitPreview forms={bot.previewForms?.length ? bot.previewForms : [bot.lastPreview ?? 'No messages yet', ...(bot.previewShort && bot.previewShort !== bot.lastPreview ? [bot.previewShort] : [])]} lines={fit.split && step ? 2 : 3} lineHeight={21}
          style={[type.preview, { opacity: fit.preview, lineHeight: 21, marginTop: 4, color: bot.unread ? color.ink : color.previewInk, fontWeight: bot.unread ? '500' : '400' }]} />}
      </View>
      )}
    </Pressable>
  );
}

/**
 * The row's line, never cut mid-text (server/src/list-preview.ts): the longest whole form that fits `lines`,
 * else the shortest. Invisible copies of the longer forms, laid out at the same width, say how many lines each
 * needs, so this holds on a phone, a folded phone and a list dragged narrow beside a chat.
 */
function FitPreview({ forms, lines, lineHeight, style }: { forms: string[]; lines: number; lineHeight: number; style: StyleProp<TextStyle> }) {
  const key = forms.join('\u0000');
  const [needs, setNeeds] = useState<Record<number, number>>({});
  useEffect(() => { setNeeds({}); }, [key]);
  let pick = 0;
  while (pick < forms.length - 1 && (needs[pick] == null || needs[pick] > lines)) {
    if (needs[pick] == null) break; // not measured yet: show it until it is
    pick++;
  }
  return (
    <View>
      {forms.slice(0, -1).map((f, i) => (
        <Text key={i} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none"
          // Height over line height, not onTextLayout: the same on Android and in the web preview.
          onLayout={(e) => { const n = Math.round(e.nativeEvent.layout.height / lineHeight); setNeeds((m) => (m[i] === n ? m : { ...m, [i]: n })); }}
          style={[style, { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 }]}>{f}</Text>
      ))}
      <Text numberOfLines={lines} style={style}>{forms[pick]}</Text>
    </View>
  );
}

/**
 * How the list draws at a given width beside a chat. Wide, it is the ordinary list. Narrower, things leave in
 * order, each fading over its own band of widths so a drag never jumps: the header buttons and each row's time
 * and status first, then the message, then the names and the title; only then do the pictures shrink, from 76
 * to 64, which at RAIL (96) leaves them centred in a column of pictures. Kept in step with the web sidebar
 * (web/src/lib/sidebarFit.ts).
 */
type Fit = { split: boolean; avatar: number; textWidth: number | null; meta: number; preview: number; name: number; title: number; tools: number; plus: number; strip: number; headerLeft: number };
const TEXT_FIXED_AT = 330;
const PICTURE_SHRINK_FROM = 170;
const STRIP_MIN = 330;
const band = (w: number, gone: number, full: number) => Math.min(1, Math.max(0, (w - gone) / (full - gone)));
function fitFor(paneWidth?: number): Fit {
  if (paneWidth == null) return { split: false, avatar: 76, textWidth: null, meta: 1, preview: 1, name: 1, title: 1, tools: 1, plus: 1, strip: 1, headerLeft: 16 };
  const w = paneWidth;
  const pic = band(w, RAIL, PICTURE_SHRINK_FROM);
  const avatar = Math.round(64 + 12 * pic);
  return {
    split: true,
    avatar,
    // 16 + 76 + 14 on the left and 16 on the right: the text column's width when the list is TEXT_FIXED_AT wide.
    textWidth: w < TEXT_FIXED_AT ? TEXT_FIXED_AT - 122 : null,
    meta: band(w, 250, TEXT_FIXED_AT),
    preview: band(w, 200, 300),
    name: band(w, PICTURE_SHRINK_FROM, 260),
    title: band(w, 180, 260),
    tools: band(w, 270, 320),
    plus: band(w, 190, 240),
    strip: band(w, 260, STRIP_MIN),
    // The "You" button ends centred over the pictures: (RAIL - 44) / 2 = 26.
    headerLeft: 16 + 10 * (1 - pic),
  };
}

/** The primary bot's row: a soft amber card, matching the web sidebar. */
const PRIMARY_TINT = 'rgba(245,147,18,0.08)';
const PRIMARY_EDGE = 'rgba(245,147,18,0.28)';

const pill = () => ({
  work: { bg: color.infoFill, ink: color.link },
  need: { bg: color.problemFill, ink: color.problemInk },
  idle: { bg: color.fill, ink: color.inkMuted },
  slack: { bg: color.slackFill, ink: color.slackInk },
});

/** Working, Needs you, via Slack, or the bot's resting pose (Idle, Resting, Done) in a small pill. */
function StatusPill({ bot, waiting, running }: { bot: Bot; waiting: boolean; running: boolean }) {
  const pose = useBotPose(bot.id, bot.lastActivityAt);
  let tone: keyof ReturnType<typeof pill> = 'idle';
  let text = POSE_LABELS.find(([id]) => id === pose)?.[1] ?? 'Idle';
  if (waiting) { tone = 'need'; text = 'Needs you'; }
  else if (running) { tone = 'work'; text = 'Working'; }
  else if (bot.outside?.waiting) { tone = 'work'; text = 'Answering in Slack'; }
  else if (bot.outside) { tone = 'slack'; text = 'via Slack'; }
  const c = pill()[tone];
  return (
    <View accessibilityLabel={text} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: c.bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, flexShrink: 0 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.ink }} />
      <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: '600', color: c.ink, flexShrink: 0 }}>{text}</Text>
    </View>
  );
}
