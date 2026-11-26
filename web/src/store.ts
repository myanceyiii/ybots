import { create } from 'zustand';
import { clearNotices, showNotice } from './lib/notify';
import type { Bot, ComputerState, LiveState, Routine, Row, ServerEvent, SideChat, User } from '@shared/types';
import { api, type SignInInfo } from './lib/api';
import { lsGet, lsSet } from './lib/storage';
import { loadPaneWidths, savePaneWidth } from './lib/paneWidths';

export type ModalKind = 'create' | 'search' | 'group' | 'device' | 'history' | 'shortcuts' | null;

interface Transcript { generation: number; bySeq: Record<number, Row>; loaded: boolean }

interface State {
  user: User | null;
  devLogin: boolean;
  signIn: SignInInfo;
  authChecked: boolean;
  /** The server could not be asked who is signed in (offline, restarting): the app waits and asks again. */
  authError: boolean;

  bots: Bot[];
  live: Record<string, LiveState>;
  selectedBotId: string | null;
  transcripts: Record<string, Transcript>;
  routines: Record<string, Routine[]>;
  computer: ComputerState | null;
  /** Bumped on every `connections` event so open views can refetch. */
  connectionsVersion: number;
  /** Bumped when a paired PC changes (online, settings); the Your PCs page reloads on it. */
  machinesVersion: number;
  sseConnected: boolean;
  /** The server now serves a newer web app than the one this page loaded (lib/events.ts): offer a reload. */
  updateReady: boolean;
  /** The server said it is stopping for an update; cleared when it answers again. */
  restarting: boolean;

  detailsOpen: boolean;
  /** The file pane (components/files/FilePane.tsx) takes the details panel's place while open. */
  filesOpen: boolean;
  /** The file open in it (workspace-relative), or null for the list. */
  filesPath: string | null;
  filesTab: 'chat' | 'all';
  sidebarCollapsed: boolean;
  /** The bot list's dragged width (lib/sidebarFit.ts), kept in this browser; the rail is sidebarCollapsed. */
  sidebarWidth: number;
  /** The side panel's dragged widths (lib/paneWidths.ts), one for the details panel and one for the file pane. */
  detailsWidth: number;
  filesWidth: number;
  /** Where the open file was opened from: the Files list (Back returns there) or anywhere else (Back returns to the agent's panel). */
  filesFrom: 'list' | 'panel';
  /** The chat fills the window: the list (and details) slide away. Not saved. */
  chatFull: boolean;
  /** Set to Date.now() to open the details panel on the Engine section, expanded (EngineSettings.tsx). Not saved. */
  engineReveal: number;
  /** On a phone only one pane shows: the bot list, or what was opened from it (a chat, Tasks). Not saved. */
  pane: 'list' | 'content';
  modal: ModalKind;
  viewerOpen: boolean;
  /** How the large computer view opens, and the mode it is in while open. */
  viewerMode: 'watch' | 'control';
  /** One line shown under the large computer view while the person is driving (e.g. a sign-in to finish). */
  viewerHint: string | null;
  /** "New conversation" was just started here: the Undo toast (components/FreshUndoToast.tsx) shows until `until`. */
  freshUndo: { botId: string; name: string; until: number } | null;
  /** Each bot's side chats (server side-chats.ts), most recently used first. */
  sideChats: Record<string, SideChat[]>;
  /** The chat open for each bot: one of its side chats, or null/absent for its main chat. Kept in this browser. */
  activeChat: Record<string, string | null>;
  /** A side chat was just deleted here: its Undo toast shows until `until`. */
  sideUndo: { chatId: string; botId: string; title: string; until: number } | null;
  /** A message to scroll to and light up (from search): the chat it is in and its place. */
  focus: { chatId: string; seq: number; at: number } | null;
  /** Earlier conversations (components/modals/HistoryModal.tsx): whose, and which one (and message) to open on. */
  history: { botId: string; generation?: number; seq?: number } | null;
  /** A picture opened large (components/Lightbox.tsx). */
  lightbox: { src: string; name: string; download?: string } | null;
  /** Muted chats: bot or group id -> until (ms), 0 for "until I turn it back on". */
  muted: Record<string, number>;
  /** Chats marked unread by hand: they stay unread while open, until picked again. */
  keptUnread: Record<string, true>;
  loadMuted(): Promise<void>;
  /** Mute a chat's notifications until a time (0 = until turned back on), or null to unmute. */
  setMute(botId: string, until: number | null): Promise<void>;
  setPinned(botId: string, pinned: boolean): Promise<void>;
  /** Hide a bot from this account's own list and notifications, or show it again (Bot.ownerHidden). */
  setOwnerHidden(botId: string, hidden: boolean): Promise<void>;
  markUnread(botId: string): Promise<void>;
  markReadNow(botId: string): Promise<void>;
  /** Open a chat on one message (from search). */
  focusMessage(chatId: string, seq: number): void;
  openHistory(botId: string, generation?: number, seq?: number): void;
  loadSideChats(botId: string): Promise<void>;
  /** Open a bot's main chat (null) or one of its side chats. */
  openSideChat(botId: string, chatId: string | null): void;
  newSideChat(botId: string): Promise<void>;
  renameSideChat(chatId: string, title: string): Promise<void>;
  deleteSideChat(chatId: string): Promise<void>;
  undoDeleteSideChat(): Promise<void>;

