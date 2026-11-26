import { leaveTalk, startTalk, talkLink, type TalkLink } from './lib/talk';
import { QuickAsk } from './components/QuickAsk';
import { UpdateNotice } from './components/UpdateNotice';
import { useEffect, useState } from 'react';
import { isSimpleNow } from './lib/simple';
import { startEvents } from './lib/events';
import { isConnectedMessage } from './lib/api';
import { useStore } from './store';
import { ChatView } from './components/ChatView';
import { DetailsPanel } from './components/DetailsPanel';
import { Sidebar } from './components/Sidebar';
import { SignIn } from './components/SignIn';
import { PairApprove, pairIdFromPath } from './components/PairApprove';
import { FreshUndoToast } from './components/FreshUndoToast';
import { SideUndoToast } from './components/SideChats';
import { SearchModal } from './components/modals/SearchModal';
import { ConfigLayer } from './components/config/ConfigLayer';
import { useConfigUI } from './configStore';
import { Icon } from './components/Icon';
import { useLayout } from './lib/useLayout';
import { SideResizer, sideShown, useSidePanel, useWindowWidth } from './components/SideResizer';
import { loadPaneWidths } from './lib/paneWidths';
import { RAIL } from './lib/sidebarFit';
import type { CSSProperties } from 'react';
import { ShortcutsModal } from './components/modals/ShortcutsModal';
import { Lightbox } from './components/Lightbox';
import { restoreOutbox } from './lib/outbox';
import { restoreDrafts } from './lib/drafts';
import { chatIdFor } from './store';
import { api } from './lib/api';
import { ComputerViewer } from './components/ComputerViewer';
import { FilePane } from './components/files/FilePane';
import { TasksView } from './components/config/TasksView';
import { lazily } from './lib/lazy';

// Opened now and then, so loaded when first opened (lib/lazy.tsx): the first page stays small.
const DeviceLinkModal = lazily(() => import('./components/modals/DeviceLinkModal').then((m) => m.DeviceLinkModal));
const HistoryModal = lazily(() => import('./components/modals/HistoryModal').then((m) => m.HistoryModal));
const CreateGroupModal = lazily(() => import('./components/modals/CreateGroupModal').then((m) => m.CreateGroupModal));
const CreateBotModal = lazily(() => import('./components/modals/CreateBotModal').then((m) => m.CreateBotModal));

