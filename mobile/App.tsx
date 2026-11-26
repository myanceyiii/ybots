import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, Linking, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { client, loadSession, saveSession, signInWithLink, type Bot, type Client, type Machine, type Row, type SearchHit, type Session, type SideChat } from './src/api';
import { History } from './src/screens/History';
import { Search } from './src/screens/Search';
import { flushOutbox, setOutboxAccount } from './src/outbox';
import { Pcs } from './src/screens/Pcs';
import { Tasks } from './src/screens/Tasks';
import { Connections } from './src/screens/Connections';
import { PluginCode } from './src/screens/PluginCode';
import { PcScreen } from './src/screens/PcScreen';
import { Files } from './src/screens/Files';
import { DeviceLink } from './src/screens/DeviceLink';
import { Permissions } from './src/screens/Permissions';
import { Devices } from './src/screens/Devices';
import { SystemStatus } from './src/screens/SystemStatus';
import { Usage } from './src/screens/Usage';
import { BotsComputer } from './src/screens/BotsComputer';
import { Exchanges } from './src/screens/Exchanges';
import { emitPageEvent, emitPagesEvent } from './src/pageBus';
import { Pages } from './src/screens/Pages';
import { BotSettings, type SettingsTab } from './src/screens/BotSettings';
import { Call } from './src/screens/Call';
import { Chat } from './src/screens/Chat';
import { notificationChat } from './src/chatTarget';
import { getLive, setLive, updateLive } from './src/live';
import { background, parseOpenLink, setNotifyAccount, startNotifications, stopNotifications } from './src/background';
import { getDraft, setDraft, setDraftAccount } from './src/drafts';
import { Computer } from './src/screens/Computer';
import { CustomLook } from './src/screens/CustomLook';
import { Home } from './src/screens/Home';
import { NewBot } from './src/screens/NewBot';
import { NewGroup } from './src/screens/NewGroup';
import { SignIn } from './src/screens/SignIn';
import { Welcome } from './src/screens/Welcome';
import { PillButton, UndoBar } from './src/components/ui';
import { SplitPane } from './src/components/SplitPane';
import { SideChatChip, SideChatSheet, canHaveSideChats } from './src/components/SideChats';
import { onFresh, type FreshUndo } from './src/fresh';
import { feedCallRows, getCall } from './src/voice/call';
import * as SystemUI from 'expo-system-ui';
import { applyScheme, color, type, useScheme } from './src/theme';
import { setScopedSignIn } from './src/simple';
import { clearCache, loadCache, saveCacheSoon, snapshot } from './src/cache';
import { kickConnection, resetConnection, streamHealthy, useConnection } from './src/connection';
import { runBack } from './src/back';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { ConnectionBanner } from './src/components/ConnectionBanner';
import { parseQuickLink, watchShares, type Quick } from './src/quick';
import { assistantBot, assistantPrefs, requestListen } from './src/assist';

type Screen =
  | { name: 'welcome' } | { name: 'signin' } | { name: 'home' } | { name: 'newbot' } | { name: 'newgroup' }
  | { name: 'chat'; botId: string } | { name: 'call'; botId: string } | { name: 'computer'; botId: string } | { name: 'look'; botId: string; back: Screen }
  | { name: 'settings'; botId: string; tab?: SettingsTab }
  | { name: 'files'; botId: string; path?: string } | { name: 'pages'; botId: string } | { name: 'pcs' } | { name: 'tasks'; botId?: string } | { name: 'connectors' } | { name: 'plugins'; create?: boolean } | { name: 'plugincode'; draftId: string } | { name: 'pcscreen'; machine: Machine; mode?: 'watch' | 'control' }
  | { name: 'history'; botId: string; chatId: string; generation?: number; seq?: number } | { name: 'search' }
  | { name: 'devicelink' } | { name: 'exchanges'; botId: string } | { name: 'permissions' } | { name: 'devices' } | { name: 'system' } | { name: 'usage' } | { name: 'botscomputer' };