  /** Who is signed in. 'error' means the server could not say (offline, a server error): not signed out. */
  checkAuth(): Promise<'signed-in' | 'signed-out' | 'error'>;
  loadBots(): Promise<void>;
  selectBot(id: string): void;
  /** Open a bot's chat from anywhere (a notification, search, the Windows app): leaves Tasks, shows the chat. */
  openChat(id: string): void;
  loadRows(id: string): Promise<void>;
  loadRoutines(id: string): Promise<void>;
  loadComputer(): Promise<void>;
  upsertRows(botId: string, generation: number, rows: Row[]): void;
  handleEvent(ev: ServerEvent): void;
  setModal(m: ModalKind): void;
  /** Sign out on the server, then reload. Reloads only when the server confirmed; otherwise the reason. */
  signOut(): Promise<string | null>;
  /** Why the last sign-out failed (shown in Settings, Account, with Try again). */
  signOutError: string | null;
  /** Start a new conversation for a bot or group, with an Undo toast instead of a confirm step. */
  startFresh(botId: string): Promise<void>;
  /** Undo the last "New conversation" (the server allows it while the new chat is empty, for 10 minutes). */
  undoFresh(): Promise<void>;
  set(p: Partial<State>): void;
}

const LS_SELECTED = 'selectedBot';
const LS_ACTIVE_CHAT = 'activeChat';
const savedActiveChat = (): Record<string, string | null> => { try { const v = JSON.parse(lsGet(LS_ACTIVE_CHAT) ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

/** The chat that is open for a bot: its side chat's id, or the bot's own id for its main chat. */
export const chatIdFor = (s: { activeChat: Record<string, string | null>; sideChats: Record<string, SideChat[]> }, botId: string) => {
  const id = s.activeChat[botId];
  return id && (s.sideChats[botId] ?? []).some((c) => c.id === id) ? id : botId;
};
/** The bot a side chat belongs to, from the side chat lists loaded so far. */
const ownerOfChat = (s: { sideChats: Record<string, SideChat[]> }, chatId: string) => Object.entries(s.sideChats).find(([, list]) => list.some((c) => c.id === chatId))?.[0] ?? sideOwners.get(chatId) ?? null;
/** Side chats named by notifications before their bot's list was loaded: side chat id -> bot id. */
const sideOwners = new Map<string, string>();

// Answers that arrive after the account changed, or after a chat was cleared or restored, belong to
// a state that is gone: each load notes these counters when it starts and drops its answer if they moved.
let accountEpoch = 0;
const chatEpochs = new Map<string, number>();
const bumpChat = (botId: string) => chatEpochs.set(botId, (chatEpochs.get(botId) ?? 0) + 1);
/** A token for "this account, this chat, as it is now"; `isCurrentChat` says whether it still holds. */
export const chatToken = (botId: string) => `${accountEpoch}:${chatEpochs.get(botId) ?? 0}`;
export const isCurrentChat = (botId: string, token: string) => chatToken(botId) === token;

/** Everything that belongs to the signed-in account. Cleared when a different account (or nobody) signs in. */
const accountState = () => ({
  bots: [] as Bot[], live: {}, transcripts: {}, routines: {}, computer: null, selectedBotId: null,
  filesOpen: false, filesPath: null, modal: null as ModalKind, viewerOpen: false, viewerHint: null, freshUndo: null, pane: 'list' as const,
  sideChats: {} as Record<string, SideChat[]>, sideUndo: null, focus: null, history: null, lightbox: null, muted: {} as Record<string, number>, keptUnread: {} as Record<string, true>,
});
const LS_DETAILS = 'detailsOpen';
const LS_SIDEBAR = 'sidebarCollapsed';

export const useStore = create<State>((set, get) => ({
  user: null,
  devLogin: false,
  signIn: {},
  authChecked: false,
  authError: false,
  focus: null,
  history: null,
  lightbox: null,
  muted: {},
  keptUnread: {},
  bots: [],
  live: {},
  selectedBotId: lsGet(LS_SELECTED),
  transcripts: {},
  routines: {},
  computer: null,
  connectionsVersion: 0,
  machinesVersion: 0,
  sseConnected: false,
  updateReady: false,
  restarting: false,
  detailsOpen: lsGet(LS_DETAILS) !== '0',
  filesOpen: false,
  filesPath: null,
  filesTab: 'chat',
  sidebarCollapsed: lsGet(LS_SIDEBAR) === '1',
  ...loadPaneWidths(undefined),
  filesFrom: 'panel',
  chatFull: false,
  engineReveal: 0,
  pane: 'list',
  modal: null,
  viewerOpen: false,
  viewerMode: 'watch',
  viewerHint: null,
  freshUndo: null,
  sideChats: {},
  activeChat: savedActiveChat(),
  sideUndo: null,

  async checkAuth() {
    const before = get().user?.id ?? null;
    let user: User | null = null;
    let outcome: 'signed-in' | 'signed-out' | 'error';
    try {
      const me = await api.me();
      user = me.user;
      outcome = user ? 'signed-in' : 'signed-out';
      set({ devLogin: me.devLogin, signIn: me.signIn ?? {} });
    } catch {
      // Not an answer: whoever was signed in still is, as far as anyone knows. Nothing is dropped; a first
      // visit shows "can't reach the server" (App.tsx) and asks again instead of the sign-in page.
      set({ authError: true, authChecked: true });
      return 'error';
    }
    set({ authError: false });
    if ((user?.id ?? null) !== before) {
      // Another account (or nobody): drop the previous account's chats, bots and drafts before
      // anything renders, and make any answer still on its way for them land nowhere.
      accountEpoch++;
      chatEpochs.clear();
      set({ ...accountState(), selectedBotId: before === null ? get().selectedBotId : null });
      window.dispatchEvent(new Event('cleftbot:account-changed'));
    }
    set({ user, authChecked: true });
    return outcome;
  },

  async loadBots() {
    const epoch = accountEpoch;
    const { bots, live } = await api.bots();
    if (epoch !== accountEpoch) return;
    const liveMap: Record<string, LiveState> = {};
    for (const l of live) liveMap[l.botId] = l;
    const sel = get().selectedBotId;
    const selectedBotId = sel && bots.some((b) => b.id === sel) ? sel : (bots.find((b) => b.isPrimary) ?? bots[0])?.id ?? null;
    set({ bots, live: liveMap });
    if (selectedBotId !== get().selectedBotId || !get().transcripts[selectedBotId ?? '']) {
      if (selectedBotId) get().selectBot(selectedBotId);
    }
  },

  selectBot(id) {
    set({ selectedBotId: id });
    lsSet(LS_SELECTED, id);
    const t = get().transcripts[id];
    if (!t?.loaded) get().loadRows(id).catch(console.error);
    get().loadRoutines(id).catch(console.error);
    const bot = get().bots.find((b) => b.id === id);
    if (get().keptUnread[id]) set((s) => { const k = { ...s.keptUnread }; delete k[id]; return { keptUnread: k }; });
    if (bot?.unread) api.markRead(id).catch(() => {});
    if (bot && bot.kind !== 'room' && !bot.outside) get().loadSideChats(id).catch(console.error);
  },

  openChat(id) {
    // A side chat's id (a notification about it, the Windows app) opens that side chat of its bot.
    const owner = get().bots.some((b) => b.id === id) ? null : ownerOfChat(get(), id);
    const botId = owner ?? id;
    if (!get().bots.some((b) => b.id === botId)) return;
    get().selectBot(botId);
    if (owner) get().openSideChat(owner, id);
    set({ pane: 'content' });
    window.dispatchEvent(new CustomEvent('cleftbot:open-chat', { detail: botId }));
  },

  async loadMuted() {
    const epoch = accountEpoch;
    const { prefs } = await api.notifyPrefs();
    if (epoch === accountEpoch) set({ muted: prefs.muted ?? {} });
  },

  async setMute(botId, until) {
    const { prefs } = await api.setNotifyPrefs(until === null ? { unmute: botId } : { mute: { botId, until } });
    set({ muted: prefs.muted ?? {} });
  },

  async setPinned(botId, pinned) {
    const { bot } = await api.setPinned(botId, pinned);
    set((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? bot : b)) }));
  },

  async setOwnerHidden(botId, hidden) {
    const { bot } = await api.setOwnerHidden(botId, hidden);
    set((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? bot : b)) }));
  },

  async markUnread(botId) {
    set((s) => ({ keptUnread: { ...s.keptUnread, [botId]: true } }));
    await api.markUnread(botId);
  },

  async markReadNow(botId) {
    set((s) => { const k = { ...s.keptUnread }; delete k[botId]; return { keptUnread: k }; });
    await api.markRead(botId);
  },

  focusMessage(chatId, seq) {
    get().openChat(chatId);
    set({ focus: { chatId, seq, at: Date.now() } });
  },

  openHistory(botId, generation, seq) {
    set({ history: { botId, generation, seq }, modal: 'history' });
  },

  async loadSideChats(botId) {
    const epoch = accountEpoch;
    const r = await api.sideChats(botId);
    if (epoch !== accountEpoch) return;
    set((s) => ({ sideChats: { ...s.sideChats, [botId]: r.chats } }));
    const open = chatIdFor(get(), botId);
    if (open !== botId) {
      if (!get().transcripts[open]?.loaded) get().loadRows(open).catch(console.error);
      if (r.chats.find((c) => c.id === open)?.unread) api.markRead(open).catch(() => {});
    }
  },

  openSideChat(botId, chatId) {
    set((s) => ({ activeChat: { ...s.activeChat, [botId]: chatId } }));
    lsSet(LS_ACTIVE_CHAT, JSON.stringify(get().activeChat));
    const id = chatId ?? botId;
    if (!get().transcripts[id]?.loaded) get().loadRows(id).catch(console.error);
    const unread = chatId ? get().sideChats[botId]?.find((c) => c.id === chatId)?.unread : get().bots.find((b) => b.id === botId)?.unread;
    if (unread) api.markRead(id).catch(() => {});
  },

  async newSideChat(botId) {
    const { chat } = await api.newSideChat(botId);
    set((s) => ({ sideChats: { ...s.sideChats, [botId]: [chat, ...(s.sideChats[botId] ?? []).filter((c) => c.id !== chat.id)] } }));
    get().openSideChat(botId, chat.id);
  },

  async renameSideChat(chatId, title) {
    const owner = ownerOfChat(get(), chatId);
    const r = await api.renameSideChat(chatId, title);
    if (owner) set((s) => ({ sideChats: { ...s.sideChats, [owner]: r.chats } }));
  },

  async deleteSideChat(chatId) {
    const owner = ownerOfChat(get(), chatId);
    if (!owner) return;
    const title = get().sideChats[owner]?.find((c) => c.id === chatId)?.title ?? 'the side chat';
    await api.deleteSideChat(chatId);
    set((s) => ({ sideChats: { ...s.sideChats, [owner]: (s.sideChats[owner] ?? []).filter((c) => c.id !== chatId) }, sideUndo: { chatId, botId: owner, title, until: Date.now() + 10_000 } }));
    if (get().activeChat[owner] === chatId) get().openSideChat(owner, null);
  },

  async undoDeleteSideChat() {
    const u = get().sideUndo;
    if (!u) return;
    set({ sideUndo: null });
    const r = await api.restoreSideChat(u.chatId);
    set((s) => ({ sideChats: { ...s.sideChats, [u.botId]: r.chats } }));
    get().openSideChat(u.botId, u.chatId);
  },

  async loadRows(id) {
    const token = chatToken(id);
    const { generation, rows } = await api.rows(id);
    if (!isCurrentChat(id, token)) return; // cleared, restored or signed out meanwhile: a newer read follows
    const bySeq: Record<number, Row> = {};
    for (const r of rows) bySeq[r.seq] = r;
    // Merge with anything that streamed in while we were fetching.
    const prev = get().transcripts[id];
    if (prev && prev.generation === generation) {
      for (const r of Object.values(prev.bySeq)) if (!bySeq[r.seq] || bySeq[r.seq].updatedSeq < r.updatedSeq) bySeq[r.seq] = r;
    }
    set((s) => ({ transcripts: { ...s.transcripts, [id]: { generation, bySeq, loaded: true } } }));
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('fixtures')) {
      import('./dev/fixtures').then((m) => m.injectFixtures());
    }
  },

  async loadRoutines(id) {
    const epoch = accountEpoch;
    const { routines } = await api.routines(id);
    if (epoch !== accountEpoch) return;
    set((s) => ({ routines: { ...s.routines, [id]: routines } }));
  },

  async loadComputer() {
    const epoch = accountEpoch;
    const { computer } = await api.computer();
    if (epoch !== accountEpoch) return;
    set({ computer });
  },

  upsertRows(botId, generation, rows) {
    set((s) => {
      const prev = s.transcripts[botId];
      if (prev && generation < prev.generation) return {};
      const base: Transcript = !prev || generation > prev.generation ? { generation, bySeq: {}, loaded: prev?.loaded ?? false } : prev;
      const bySeq = { ...base.bySeq };
      for (const r of rows) {
        const cur = bySeq[r.seq];
        if (!cur || r.updatedSeq >= cur.updatedSeq) bySeq[r.seq] = r;
      }
      return { transcripts: { ...s.transcripts, [botId]: { ...base, generation, bySeq } } };
    });
  },

  handleEvent(ev) {
    const s = get();
    switch (ev.type) {
      case 'hello':
      case 'ping':
      case 'restarting':
        return;
      case 'rows':
        s.upsertRows(ev.botId, ev.generation, ev.rows);
        return;
      case 'cleared':
        bumpChat(ev.botId);
        set((st) => ({ transcripts: { ...st.transcripts, [ev.botId]: { generation: ev.generation, bySeq: {}, loaded: true } } }));
        return;
      case 'restored':
        // "New conversation" was undone (here or on another device): the earlier chat comes back.
        bumpChat(ev.botId);
        set((st) => ({ transcripts: { ...st.transcripts, [ev.botId]: { generation: ev.generation, bySeq: {}, loaded: false } } }));
        s.loadRows(ev.botId).catch(console.error);
        return;
      case 'live':
        set((st) => ({ live: { ...st.live, [ev.state.botId]: ev.state } }));
        return;
      case 'roster':
        s.loadBots().catch(console.error);
        return;
      case 'bot': {
        const exists = s.bots.some((b) => b.id === ev.bot.id);
        // Opening a bot marks it read; keep the open bot at 0 unread.
        if (ev.bot.id === s.selectedBotId && chatIdFor(s, ev.bot.id) === ev.bot.id && ev.bot.unread > 0 && document.visibilityState === 'visible' && !s.keptUnread[ev.bot.id]) api.markRead(ev.bot.id).catch(() => {});
        set((st) => ({ bots: exists ? st.bots.map((b) => (b.id === ev.bot.id ? ev.bot : b)) : [...st.bots, ev.bot] }));
        return;
      }
      case 'side-chats': {
        set((st) => ({ sideChats: { ...st.sideChats, [ev.botId]: ev.chats } }));
        // The open side chat keeps 0 unread while it is in front, like an open bot.
        const open = chatIdFor(get(), ev.botId);
        if (ev.botId === s.selectedBotId && open !== ev.botId && document.visibilityState === 'visible' && ev.chats.find((c) => c.id === open)?.unread) api.markRead(open).catch(() => {});
        return;
      }
      case 'computer':
        set({ computer: ev.state });
        return;
      case 'routines':
        if (s.routines[ev.botId] || ev.botId === s.selectedBotId) s.loadRoutines(ev.botId).catch(console.error);
        return;
      case 'tasks':
      case 'memories':
      case 'page':
      case 'pages':
        // Picked up by configStore.ts (Tasks view, Library/Tasks tabs, bot settings) and an open Page (PageView.tsx).
        window.dispatchEvent(new CustomEvent('cleftbot:event', { detail: ev }));
        return;
      case 'connections':
        set((st) => ({ connectionsVersion: st.connectionsVersion + 1 }));
        return;
      case 'machines':
        set((st) => ({ machinesVersion: st.machinesVersion + 1 }));
        return;
      case 'look-run':
        // The Look tab picks the pictures up itself (api.lookRuns); the server's notice says so when the page is not in front.
        window.dispatchEvent(new CustomEvent('cleftbot:event', { detail: ev }));
        return;
      case 'notify':
        // A message for the chat that is open and in front is already on screen; showNotice skips anything while the page is in front.
        // A notice about a side chat opens that side chat (and the Windows app is handed its id to open).
        if (ev.n.chatId) sideOwners.set(ev.n.chatId, ev.n.botId);
        showNotice(ev.n.chatId ? { ...ev.n, botId: ev.n.chatId } : ev.n, (id) => get().openChat(id));
        return;
      case 'notify-clear':
        clearNotices(ev.tags);
        return;
    }
  },

  setModal(modal) { set({ modal }); },

  signOutError: null,
  async signOut() {
    try {
      await api.logout();
    } catch (e) {
      const msg = `Couldn't sign out: ${(e as Error).message || 'the server did not answer'}. You are still signed in. Check your connection and try again.`;
      set({ signOutError: msg });
      return msg;
    }
    set({ signOutError: null });
    location.reload();
    return null;
  },

  async startFresh(botId) {
    await api.fresh(botId);
    bumpChat(botId);
    const bot = get().bots.find((b) => b.id === botId);
    const name = bot ? (bot.kind === 'room' ? `the ${bot.name} chat` : `${bot.name}'s chat`) : 'the chat';
    set({ freshUndo: { botId, name, until: Date.now() + 10_000 } });
  },

  async undoFresh() {
    const u = get().freshUndo;
    if (!u) return;
    set({ freshUndo: null });
    await api.freshUndo(u.botId);
    bumpChat(u.botId);
    await get().loadRows(u.botId);
  },

  set(p) {
    if (p.detailsOpen !== undefined) lsSet(LS_DETAILS, p.detailsOpen ? '1' : '0');
    if (p.sidebarCollapsed !== undefined) lsSet(LS_SIDEBAR, p.sidebarCollapsed ? '1' : '0');
    const uid = get().user?.id;
    if (p.sidebarWidth !== undefined) savePaneWidth(uid, 'list', p.sidebarWidth);
    if (p.detailsWidth !== undefined) savePaneWidth(uid, 'details', p.detailsWidth);
    if (p.filesWidth !== undefined) savePaneWidth(uid, 'files', p.filesWidth);
    set(p);
  },
}));

/** Rows for a bot, ordered by seq. */
export function sortedRows(t: Transcript | undefined): Row[] {
  if (!t) return [];
  return Object.values(t.bySeq).sort((a, b) => a.seq - b.seq);
}

export const displayName = (b: Pick<Bot, 'name' | 'label'>) => (b.label ? `${b.name} · ${b.label}` : b.name);

export function useSelectedBot(): Bot | undefined {
  return useStore((s) => s.bots.find((b) => b.id === s.selectedBotId));
}