function Shell() {
  const detailsOpen = useStore((s) => s.detailsOpen);
  const filesOpen = useStore((s) => s.filesOpen);
  const modal = useStore((s) => s.modal);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const chatFull = useStore((s) => s.chatFull);
  const hasBot = useStore((s) => !!s.selectedBotId);
  const view = useConfigUI((s) => s.view);
  const layout = useLayout();
  const pane = useStore((s) => s.pane);
  const compact = layout === 'compact';
  // The three panes' widths: the list's edge is dragged in Sidebar, the side panel's here (SideResizer).
  const winW = useWindowWidth();
  const side = useSidePanel();
  const listSaved = useStore((s) => s.sidebarWidth);
  const listW = chatFull ? 0 : collapsed ? RAIL : listSaved;
  const sideW = side && !compact ? sideShown(layout, winW, side.saved, listW) : 0;
  // Each account keeps its own widths, and so does each window size (lib/paneWidths.ts).
  const uid = useStore((s) => s.user?.id);
  useEffect(() => { useStore.setState(loadPaneWidths(uid, layout)); }, [uid, layout]);
  // A link can open a settings page: /#settings/system, /#settings/usage and so on (a Bot or a notice can point there).
  useEffect(() => {
    const go = () => {
      const m = /^#settings(?:\/([a-z]+))?$/.exec(window.location.hash);
      if (!m) return;
      // A sign-in that sees only some Bots has only these three pages (AppSettings.tsx).
      const known = useStore.getState().user?.scope ? ['general', 'notifications', 'account'] : ['general', 'notifications', 'computer', 'pcs', 'permissions', 'connections', 'usage', 'system', 'account'];
      useConfigUI.getState().openAppSettings((known.includes(m[1] ?? '') ? m[1] : 'general') as Parameters<ReturnType<typeof useConfigUI.getState>['openAppSettings']>[0]);
      history.replaceState(null, '', window.location.pathname + window.location.search);
    };
    go();
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, []);

  // Without room for three columns the details panel slides over the chat, so start with it closed.
  // setState, not set(): this must not overwrite the choice saved for wide windows.
  useEffect(() => {
    if (layout !== 'wide') useStore.setState({ detailsOpen: false, filesOpen: false });
  }, [layout]);

  useEffect(() => {
    const st = useStore.getState();
    // Sam's sign-in (lib/simple.ts) has one assistant and no shared computer: open her chat straight away
    // (on a phone too, no list screen first) and don't ask for the computer, which her sign-in can't see.
    const simple = isSimpleNow();
    st.loadBots().then(() => { if (simple && useStore.getState().selectedBotId) useStore.getState().set({ pane: 'content' }); }).catch(console.error);
    if (!simple) st.loadComputer().catch(console.error);
    st.loadMuted().catch(() => {});
    // What this account left typed or unsent in this browser comes back (lib/drafts.ts, lib/outbox.ts).
    restoreDrafts();
    restoreOutbox();
    const stop = startEvents();
    // OAuth popups post back here; refresh connection-dependent views and the open transcript.
    const onMsg = (e: MessageEvent) => {
      if (!isConnectedMessage(e)) return;
      const s = useStore.getState();
      s.set({ connectionsVersion: s.connectionsVersion + 1 });
      if (s.selectedBotId) s.loadRows(s.selectedBotId).catch(() => {});
    };
    window.addEventListener('message', onMsg);
    return () => { stop(); window.removeEventListener('message', onMsg); };
  }, []);

  // Global shortcuts: ⌘K search, ⌘B sidebar, ⇧⌘, details, ⌘N new bot.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // Esc leaves a full-screen chat (unless a menu or dialog is open and wants it).
      if (e.key === 'Escape' && useStore.getState().chatFull && !useStore.getState().modal && !e.defaultPrevented) { useStore.getState().set({ chatFull: false }); return; }
      const st = useStore.getState();
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      const overlay = !!st.modal || st.viewerOpen || !!st.lightbox || !!useConfigUI.getState().appSettings || !!useConfigUI.getState().botSettings;
      const mod = e.metaKey || e.ctrlKey;
      // Alt+↑ / Alt+↓: the previous or next chat, in the list's order.
      if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !overlay) {
        const order = st.bots.filter((b) => !b.ownerHidden || b.id === st.selectedBotId).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || Number(!!a.outside) - Number(!!b.outside) || Number(b.pinned) - Number(a.pinned) || b.lastActivityAt - a.lastActivityAt);
        if (!order.length) return;
        const at = order.findIndex((b) => b.id === st.selectedBotId);
        const next = order[(at + (e.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length];
        e.preventDefault();
        st.openChat(next.id);
        return;
      }
      if (!mod && !e.altKey && !overlay && !typing) {
        // ? shows the shortcuts. Any letter typed with nothing focused goes to the message box.
        if (e.key === '?') { e.preventDefault(); st.setModal('shortcuts'); return; }
        if (e.key.length === 1 && e.key !== ' ' && useConfigUI.getState().view === 'chat') document.querySelector<HTMLTextAreaElement>('.composer__input')?.focus();
        return;
      }
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === '/') { e.preventDefault(); st.setModal(st.modal === 'shortcuts' ? null : 'shortcuts'); return; }
      if (e.shiftKey && key === 'o' && !overlay && st.selectedBotId) { e.preventDefault(); st.startFresh(chatIdFor(st, st.selectedBotId)).catch(() => {}); return; }
      if (key === 'k') { e.preventDefault(); st.setModal(st.modal === 'search' ? null : 'search'); }
      else if (key === 'b') { e.preventDefault(); st.set({ sidebarCollapsed: !st.sidebarCollapsed, chatFull: false }); }
      else if (e.shiftKey && key === 'f') { e.preventDefault(); st.set({ chatFull: !st.chatFull }); }
      else if (e.shiftKey && (key === ',' || key === '<')) { e.preventDefault(); st.set({ detailsOpen: !st.detailsOpen }); }
      else if (key === ',') { e.preventDefault(); useConfigUI.getState().openAppSettings(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // The tab (and the Windows app's title bar) says how many chats have something unread or are waiting for you.
  // A bot hidden from the list (Alex hid a bot) does not count.
  const waitingCount = useStore((s) => s.bots.filter((b) => !b.ownerHidden && (b.unread > 0 || !!s.live[b.id]?.awaiting)).length);
  useEffect(() => {
    const name = 'YBots';
    document.title = waitingCount ? `(${waitingCount}) ${name}` : name;
    return () => { document.title = name; };
  }, [waitingCount]);
  // Coming back to the window reads the open chat (it was left unread while the window was hidden).
  useEffect(() => {
    const seen = () => {
      if (document.visibilityState !== 'visible') return;
      const st = useStore.getState();
      const id = st.selectedBotId;
      if (!id || st.keptUnread[id] || useConfigUI.getState().view !== 'chat') return;
      const open = chatIdFor(st, id);
      const unread = open === id ? st.bots.find((b) => b.id === id)?.unread : st.sideChats[id]?.find((c) => c.id === open)?.unread;
      if (unread) api.markRead(open).catch(() => {});
    };
    document.addEventListener('visibilitychange', seen);
    window.addEventListener('focus', seen);
    return () => { document.removeEventListener('visibilitychange', seen); window.removeEventListener('focus', seen); };
  }, []);

  return (
    <div style={sideW ? ({ '--side-w': `${sideW}px` } as CSSProperties) : undefined} className={`app is-${layout}${compact ? ` pane-${pane}` : ''}${collapsed && !compact ? ' is-sidebar-collapsed' : ''}${chatFull && !compact ? ' is-chat-full' : ''}${(detailsOpen || filesOpen) && hasBot && view === 'chat' ? ' has-details' : ''}`}>
      <Sidebar />
      <UpdateNotice />
      {compact && pane === 'content' && (
        <button type="button" className="compact-back" onClick={() => useStore.getState().set({ pane: 'list' })} aria-label="Back to bots" title="Back">
          <Icon name="chev_left" opacity={0.8} />
        </button>
      )}
      {/* On a phone the list and the chat are separate screens; the hidden one isn't mounted (so the composer measures itself when shown). */}
      {!(compact && pane === 'list') && (view === 'tasks' ? <TasksView /> : <ChatView />)}
      {!(compact && pane === 'list') && hasBot && view === 'chat' && (filesOpen ? <FilePane /> : detailsOpen && <DetailsPanel />)}
      {side && !compact && <SideResizer key={side.kind} kind={side.kind} width={sideW} />}
      {modal === 'create' && <CreateBotModal />}
      {modal === 'group' && <CreateGroupModal />}
      {modal === 'search' && <SearchModal />}
      {modal === 'device' && <DeviceLinkModal />}
      {modal === 'history' && <HistoryModal />}
      {modal === 'shortcuts' && <ShortcutsModal />}
      <Lightbox />
      {viewerOpen && <ComputerViewer />}
      <ConfigLayer />
      <FreshUndoToast />
      <SideUndoToast />
    </div>
  );
}

export function App() {
  const authChecked = useStore((s) => s.authChecked);
  const user = useStore((s) => s.user);
  useEffect(() => { useStore.getState().checkAuth(); }, []);
  // A request answered "not signed in": ask the server who we are, which shows the sign-in page if nobody.
  useEffect(() => {
    const out = () => { useStore.getState().checkAuth(); };
    window.addEventListener('cleftbot:signed-out', out);
    return () => window.removeEventListener('cleftbot:signed-out', out);
  }, []);
  // The Windows app: a click on one of its notifications opens that chat.
  useEffect(() => {
    window.cleftShell?.onOpenChat?.((botId) => useStore.getState().openChat(botId));
    // The Windows app's Talk shortcut or tray item (0.12.1+): open the talk Bot's chat and start dictating (lib/talk.ts).
    window.cleftShell?.onTalk?.(() => { startTalk(); });
  }, []);
  // A `/?talk` link (and the Windows Talk popup): only the quick-ask card, until "Open in app".
  const [talk, setTalk] = useState<TalkLink | null>(() => talkLink());
  const authError = useStore((s) => s.authError);
  if (!authChecked) return <div className="boot" />;
  // Nobody known yet and the server did not answer: say so and keep asking, instead of a sign-in page that cannot work.
  if (authError && !user) return <CantReach />;
  const pairId = pairIdFromPath();
  if (user && pairId) return <PairApprove id={pairId} />;
  // Signed in, Shell keeps the title (it adds the unread count).
  if (!user) document.title = 'YBots';
  // Keyed by account, so nothing on screen (drafts, open panes, forms) carries over to another account.
  if (user && talk) {
    return <QuickPage key={user.id} link={talk} onOpenApp={(botId) => { leaveTalk(); setTalk(null); if (botId) setTimeout(() => useStore.getState().openChat(botId), 0); }} />;
  }
  return user ? <Shell key={user.id} /> : <SignIn />;
}

/** The quick-ask card on its own: the Bots and the live event stream, without the rest of the app. */
function QuickPage({ link, onOpenApp }: { link: TalkLink; onOpenApp: (botId: string | null) => void }) {
  useEffect(() => {
    useStore.getState().loadBots().catch(console.error);
    return startEvents();
  }, []);
  useEffect(() => { document.title = 'Talk · YBots'; }, []);
  return <QuickAsk wanted={link.wanted} popup={link.popup} onOpenApp={onOpenApp} />;
}

/** First load with no answer from the server: says so, asks again every few seconds, and goes in by itself. */
function CantReach() {
  const [tries, setTries] = useState(0);
  useEffect(() => {
    const t = setTimeout(async () => { await useStore.getState().checkAuth(); setTries((n) => n + 1); }, Math.min(3000 + tries * 1000, 10_000));
    return () => clearTimeout(t);
  }, [tries]);
  return (
    <div className="boot boot--error" role="status">
      <div className="boot__card">
        <div className="boot__title">Can’t reach YBots</div>
        <div className="boot__sub">{navigator.onLine === false ? 'This device is offline.' : 'The server is not answering. It may be restarting.'} Trying again by itself…</div>
        <button type="button" className="btn btn--primary" onClick={() => { void useStore.getState().checkAuth(); }}>Try now</button>
      </div>
    </div>
  );
}