/** Rows for one bot, by seq. A row the server updates comes again with the same seq and replaces the old one. */
/** The same row as before? Then the object the chat already drew is kept, so that row is not drawn again. */
function sameRow(a: Row, b: Row) {
  if (a === b) return true;
  if (a.generation !== b.generation || a.createdAt !== b.createdAt || a.kind !== b.kind) return false;
  try { return JSON.stringify(a.body) === JSON.stringify(b.body); } catch { return false; }
}
function merge(old: Row[], incoming: Row[]) {
  const by = new Map(old.map((r) => [r.seq, r]));
  for (const r of incoming) { const was = by.get(r.seq); if (!was || !sameRow(was, r)) by.set(r.seq, r); }
  return [...by.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Sheldon lives in ChatGPT, so his "Open in ChatGPT" button (and the mic) hands off to the ChatGPT app instead of the in-app call. A
 * chatgpt.com link opens the installed app (chatgpt.com's assetlinks.json claims every chatgpt.com
 * link for it); without the app it opens in the browser.
 */
function openInChatGPT(bot: Bot) {
  const url = bot.outside?.callUrl || 'https://chatgpt.com/voice';
  Linking.openURL(url).catch(() => Alert.alert(`Couldn't open ChatGPT`, `Open ChatGPT and find ${bot.name} there.`));
}

/** Where the app starts once signed in: the bot list. */
const startScreen = (_list: Bot[]): Screen => ({ name: 'home' });

/** Width at which the list and the open chat sit side by side (an unfolded phone is about 840 wide). */
const WIDE_MIN = 700;

export default function App() {
  // Light or dark (System follows the phone). The palette switches before anything below draws.
  const { scheme } = useScheme();
  applyScheme(scheme);
  useEffect(() => { SystemUI.setBackgroundColorAsync(color.ground).catch(() => {}); }, [scheme]);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  // Who the server says is signed in on this phone (a name, not the account's address); see Session.name.
  const [who, setWho] = useState<string | null>(null);
  // A sign-in that sees only some bots (the server's SCOPED_PEOPLE). The server already
  // leaves the other bots out; this hides the team-wide tools it would refuse (PCs, Connections, new bots).
  const [scoped, setScoped] = useState(false);
  const limited = scoped;
  const [api, setApi] = useState<Client | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [rows, setRows] = useState<Record<string, Row[]>>({});
  const [stack, setStack] = useState<Screen[]>([{ name: 'welcome' }]);
  const [refreshing, setRefreshing] = useState(false);
  // Where the first load of this sign-in stands: until the server (or what was saved on the phone) has
  // answered, the list says so instead of "No bots yet"; if neither can, it says why and offers Try again.
  const [boot, setBoot] = useState<{ state: 'loading' | 'ready' | 'failed'; error?: string; saved?: boolean }>({ state: 'loading' });
  const connection = useConnection();
  const gen = useRef<Record<string, number>>({});
  // Chats whose rows the server has sent since this sign-in (rows drawn from the phone's saved copy are not enough).
  const loaded = useRef<Record<string, boolean>>({});
  const loadingRows = useRef<Record<string, boolean>>({});
  const accountRef = useRef('');
  // Answers that arrive after the account or the conversation changed are dropped: the account epoch
  // moves on every sign-in and sign-out, a chat's epoch on New conversation, its undo and a restore.
  const accountEpoch = useRef(0);
  const chatEpoch = useRef<Record<string, number>>({});
  const bumpChat = (botId: string) => { chatEpoch.current[botId] = (chatEpoch.current[botId] ?? 0) + 1; };
  const [rowErrors, setRowErrors] = useState<Record<string, string | null>>({});
  const [earlierErrors, setEarlierErrors] = useState<Record<string, string | null>>({});
  // The message a notification tap points at, scrolled to once its chat opens.
  const [focus, setFocus] = useState<{ botId: string; seq: number } | null>(null);
  // Side chats (server/src/side-chats.ts): each bot's list, and which of its chats is open (null: the main chat).
  // A side chat is read and written like a chat with its own id, so rows, drafts and live state key on that id.
  const [sideChats, setSideChats] = useState<Record<string, SideChat[]>>({});
  const [activeChat, setActiveChat] = useState<Record<string, string | null>>({});
  const [sideSheet, setSideSheet] = useState(false);
  const [sideUndo, setSideUndo] = useState<{ id: string; botId: string; title: string; until: number } | null>(null);
  const [sideNote, setSideNote] = useState<string | null>(null);
  /** The id of the open chat of a bot: a side chat's id, or the bot's own for its main chat. */
  const chatIdOf = (botId: string) => {
    const id = activeChat[botId];
    const list = sideChats[botId];
    return id && (!list || list.some((c) => c.id === id)) ? id : botId;
  };
  const screen = stack[stack.length - 1];
  // A wide screen (a folding phone opened up, a tablet) shows the bot list and the open chat side by side.
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_MIN;
  // The open chat fills the screen (SplitPane slides the list away); only while a chat is open.
  const [chatFull, setChatFull] = useState(false);
  const push = (s: Screen) => setStack((st) => [...st, s]);
  const pop = useCallback(() => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)), []);
  /** Back to the chat underneath, however many screens were opened over it. */
  const backToChat = useCallback(() => setStack((st) => { const i = st.map((x) => x.name).lastIndexOf('chat'); return i >= 0 ? st.slice(0, i + 1) : st.length > 1 ? st.slice(0, -1) : st; }), []);

  // A sign-in link that arrives before the saved session has loaded waits for it, so the saved
  // session can never overwrite the new one; sign-ins run one at a time.
  const hydrated = useRef(false);
  const queuedLink = useRef<(() => void) | null>(null);
  const signingIn = useRef(false);
  useEffect(() => {
    loadSession().then((s) => {
      hydrated.current = true;
      sessionRef.current = s;
      setSession(s);
      const q = queuedLink.current; queuedLink.current = null; q?.();
    });
  }, []);

  // Tapping a sign-in app link (`cleftbot://sign-in?link=<sign-in link>`, printed by sign-in-link.sh)
  // opens the app and signs in, so a phone needs no camera and no second screen.
  const openLink = useRef<string | null>(null);
  const [openTick, setOpenTick] = useState(0);
  // Ways in from outside (src/quick.ts): a share from another app, an app-icon shortcut, an ask or hub link.
  const quick = useRef<Quick | null>(null);
  const [quickTick, setQuickTick] = useState(0);
  // Remounts the open chat so words put in its message box from outside show up.
  const [draftTick, setDraftTick] = useState(0);
  useEffect(() => watchShares((text) => { quick.current = { kind: 'ask', text }; setQuickTick((t) => t + 1); },
    () => { quick.current = { kind: 'assist' }; setQuickTick((t) => t + 1); }), []);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => {
    const handle = (url: string | null | undefined) => {
      // A notification tap opens that chat (a second chat on a wide screen replaces the open one).
      const open = parseOpenLink(url);
      if (open) {
        openLink.current = open.botId;
        // A side chat's notice names its bot and the side chat: open the bot, on that chat.
        if (open.chatId && open.chatId !== open.botId) setActiveChat((a) => ({ ...a, [open.botId]: open.chatId! }));
        if (open.seq) setFocus({ botId: open.chatId ?? open.botId, seq: open.seq });
        setOpenTick((t) => t + 1); return;
      }
      // An app-icon shortcut or an ask/hub link (src/quick.ts).
      const q = parseQuickLink(url);
      if (q) { quick.current = q; setQuickTick((t) => t + 1); return; }
      const m = url ? /^[a-z]+:\/\/sign-in\?(?:.*&)?link=([^&]+)/i.exec(url) : null;
      if (!m) return;
      let link: string;
      try { link = decodeURIComponent(m[1]); } catch { return; }
      const go = async () => {
        if (signingIn.current) return;
        signingIn.current = true;
        try { const s = await signInWithLink(link); await saveSession(s); setSession(s); }
        catch (e: any) { Alert.alert('Sign-in failed', e?.message ?? 'Sign-in failed.'); }
        finally { signingIn.current = false; }
      };
      const ask = () => {
        if (sessionRef.current) Alert.alert('Sign in again?', 'This phone is already signed in. Use the new sign-in link instead?', [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign in', onPress: go }]);
        else go();
      };
      if (hydrated.current) ask(); else queuedLink.current = ask;
    };
    Linking.getInitialURL().then(handle).catch(() => {});
    const sub = Linking.addEventListener('url', (e) => handle(e.url));
    return () => sub.remove();
  }, []);

  // Everything one account loaded goes when it signs out or its sign-in expires.
  const clearAccount = useCallback(async () => {
    accountEpoch.current += 1;
    stopNotifications();
    setOutboxAccount('', null, null);
    // The chats saved on the phone for a fast start go with the sign-in.
    const was = sessionRef.current;
    if (was) clearCache(`${was.server}|${was.email}`);
    await saveSession(null);
    gen.current = {}; chatEpoch.current = {}; loaded.current = {}; loadingRows.current = {};
    resetConnection();
    setSession(null); setApi(null); setBots([]); setRows({}); setRowErrors({}); setEarlierErrors({}); setFocus(null); setWho(null); setSideChats({}); setActiveChat({}); setSideUndo(null);
    setStack([{ name: 'welcome' }]);
  }, []);
  const signOut = useCallback(async () => {
    try { await api?.logout(); } catch { /* the token may already be gone */ }
    await clearAccount();
  }, [api, clearAccount]);

  const loadBots = useCallback(async (a: Client) => {
    const epoch = accountEpoch.current;
    try {
      const { bots, live } = await a.bots();
      if (epoch !== accountEpoch.current) return null;
      setBots(bots);
      setLive(live ?? []);
      setBoot((b) => (b.state === 'ready' && !b.saved ? b : { state: 'ready' }));
      return bots;
    } catch (e: any) {
      if (epoch !== accountEpoch.current) return null;
      if (e?.status === 401) { await clearAccount(); return null; }
      // Nothing on screen yet (no saved copy either): say why, with Try again. Otherwise the banner covers it.
      setBoot((b) => (b.state === 'loading' ? { state: 'failed', error: e?.message ?? 'Could not load your bots.' } : b));
      return null;
    }
  }, [clearAccount]);

  const loadRows = useCallback(async (a: Client, botId: string) => {
    const epoch = accountEpoch.current;
    const chat = chatEpoch.current[botId] ?? 0;
    loadingRows.current[botId] = true;
    try {
      const r = await a.rows(botId);
      if (epoch !== accountEpoch.current || chat !== (chatEpoch.current[botId] ?? 0)) return;
      // The same conversation keeps the earlier messages already loaded; a new one starts clean.
      const same = gen.current[botId] === r.generation;
      gen.current[botId] = r.generation;
      loaded.current[botId] = true;
      setRows((all) => {
        // Rows the phone had saved are replaced by what the server says now, except earlier pages loaded since.
        const old = same ? all[botId] ?? [] : [];
        const first = r.rows[0]?.seq ?? Infinity;
        const last = r.rows[r.rows.length - 1]?.seq ?? -Infinity;
        const kept = old.filter((x) => x.seq < first || x.seq > last);
        // Rows that did not change keep the object the chat already drew (see merge).
        const before = new Map(old.map((x) => [x.seq, x]));
        return { ...all, [botId]: merge(kept, r.rows.map((x) => { const was = before.get(x.seq); return was && sameRow(was, x) ? was : x; })) };
      });
      setRowErrors((all) => (all[botId] ? { ...all, [botId]: null } : all));
    } catch (e: any) {
      if (epoch !== accountEpoch.current) return;
      // Shown in the chat with Try again, only while nothing is on screen yet.
      setRowErrors((all) => ({ ...all, [botId]: e?.message ?? 'Could not load this chat.' }));
    } finally { if (epoch === accountEpoch.current) loadingRows.current[botId] = false; }
  }, []);

  // Earlier messages of a long chat: a conversation's rows count from 1, so anything before the first one held is on the server.
  const loadingEarlier = useRef<Record<string, boolean>>({});
  const loadEarlier = useCallback(async (a: Client, botId: string) => {
    const first = rowsRef.current[botId]?.[0]?.seq ?? 1;
    if (first <= 1 || loadingEarlier.current[botId]) return;
    loadingEarlier.current[botId] = true;
    const epoch = accountEpoch.current;
    const chat = chatEpoch.current[botId] ?? 0;
    try {
      const r = await a.rowsBefore(botId, first);
      if (epoch !== accountEpoch.current || chat !== (chatEpoch.current[botId] ?? 0)) return;
      if (gen.current[botId] === r.generation) setRows((all) => ({ ...all, [botId]: merge(all[botId] ?? [], r.rows) }));
      setEarlierErrors((all) => (all[botId] ? { ...all, [botId]: null } : all));
    } catch (e: any) {
      if (epoch === accountEpoch.current) setEarlierErrors((all) => ({ ...all, [botId]: e?.message ?? 'Could not load earlier messages.' }));
    } finally { loadingEarlier.current[botId] = false; }
  }, []);

  // Signed in: make the client, fetch the bots, and follow the live event stream.
  useEffect(() => {
    if (!session) return;
    const a = client(session);
    // A new sign-in starts from nothing: no bots, chats, drafts or notifications of the last account.
    accountEpoch.current += 1;
    const epoch = accountEpoch.current;
    gen.current = {}; chatEpoch.current = {}; loaded.current = {}; loadingRows.current = {};
    resetConnection();
    setBoot({ state: 'loading' });
    setBots([]); setRows({}); setRowErrors({}); setEarlierErrors({}); setSideChats({}); setActiveChat({}); setSideUndo(null);
    const account = `${session.server}|${session.email}`;
    accountRef.current = account;
    setDraftAccount(account);
    setNotifyAccount(account);
    // Messages left unsent by an earlier visit go out now; a sent message's row lands in its chat at once.
    setOutboxAccount(account, a, (chatId, row) => {
      if (gen.current[chatId] !== undefined && gen.current[chatId] !== row.generation) return;
      setRows((all) => (all[chatId] ? { ...all, [chatId]: merge(all[chatId], [row]) } : all));
    });
    setApi(a);
    let alive = true;
    setWho(null);
    setScoped(false);
    a.me().then((r) => { if (alive && r.user) { setWho(r.user.displayName ?? r.user.name ?? null); setScoped(!!r.user.scope); setScopedSignIn(!!r.user.scope); } }).catch(() => {});
    // The first screen of this sign-in, set once: from what the phone saved (at once) or from the server, whichever
    // comes first. A notification tap that opened the app wins.
    let begun = false;
    const begin = (list: Bot[]) => {
      if (begun) return;
      begun = true;
      const tapped = notificationChat(list, openLink.current);
      if (tapped) openLink.current = null;
      const start = startScreen(list);
      setStack(tapped ? [start, { name: 'chat', botId: tapped }] : [start]);
    };
    // What this phone showed last (src/cache.ts): on screen in a moment, replaced as the server answers.
    void loadCache(account).then((c) => {
      if (!alive || epoch !== accountEpoch.current || !c || !c.bots.length) return;
      for (const [id, ch] of Object.entries(c.chats)) if (gen.current[id] === undefined) gen.current[id] = ch.generation;
      setBots((cur) => (cur.length ? cur : c.bots));
      setRows((all) => {
        const next = { ...all };
        for (const [id, ch] of Object.entries(c.chats)) if (!next[id]?.length && gen.current[id] === ch.generation) next[id] = ch.rows;
        return next;
      });
      setBoot((b) => (b.state === 'ready' ? b : { state: 'ready', saved: true }));
      begin(c.bots);
    });
    loadBots(a).then((list) => {
      if (!alive || !list) return;
      begin(list);
      // The notification link (Android): replies, approvals and finished jobs while the app is closed.
      void startNotifications(a, { ask: true, account });
    });
    const close = a.events((ev) => {
      if (ev.type === 'rows') {
        if ((gen.current[ev.botId] ?? ev.generation) !== ev.generation) { gen.current[ev.botId] = ev.generation; setRows((all) => ({ ...all, [ev.botId]: merge([], ev.rows) })); }
        else setRows((all) => ({ ...all, [ev.botId]: merge(all[ev.botId] ?? [], ev.rows) }));
      } else if (ev.type === 'cleared') {
        bumpChat(ev.botId);
        gen.current[ev.botId] = ev.generation;
        setRows((all) => ({ ...all, [ev.botId]: [] }));
      } else if (ev.type === 'restored') {
        // "New conversation" was undone (here or on another device): the earlier chat comes back.
        delete gen.current[ev.botId];
        bumpChat(ev.botId);
        setRows((all) => ({ ...all, [ev.botId]: [] }));
        loadRows(a, ev.botId);
      } else if (ev.type === 'hello') {
        if (ev.resumed) flushWaiting.current();
      } else if (ev.type === 'bot') {
        setBots((list) => (list.some((b) => b.id === ev.bot.id) ? list.map((b) => (b.id === ev.bot.id ? ev.bot : b)) : [...list, ev.bot]));
      } else if (ev.type === 'live') {
        updateLive(ev.state);
      } else if (ev.type === 'roster') {
        loadBots(a);
      } else if (ev.type === 'page') {
        emitPageEvent(ev);
      } else if (ev.type === 'pages') {
        emitPagesEvent(ev);
      } else if (ev.type === 'side-chats') {
        const chats = (ev.chats ?? []) as SideChat[];
        for (const c of chats) if (c.live) updateLive(c.live);
        setSideChats((all) => ({ ...all, [ev.botId]: chats }));
      }
    }, undefined, () => { catchUp.current(); });
    return () => { alive = false; close(); };
  }, [session, loadBots, loadRows]);

  // Catching up: the live stream can drop events (a phone network switch, a proxy holding the stream), so
  // the open chat and the bots' states are fetched again whenever the stream reconnects, the app comes back
  // to the front, and every few seconds while the open chat is waiting on its bot.
  const catchUp = useRef<() => void>(() => {});
  // A reconnect the server could resume needs no fetch, but messages waiting to send still go out.
  const flushWaiting = useRef<() => void>(() => {});
  flushWaiting.current = () => { if (api) flushOutbox(); };
  catchUp.current = () => {
    if (!api) return;
    flushOutbox();
    loadBots(api);
    if (screen.name === 'chat') loadRows(api, chatIdOf(screen.botId));
  };
  // Back in front: fetch what was missed, and if the stream went quiet while the phone slept, reconnect now
  // instead of waiting for its timer. `frontTick` lets the open chat be marked read again.
  const [frontTick, setFrontTick] = useState(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      if (!streamHealthy()) kickConnection();
      catchUp.current();
      setFrontTick((n) => n + 1);
    });
    return () => sub.remove();
  }, []);
  const openChat = screen.name === 'chat' ? chatIdOf(screen.botId) : null;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // A voice call reads the bot's new replies out as they arrive.
  useEffect(() => { const b = getCall().botId; if (b) feedCallRows(b, rows[b]); }, [rows]);
  useEffect(() => {
    if (!api || !openChat) return;
    let ticks = 0;
    const t = setInterval(() => {
      ticks++;
      if (AppState.currentState !== 'active') return;
      const list = rowsRef.current[openChat] ?? [];
      const last = [...list].reverse().find((r) => r.body.type === 'message');
      const askedRecently = !!last && last.body.role === 'user' && Date.now() - last.createdAt < 15 * 60_000;
      if (!getLive(openChat)?.isRunning && !askedRecently) return;
      // While the live stream is open and talking it already brings every change, so asking again every four
      // seconds only costs battery and data: then one safety check every twenty seconds is enough.
      if (streamHealthy() && ticks % 5 !== 0) return;
      catchUp.current();
    }, 4000);
    return () => clearInterval(t);
  }, [api, openChat]);

  // A notification tapped while the app was already open: go to that chat.
  useEffect(() => {
    const id = openLink.current;
    if (!id || !api || !bots.length) return;
    openLink.current = null;
    if (!notificationChat(bots, id)) return;
    setStack((st) => {
      const top = st[st.length - 1];
      if (top.name === 'chat' && top.botId === id) return st;
      return [st[0].name === 'home' ? st[0] : { name: 'home' }, { name: 'chat', botId: id }];
    });
  }, [openTick, api, bots]);

  // A share, shortcut or link from outside: put the words in a chat's message box (never sent by itself), or open the place asked for.
  useEffect(() => {
    const q = quick.current;
    if (!q || !api || !bots.length) return;
    quick.current = null;
    const top = stack[stack.length - 1];
    const agents = bots.filter((b) => (b.kind ?? 'agent') !== 'room' && !b.outside);
    const target = (q.kind === 'assist' ? assistantBot(bots) : undefined)
      ?? (q.kind === 'ask' && q.botId ? agents.find((b) => b.id === q.botId) : undefined)
      ?? (top.name === 'chat' ? agents.find((b) => b.id === top.botId) : undefined)
      ?? agents.find((b) => b.isPrimary) ?? agents[0];
    if (q.kind === 'tasks') { if (top.name !== 'tasks') setStack((st) => [...st, { name: 'tasks' }]); return; }
    if (!target) return;
    const chat: Screen = { name: 'chat', botId: target.id };
    const base: Screen[] = [{ name: 'home' }, chat];
    if (q.kind === 'ask') {
      if (q.text) {
        const had = getDraft(target.id);
        setDraft(target.id, had.trim() ? `${had.replace(/\s+$/, '')}\n${q.text}` : q.text);
        setDraftTick((n) => n + 1);
      }
      setStack(base);
    } else if (q.kind === 'assist') {
      // The phone's assistant gesture: straight into that Bot's chat, listening if Settings › Assistant says so.
      setStack(base);
      if (assistantPrefs().listen) requestListen(target.id);
    } else if (q.kind === 'hub') {
      setStack(base);
    } else {
      setStack([...base, { name: 'call', botId: target.id }]);
    }
  }, [quickTick, api, bots]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the notification link what is on screen, so a reply in the open chat is not shown twice,
  // and take that chat's notifications down when it opens.
  useEffect(() => {
    const tell = (state: string) => background.notifyFocus(state === 'active', openChat);
    tell(String(AppState.currentState));
    if (openChat) background.notifyCancel([`chat:${openChat}`]);
    const sub = AppState.addEventListener('change', tell);
    return () => sub.remove();
  }, [openChat]);

  // Fetch a bot's rows the first time its chat opens, and mark it read. Read is sent when the chat opens, when a
  // new row arrives and when the app comes back to the front, not on every word of a streaming reply (it used to
  // be), and never while the app is in the background: a reply that arrives then stays unread until it is seen.
  const readMark = useRef<{ id: string; seq: number } | null>(null);
  useEffect(() => {
    if (!api || screen.name !== 'chat') { readMark.current = null; return; }
    const id = chatIdOf(screen.botId);
    if (!loaded.current[id] && !loadingRows.current[id]) loadRows(api, id);
    if (AppState.currentState !== 'active') return;
    const list = rows[id];
    const newest = list?.[list.length - 1]?.seq ?? 0;
    if (readMark.current?.id === id && readMark.current.seq === newest) return;
    readMark.current = { id, seq: newest };
    api.read(id).catch(() => { if (readMark.current?.id === id) readMark.current = null; });
  }, [api, screen, rows, loadRows, activeChat, sideChats, frontTick]);

  // Keep the phone's saved copy current (src/cache.ts), a moment after things settle.
  const botsRef = useRef(bots);
  botsRef.current = bots;
  useEffect(() => {
    if (!session || boot.state !== 'ready' || !bots.length) return;
    saveCacheSoon(accountRef.current, () => snapshot(botsRef.current, rowsRef.current, gen.current));
  }, [session, boot.state, bots, rows]);

  // A bot's side chats, the first time its chat opens (kept current by the side-chats event after that).
  const openBot = screen.name === 'chat' ? bots.find((b) => b.id === screen.botId) : undefined;
  const openBotSides = !!openBot && canHaveSideChats(openBot);
  useEffect(() => {
    if (!api || !openBot || !openBotSides || sideChats[openBot.id]) return;
    const epoch = accountEpoch.current;
    api.sideChats(openBot.id).then((r) => {
      if (epoch !== accountEpoch.current) return;
      for (const c of r.chats) if (c.live) updateLive(c.live);
      setSideChats((all) => ({ ...all, [openBot.id]: r.chats }));
    }).catch(() => {});
  }, [api, openBot?.id, openBotSides]);

  // Undo for a deleted side chat, for a few seconds (the server keeps it for 10 minutes).
  useEffect(() => {
    if (!sideUndo) return;
    const t = setTimeout(() => setSideUndo((cur) => (cur === sideUndo ? null : cur)), Math.max(0, sideUndo.until - Date.now()));
    return () => clearTimeout(t);
  }, [sideUndo]);
  useEffect(() => {
    if (!sideNote) return;
    const t = setTimeout(() => setSideNote(null), 4000);
    return () => clearTimeout(t);
  }, [sideNote]);
  const undoSideDelete = () => {
    const u = sideUndo;
    if (!u || !api) return;
    setSideUndo(null);
    api.restoreSideChat(u.id).then((r) => {
      setSideChats((all) => ({ ...all, [u.botId]: r.chats }));
      setActiveChat((a) => ({ ...a, [u.botId]: u.id }));
    }).catch((e) => setSideNote(e?.message ?? 'Could not undo.'));
  };

  // Android back button walks back through the screens.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // Something open inside the screen (the list's search box) closes first.
      if (runBack()) return true;
      // Back from a full-screen chat brings the bot list back first.
      if (wide && chatFull && stack[stack.length - 1]?.name === 'chat') { setChatFull(false); return true; }
      if (stack.length > 1) { pop(); return true; }
      return false;
    });
    return () => sub.remove();
  }, [stack, pop, wide, chatFull]);


  // "New conversation" (src/fresh.ts) starts at once; this bar offers Undo for a few seconds.
  const [freshUndo, setFreshUndo] = useState<FreshUndo | null>(null);
  const [freshNote, setFreshNote] = useState<string | null>(null);
  useEffect(() => onFresh((u) => { setFreshNote(null); setFreshUndo(u); }), []);
  useEffect(() => {
    if (!freshUndo) return;
    const t = setTimeout(() => setFreshUndo((cur) => (cur === freshUndo ? null : cur)), Math.max(0, freshUndo.until - Date.now()));
    return () => clearTimeout(t);
  }, [freshUndo]);
  useEffect(() => {
    if (!freshNote) return;
    const t = setTimeout(() => setFreshNote(null), 5000);
    return () => clearTimeout(t);
  }, [freshNote]);
  const undoFresh = () => {
    const u = freshUndo;
    if (!u || !api) return;
    setFreshUndo(null);
    api.freshUndo(u.botId).then(() => { delete gen.current[u.botId]; bumpChat(u.botId); return loadRows(api, u.botId); }).catch((e) => setFreshNote(e?.message ?? 'Could not undo.'));
  };

  const botById = (id: string) => bots.find((b) => b.id === id);
  // A message found by the search: its chat opens at that message; one from an earlier conversation opens that conversation to read.
  const openHit = (hit: SearchHit) => {
    if (!hit.current) { push({ name: 'history', botId: hit.botId, chatId: hit.chatId, generation: hit.generation, seq: hit.seq }); return; }
    setActiveChat((a) => ({ ...a, [hit.botId]: hit.chatId !== hit.botId ? hit.chatId : null }));
    setFocus({ botId: hit.chatId, seq: hit.seq });
    setStack((st) => {
      const base = st.filter((x) => x.name !== 'search' && !(x.name === 'chat'));
      return [...(base.length ? base : [startScreen(bots)]), { name: 'chat', botId: hit.botId }];
    });
  };
  const upsertBot = (b: Bot) => setBots((list) => (list.some((x) => x.id === b.id) ? list.map((x) => (x.id === b.id ? b : x)) : [...list, b]));

  // Opening a chat from the list beside an open chat swaps that chat rather than stacking another.
  const openFromHome = (b: Bot) => setStack((st) => (wide && st[st.length - 1].name === 'chat' ? [...st.slice(0, -1), { name: 'chat', botId: b.id }] : [...st, { name: 'chat', botId: b.id }]));
  const home = (selectedId: string | null, paneWidth?: number) => session && api ? (
    <Home paneWidth={paneWidth} api={api} bots={bots} loading={boot.state === 'loading'} loadError={boot.state === 'failed' ? boot.error ?? 'Could not load your bots.' : null}
      onRetry={() => { setBoot({ state: 'loading' }); kickConnection(); void loadBots(api); }} name={who ?? session.name ?? session.email} refreshing={refreshing} selectedId={selectedId}
      onRefresh={async () => { setRefreshing(true); if (!streamHealthy()) kickConnection(); await loadBots(api); setRefreshing(false); }}
      onOpen={openFromHome} onNewBot={limited ? undefined : () => push({ name: 'newbot' })} onNewGroup={limited ? undefined : () => push({ name: 'newgroup' })} onTasks={() => push({ name: 'tasks' })} onPcs={limited ? undefined : () => push({ name: 'pcs' })} onPlugins={limited ? undefined : (create?: boolean) => push({ name: 'plugins', create })} onSignOut={signOut} onDeviceLink={() => push({ name: 'devicelink' })}
      onPermissions={limited ? undefined : () => push({ name: 'permissions' })} onDevices={() => push({ name: 'devices' })} onSystem={limited ? undefined : () => push({ name: 'system' })} onUsage={limited ? undefined : () => push({ name: 'usage' })} onBotsComputer={limited ? undefined : () => push({ name: 'botscomputer' })}
      onBot={upsertBot} onHistory={(b) => push({ name: 'history', botId: b.id, chatId: b.id })} onSettings={(b) => push({ name: 'settings', botId: b.id })} onOpenHit={openHit} />
  ) : null;
  const split = (chat: React.ReactNode, selectedId: string | null) => (
    <SplitPane total={width} full={!!chat && chatFull} onFull={setChatFull} list={(w) => home(selectedId, w)}
      chat={chat ?? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <Text style={[type.caption, { textAlign: 'center' }]}>Pick a bot on the left to open its chat.</Text>
        </View>
      )} />
  );

  let body: React.ReactNode;
  if (session === undefined) {
    body = <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={color.inkMuted} /></View>;
  } else if (!session || !api) {
    body = screen.name === 'signin'
      ? <SignIn onBack={pop} onSignedIn={async (s) => { await saveSession(s); setSession(s); }} />
      : <Welcome onSignIn={() => push({ name: 'signin' })} />;
  } else if (screen.name === 'chat' && botById(screen.botId)) {
    const bot = botById(screen.botId)!;
    // The open chat: the bot's main chat, or one of its side chats (the same bot, with that chat's own id).
    const cid = chatIdOf(bot.id);
    const side = cid !== bot.id ? sideChats[bot.id]?.find((c) => c.id === cid) : undefined;
    const chatBot: Bot = side ? { ...bot, id: side.id, unread: side.unread, generation: side.generation, lastActivityAt: side.lastActivityAt } as Bot : bot;
    const sides = sideChats[bot.id] ?? [];
    // The chip sits in the chat header; the sheet is kept outside the chat. The header moves the chip when the
    // keyboard opens (big picture <-> small), and a sheet inside it was rebuilt then, which closed Rename at once.
    const switcher = canHaveSideChats(bot) ? <SideChatChip chats={sides} openId={side?.id ?? null} onPress={() => setSideSheet(true)} /> : undefined;
    const sideSheetEl = canHaveSideChats(bot) ? (
        <SideChatSheet visible={sideSheet} onClose={() => setSideSheet(false)} bot={bot} chats={sides} openId={side?.id ?? null}
          onPick={(id) => { setActiveChat((a) => ({ ...a, [bot.id]: id })); setSideSheet(false); }}
          onNew={async () => {
            const r = await api.newSideChat(bot.id);
            setSideChats((all) => ({ ...all, [bot.id]: [r.chat, ...(all[bot.id] ?? []).filter((c) => c.id !== r.chat.id)] }));
            setActiveChat((a) => ({ ...a, [bot.id]: r.chat.id }));
            setSideSheet(false);
          }}
          onRename={async (id, title) => { const r = await api.renameSideChat(id, title); setSideChats((all) => ({ ...all, [bot.id]: r.chats })); }}
          onDelete={async (c) => {
            await api.deleteSideChat(c.id);
            setSideChats((all) => ({ ...all, [bot.id]: (all[bot.id] ?? []).filter((x) => x.id !== c.id) }));
            if (activeChat[bot.id] === c.id) setActiveChat((a) => ({ ...a, [bot.id]: null }));
            setSideUndo({ id: c.id, botId: bot.id, title: c.title, until: Date.now() + 8000 });
          }} />
    ) : null;
    const chat = <Chat key={`${chatBot.id}:${draftTick}`} api={api} bot={chatBot} bots={bots} rows={rows[chatBot.id] ?? []} loaded={!!loaded.current[chatBot.id]} switcher={switcher}
      loadError={rows[chatBot.id]?.length ? null : rowErrors[chatBot.id] ?? null} earlierError={earlierErrors[chatBot.id] ?? null}
      onRetryLoad={() => loadRows(api, chatBot.id)} focusSeq={focus?.botId === chatBot.id ? focus.seq : undefined} onFocused={() => setFocus((f) => (f?.botId === chatBot.id ? null : f))} onBack={pop}
      onCall={() => (bot.outside ? openInChatGPT(bot) : push({ name: 'call', botId: bot.id }))} onComputer={() => push({ name: 'computer', botId: bot.id })} onRefresh={() => catchUp.current()} onEarlier={() => loadEarlier(api, chatBot.id)} onTasks={() => push({ name: 'tasks', botId: bot.id })} onSettings={(tab) => push({ name: 'settings', botId: bot.id, tab })}
      onPluginCode={(draftId) => push({ name: 'plugincode', draftId })} onFiles={(path) => push({ name: 'files', botId: bot.id, path })} onPages={() => push({ name: 'pages', botId: bot.id })}
      onExchanges={bot.outside ? () => push({ name: 'exchanges', botId: bot.id }) : undefined}
      ownerId={bot.id} onHistory={bot.outside ? undefined : () => push({ name: 'history', botId: bot.id, chatId: chatBot.id })} onSearch={() => push({ name: 'search' })}
      fullScreen={wide && chatFull} onFullScreen={wide ? () => setChatFull((f) => !f) : undefined} />;
    body = <>{wide ? split(chat, bot.id) : chat}{sideSheetEl}</>;
  } else if (screen.name === 'settings' && botById(screen.botId)) {
    const bot = botById(screen.botId)!;
    body = <BotSettings api={api} bot={bot} bots={bots} initialTab={screen.tab} onBack={pop} onBot={upsertBot}
      onComputer={() => push({ name: 'computer', botId: bot.id })}
      onAsk={limited ? (text) => { setDraft(bot.id, text); backToChat(); } : undefined}
      onDeleted={() => { const left = bots.filter((b) => b.id !== bot.id); setBots(left); setStack([startScreen(left)]); }} />;
  } else if (screen.name === 'exchanges' && botById(screen.botId)) {
    const bot = botById(screen.botId)!;
    body = <Exchanges api={api} bot={bot} bots={bots} onBack={pop} onOpenChatGPT={() => openInChatGPT(bot)} />;
  } else if (screen.name === 'history' && botById(screen.botId)) {
    // Reopening an earlier conversation: the server says so on the live stream and the chat reloads; go back to it.
    body = <History api={api} bot={botById(screen.botId)!} chatId={screen.chatId} startGeneration={screen.generation} focusSeq={screen.seq} onBack={pop}
      onContinued={() => {
        const { botId, chatId } = screen;
        delete gen.current[chatId]; bumpChat(chatId);
        setRows((all) => ({ ...all, [chatId]: [] }));
        void loadRows(api, chatId);
        setActiveChat((a) => ({ ...a, [botId]: chatId !== botId ? chatId : null }));
        setStack((st) => { const base = st.filter((x) => x.name !== 'history' && x.name !== 'search' && x.name !== 'chat'); return [...(base.length ? base : [startScreen(bots)]), { name: 'chat', botId }]; });
      }} />;
  } else if (screen.name === 'search') {
    body = <Search api={api} bots={bots} onBack={pop} onOpen={openHit} />;
  } else if (screen.name === 'permissions') {
    body = <Permissions api={api} onBack={pop} />;
  } else if (screen.name === 'devices') {
    body = <Devices api={api} onBack={pop} />;
  } else if (screen.name === 'usage') {
    body = <Usage api={api} onBack={pop} />;
  } else if (screen.name === 'system') {
    body = <SystemStatus api={api} onBack={pop} />;
  } else if (screen.name === 'botscomputer') {
    body = <BotsComputer api={api} bots={bots} onBack={pop} />;
  } else if (screen.name === 'devicelink') {
    body = <DeviceLink api={api} onBack={pop} />;
  } else if (screen.name === 'files' && botById(screen.botId)) {
    body = <Files api={api} bot={botById(screen.botId)!} startPath={screen.path} onBack={pop} />;
  } else if (screen.name === 'pages' && botById(screen.botId)) {
    body = <Pages api={api} bot={botById(screen.botId)!} onBack={pop} onOpen={(path) => push({ name: 'files', botId: screen.botId, path })} />;
  } else if (screen.name === 'call' && botById(screen.botId)) {
    body = <Call api={api} bot={botById(screen.botId)!} rows={rows[screen.botId] ?? []} onBack={pop} />;
  } else if (screen.name === 'computer' && botById(screen.botId)) {
    body = <Computer api={api} bot={botById(screen.botId)!} onBack={pop} />;
  } else if (screen.name === 'look' && botById(screen.botId)) {
    body = <CustomLook api={api} bot={botById(screen.botId)!} onBack={pop} onSaved={(b) => { upsertBot(b); pop(); }} />;
  } else if (screen.name === 'newbot') {
    body = <NewBot api={api} onBack={pop} onCreated={(b, custom) => {
      upsertBot(b);
      setStack((st) => [...st.slice(0, -1), { name: 'chat', botId: b.id }, ...(custom ? [{ name: 'look', botId: b.id, back: { name: 'chat', botId: b.id } } as Screen] : [])]);
    }} />;
  } else if (screen.name === 'tasks') {
    body = <Tasks api={api} bots={bots} bot={screen.botId ? botById(screen.botId) : undefined} onBack={pop} onOpen={(botId) => push({ name: 'chat', botId })} />;
  } else if (screen.name === 'pcs') {
    body = <Pcs api={api} bots={bots} onBack={pop} onWatch={(m, mode) => push({ name: 'pcscreen', machine: m, mode })} />;
  } else if (screen.name === 'connectors' || screen.name === 'plugins') {
    body = <Connections api={api} bots={bots} startCreating={screen.name === 'plugins' && screen.create} onBack={pop} onOpenChat={(botId) => push({ name: 'chat', botId })} onCode={(draftId) => push({ name: 'plugincode', draftId })} />;
  } else if (screen.name === 'plugincode') {
    body = <PluginCode api={api} draftId={screen.draftId} onBack={pop} />;
  } else if (screen.name === 'pcscreen') {
    body = <PcScreen api={api} machine={screen.machine} startMode={screen.mode} onBack={pop} />;
  } else if (screen.name === 'newgroup') {
    // The server makes the group, then the bot list is fetched again so the group's chat can open.
    body = <NewGroup api={api} bots={bots} onBack={pop} onCreated={async (id) => {
      await loadBots(api);
      setStack((st) => [...st.slice(0, -1), { name: 'chat', botId: id }]);
    }} />;
  } else {
    body = wide ? split(null, null) : home(null);
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: screen.name === 'computer' || screen.name === 'pcscreen' ? color.computer : color.ground }}>
        <StatusBar style={screen.name === 'computer' || screen.name === 'pcscreen' || scheme === 'dark' ? 'light' : 'dark'} />
        {!!session && !!api && screen.name !== 'computer' && screen.name !== 'pcscreen' && screen.name !== 'call' && (
          <ConnectionBanner state={connection} saved={!!boot.saved} onRetry={() => { kickConnection(); catchUp.current(); }} />
        )}
        <ErrorBoundary where={screen.name} resetKey={`${stack.length}:${screen.name}:${'botId' in screen ? screen.botId ?? '' : ''}`} onBack={stack.length > 1 ? pop : undefined}>
          {body}
        </ErrorBoundary>
        {sideUndo ? <UndoBar text={`Deleted the side chat "${sideUndo.title}".`} onPress={undoSideDelete} />
          : sideNote ? <UndoBar text={sideNote} action={null} />
          : freshUndo ? <UndoBar text={`New conversation. Cleared ${freshUndo.name}.`} onPress={undoFresh} />
          : freshNote ? <UndoBar text={freshNote} action={null} /> : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
