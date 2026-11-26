import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useSidePanel } from './SideResizer';
import { sideMax } from '../lib/paneWidths';
import { RAIL, sidebarFit, sidebarMax, snapSidebar, type SidebarFit } from '../lib/sidebarFit';
import { useConfigUI } from '../configStore';
import { TasksIsland } from './config/TasksView';
import { PluginsIsland } from './config/PluginsIsland';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { displayName, useStore } from '../store';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { useLayout } from '../lib/useLayout';
import { relativeShort } from '../lib/time';
import { SideChatList, keepOrder } from './SideChats';
import { keyHint } from '../lib/keys';
import { useDrafts } from '../lib/drafts';
import { usePrefs, type ListFilter } from '../lib/prefs';

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

const LINK_TEXT = { ready: 'Linked', paused: 'Paused', offline: 'Offline', 'not-set-up': 'Not set up' } as const;

/** The row's line in its whole forms, longest first (server/src/list-preview.ts); the row shows the first that fits. */
function previewFor(bot: Bot, running: boolean, awaiting: string | null): string[] {
  const own = () => bot.previewForms?.length ? bot.previewForms : bot.lastPreview ? [bot.lastPreview, ...(bot.previewShort && bot.previewShort !== bot.lastPreview ? [bot.previewShort] : [])] : null;
  if (bot.outside) {
    const o = bot.outside;
    if (o.status !== 'ready') return [`${LINK_TEXT[o.status]} · #${o.channelName}`];
    if (o.waiting) return [`${o.waiting} waiting for an answer`];
    return own() ?? [`Answers through Slack #${o.channelName}`];
  }
  if (awaiting) return [`Waiting for you: ${awaiting}`, 'Waiting for you.'];
  if (running && !bot.lastPreview) return ['Working…'];
  return own() ?? ['No messages yet'];
}

/**
 * The preview never cut mid-text: the longest whole form that fits the row's three lines, else the shortest.
 * Measured on the real element's width, so it holds at any width (phone, a dragged-narrow list, Windows).
 */
function PreviewLine({ forms, style }: { forms: string[]; style?: CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  const key = forms.join('\u0000');
  const [pick, setPick] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || forms.length < 2) { setPick(0); return; }
    const check = () => {
      // A hidden copy with the same class and width, so React's own text node is never touched. scrollHeight
      // passes clientHeight once the three-line clamp would hide part of a form.
      const probe = el.cloneNode(false) as HTMLElement;
      Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', width: `${el.clientWidth}px`, left: '0', top: '0' });
      el.parentElement?.appendChild(probe);
      let i = 0;
      for (; i < forms.length - 1; i++) {
        probe.textContent = forms[i];
        if (probe.scrollHeight <= probe.clientHeight + 1) break;
      }
      probe.remove();
      setPick(i);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    void document.fonts?.ready.then(check);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const shown = forms[Math.min(pick, forms.length - 1)];
  return <span ref={ref} className="bot-row__preview" style={style} title={shown !== forms[0] ? forms[0] : undefined}>{shown}</span>;
}

/**
 * One bot in the list: a large head-and-shoulders picture (a group shows its whole picture), the name with the
 * time of its last message, and up to three lines of that message, the same scale as the Android home.
 * The primary bot comes first, on a tinted card with a star on its picture.
 */
/** The exact unread count (99+ above that), as on the Android home. */
function UnreadBadge({ n, className = '' }: { n: number; className?: string }) {
  if (!(n > 0)) return null;
  return <span className={`unread-badge ${className}`} aria-label={`${n} unread`}>{n > 99 ? '99+' : n}</span>;
}

/** A phone's full-width list: the ordinary rows, nothing fixed. */
const FULL_FIT: SidebarFit = { ...sidebarFit(10_000), rowHeight: null };

const BotRow = memo(function BotRow({ bot, selected, running, awaiting, primary, onSelect, fit = FULL_FIT, draft, muted, onMenu, now }: { bot: Bot; selected: boolean; running: boolean; awaiting: string | null; primary?: boolean; onSelect: (id: string) => void; fit?: SidebarFit; /** Words typed here and not sent. */ draft?: string; muted?: boolean; onMenu?: (id: string) => void; /** The minute, so "3m" keeps counting. */ now?: number }) {
  const narrowing = fit.rowHeight != null;
  const rowStyle: CSSProperties | undefined = narrowing ? { height: fit.rowHeight!, padding: fit.pad, overflow: 'hidden', gap: 12 } : undefined;
  return (
    <button type="button" className={`bot-row${primary ? ' is-primary' : ''}${selected ? ' is-selected' : ''}${bot.unread > 0 ? ' is-unread' : ''}`} style={rowStyle} onClick={() => onSelect(bot.id)} onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(bot.id); } : undefined} aria-current={selected || undefined} title={displayName(bot)} aria-label={fit.name > 0 ? undefined : displayName(bot)}>
      <span className="bot-row__avatar">
        <BotAvatarFor bot={bot} size={fit.avatar} head star={primary} className="bot-row__pic" badge />
        {(running || awaiting || bot.unread > 0) && (
          <span className={`status-dot ${awaiting ? 'is-attention' : running ? 'is-working' : 'is-unread'}`} aria-label={awaiting ? 'Needs attention' : running ? 'Working' : 'Unread activity'} />
        )}
        {/* Once the time has faded the unread count moves onto the picture's corner, as on the rail. */}
        {fit.meta < 1 && bot.unread > 0 && <span style={{ opacity: 1 - fit.meta }}><UnreadBadge n={bot.unread} className="unread-badge--rail" /></span>}
      </span>
      {fit.name > 0 && (
        <span className="bot-row__text" style={fit.textWidth ? { flex: 'none', width: fit.textWidth } : undefined}>
          <span className="bot-row__top">
            <span className="bot-row__name" style={narrowing ? { opacity: fit.name, flexShrink: fit.textWidth ? 0 : 1 } : undefined}>{displayName(bot)}</span>
            {bot.outside && <span className="outside-badge" style={narrowing ? { opacity: fit.meta } : undefined}>via Slack</span>}
            {bot.pinned && !primary && <span className="bot-row__flag" title="Pinned to the top" style={narrowing ? { opacity: fit.meta } : undefined}><Icon name="pin" size={12} opacity={0.56} /></span>}
            {muted && <span className="bot-row__flag" title="Notifications are muted" style={narrowing ? { opacity: fit.meta } : undefined}><Icon name="bell_off" size={12} opacity={0.56} /></span>}
            {bot.lastActivityAt > 0 && <span className="bot-row__time" style={narrowing ? { opacity: fit.meta } : undefined}>{relativeShort(bot.lastActivityAt, now)}</span>}
            {fit.meta > 0 && <span style={narrowing ? { opacity: fit.meta } : undefined}><UnreadBadge n={bot.unread} /></span>}
          </span>
          <PreviewLine forms={draft && !selected && !awaiting ? [`Draft: ${draft}`] : previewFor(bot, running, awaiting)} style={narrowing ? { opacity: fit.preview } : undefined} />
        </span>
      )}
    </button>
  );
});

/** Tween the drawn width toward the target (the full-screen button, ⌘B, a released drag), one width per frame. */
function useTween(target: number, dragging: number | null): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    if (dragging != null) return;
    const from = shownRef.current;
    if (Math.abs(from - target) < 1) { setShown(target); return; }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setShown(target); return; }
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 220);
      setShown(from + (target - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, dragging]);
  return dragging ?? shown;
}

export function Sidebar() {
  const allBots = useStore((s) => s.bots);
  // Bots hidden from this list (Bot.ownerHidden) stay out of it, its counts and its order.
  // "N hidden" under the list opens or shows them again. A scoped sign-in never has any.
  const bots = useMemo(() => allBots.filter((b) => !b.ownerHidden), [allBots]);
  const hiddenBots = useMemo(() => allBots.filter((b) => b.ownerHidden), [allBots]);
  const [hiddenMenu, setHiddenMenu] = useState(false);
  const live = useStore((s) => s.live);
  const storeSelectedBotId = useStore((s) => s.selectedBotId);
  const inTasks = useConfigUI((s) => s.view === 'tasks');
  const selectedBotId = inTasks ? null : storeSelectedBotId; // nothing highlighted while the Tasks view is open
  const user = useStore((s) => s.user);
  // A sign-in that sees only some bots (SCOPED_PEOPLE) gets no team-wide tools: no new bots, Connections or plugins.
  const scoped = !!user?.scope;
  const compact = useLayout() === 'compact';
  const railChosen = useStore((s) => s.sidebarCollapsed) && !compact; // a phone always shows the full list
  const chatFull = useStore((s) => s.chatFull) && !compact;
  const savedWidth = useStore((s) => s.sidebarWidth);
  const layout = useLayout();
  const [winW, setWinW] = useState(() => window.innerWidth);
  useEffect(() => { const r = () => setWinW(window.innerWidth); window.addEventListener('resize', r); return () => window.removeEventListener('resize', r); }, []);
  // Beside an open side panel (wide windows) the list can only grow into what the chat can spare.
  const side = useSidePanel();
  const sideW = side && layout === 'wide' ? Math.min(side.saved, sideMax(layout, winW, 0)) : 0;
  const max = sidebarMax(winW - sideW);
  // Medium windows start the list a little narrower, as before; a dragged width wins everywhere.
  const fullWidth = Math.min(savedWidth, max, layout === 'medium' && savedWidth === 350 ? 330 : Infinity);
  const target = chatFull ? 0 : railChosen ? RAIL : fullWidth;
  const [drag, setDrag] = useState<number | null>(null);
  const w = useTween(target, drag);
  const fit = compact ? FULL_FIT : sidebarFit(w);
  const collapsed = !compact && fit.rail;
  const set = useStore((s) => s.set);
  const storeSelectBot = useStore((s) => s.selectBot);
  // Picking a bot (even the one already selected) leaves the Tasks view.
  const selectBot = useCallback((id: string) => { useConfigUI.getState().setView('chat'); storeSelectBot(id); set({ pane: 'content' }); }, [storeSelectBot, set]);
  const setModal = useStore((s) => s.setModal);
  const [accountMenu, setAccountMenu] = useState(false);
  // The list's own state: which chats show, what is typed and unsent, what is muted, and a row's menu.
  const filter = usePrefs((s) => s.listFilter);
  const setFilter = usePrefs((s) => s.setListFilter);
  const drafts = useDrafts();
  const mutedMap = useStore((s) => s.muted);
  const keptUnread = useStore((s) => s.keptUnread);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const openRowMenu = useCallback((id: string) => setRowMenu(id), []);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 4000); return () => clearTimeout(t); }, [note]);
  const act = (p: Promise<unknown>, done?: string) => { p.then(() => { if (done) setNote(done); }, (e) => setNote((e as Error).message || 'That did not work. Try again.')); };
  // "3m" and "Yesterday" keep counting without waiting for a new message.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const isMuted = (id: string) => mutedMap[id] !== undefined && (mutedMap[id] === 0 || mutedMap[id] > now);
  // A failed sign-out says so (Settings, Account, with Try again) instead of reloading into a still signed-in app.
  const logout = async () => { if (await useStore.getState().signOut()) useConfigUI.getState().openAppSettings('account'); };

  const primary = bots.find((b) => b.isPrimary);
  // The primary bot is the first row of the list (emphasised), not a separate tile above it.
  const isUnread = (b: Bot) => b.unread > 0 || !!keptUnread[b.id] || !!b.sideChats?.unread;
  const needsYou = (b: Bot) => !!live[b.id]?.awaiting;
  const shows = (b: Bot) => filter === 'all' || (filter === 'unread' ? isUnread(b) : needsYou(b));
  const counts = { unread: bots.filter(isUnread).length, needs: bots.filter(needsYou).length };
  // Pinned chats come first, then the most recent.
  const byRecent = bots.filter((b) => !b.isPrimary && shows(b)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt - a.lastActivityAt);
  // While a side chat's name is being typed (SideChats.tsx), the rows stay put: a working bot moving up would
  // carry the field with it and the browser drops focus from a moved field, so the rename went nowhere.
  const listOrder = useRef<string[]>([]);
  const editingName = typeof document !== 'undefined' && !!document.activeElement?.closest('.side-chat__rename');
  if (!editingName) listOrder.current = byRecent.map((b) => b.id);
  const sorted = keepOrder(byRecent, listOrder.current);
  const others = sorted.filter((b) => !b.outside);
  const outsiders = sorted.filter((b) => b.outside);
  const rowMenuItems = (b: Bot) => {
    const st = useStore.getState();
    const muted = isMuted(b.id);
    return [
      ...(b.isPrimary ? [] : [{ label: b.pinned ? 'Unpin from the top' : 'Pin to the top', onSelect: () => act(st.setPinned(b.id, !b.pinned)) }]),
      isUnread(b) ? { label: 'Mark as read', onSelect: () => act(st.markReadNow(b.id)) } : { label: 'Mark as unread', onSelect: () => act(st.markUnread(b.id)) },
      ...(muted
        ? [{ label: 'Turn notifications back on', divider: true, onSelect: () => act(st.setMute(b.id, null), `Notifications are back on for ${b.name}.`) }]
        : [
          { label: 'Mute for 1 hour', divider: true, onSelect: () => act(st.setMute(b.id, Date.now() + 3_600_000), `Muted ${b.name} for 1 hour.`) },
          { label: 'Mute for 8 hours', onSelect: () => act(st.setMute(b.id, Date.now() + 8 * 3_600_000), `Muted ${b.name} for 8 hours.`) },
          { label: 'Mute until I turn it back on', onSelect: () => act(st.setMute(b.id, 0), `Muted ${b.name}.`) },
        ]),
      { label: 'New conversation', divider: true, onSelect: () => act(st.startFresh(b.id)) },
      ...(b.outside ? [] : [{ label: 'Earlier conversations', onSelect: () => st.openHistory(b.id) }]),
      { label: b.kind === 'room' ? 'Group settings' : 'Bot settings', onSelect: () => useConfigUI.getState().openBotSettings(b.id) },
      ...(b.isPrimary || scoped ? [] : [{ label: 'Hide from my list', divider: true, onSelect: () => act(st.setOwnerHidden(b.id, true), `${b.name} is hidden, with no notifications. Show again from “hidden” under the list.`) }]),
    ];
  };
  const row = (b: Bot) =>
    collapsed ? (
      <button key={b.id} type="button" className={`bot-rail-item${b.isPrimary ? ' is-primary' : ''}${selectedBotId === b.id ? ' is-selected' : ''}`} onClick={() => selectBot(b.id)} title={`${displayName(b)}${b.unread > 0 ? ` · ${b.unread} unread` : ''}${live[b.id]?.awaiting ? ' · waiting for you' : ''}`}>
        <BotAvatarFor bot={b} size={56} head star={b.isPrimary} className="bot-row__pic" badge />
        {(live[b.id]?.isRunning || live[b.id]?.awaiting) && (
          <span className={`status-dot ${live[b.id]?.awaiting ? 'is-attention' : 'is-working'}`} aria-label={live[b.id]?.awaiting ? 'Needs attention' : 'Working'} />
        )}
        <UnreadBadge n={b.unread} className="unread-badge--rail" />
      </button>
    ) : (
      <div key={b.id} className="bot-list__item">
        <BotRow bot={b} primary={b.isPrimary} selected={selectedBotId === b.id} running={!!live[b.id]?.isRunning || !!b.sideChats?.running} awaiting={live[b.id]?.awaiting?.reason ?? null} onSelect={selectBot} fit={fit}
          draft={drafts[b.id]?.text.trim().slice(0, 160) || undefined} muted={isMuted(b.id)} onMenu={openRowMenu} now={Math.floor(now / 60_000) * 60_000} />
        {fit.name >= 1 && (
          <button type="button" className={`bot-row__more${rowMenu === b.id ? ' is-open' : ''}`} onClick={() => setRowMenu(rowMenu === b.id ? null : b.id)} aria-label={`More for ${b.name}`} aria-haspopup="menu" aria-expanded={rowMenu === b.id} title="Pin, mute, mark unread…">
            <Icon name="more" size={16} opacity={0.66} />
          </button>
        )}
        {rowMenu === b.id && <Menu align="right" onClose={() => setRowMenu(null)} items={rowMenuItems(b)} />}
        {/* The selected bot's chats: Main chat and its side chats (SideChats.tsx), while the list is wide enough for words. */}
        {selectedBotId === b.id && fit.name >= 1 && <SideChatList bot={b} />}
      </div>
    );

  // Dragging the divider: narrower fades the words, then shrinks the pictures; let go and it settles on the
  // column of pictures or stays where it was let go. A drag stops at the pictures and never hides the list:
  // only the chat's Full screen button does that (and dragging the divider out of full screen brings it back).
  const settle = (v: number) => {
    const t = snapSidebar(v, max);
    if (t === RAIL) set({ chatFull: false, sidebarCollapsed: true });
    else set({ chatFull: false, sidebarCollapsed: false, sidebarWidth: t });
  };
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = w;
    let last = w0, moved = false, raf = 0;
    document.body.classList.add('is-resizing-sidebar');
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - x0) > 2) moved = true;
      last = Math.min(Math.max(w0 + ev.clientX - x0, RAIL), max);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; setDrag(last); });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      cancelAnimationFrame(raf);
      document.body.classList.remove('is-resizing-sidebar');
      if (moved) { setDrag(last); settle(last); }
      setDrag(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  // A double-click on the divider switches between the pictures and the full list.
  const onDouble = () => (w <= RAIL + 1 ? set({ sidebarCollapsed: false, chatFull: false }) : set({ sidebarCollapsed: true, chatFull: false }));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const v = w + (e.key === 'ArrowRight' ? 24 : -24);
    // Left stops at the pictures (it never hides the list); right from the pictures or full screen opens the list.
    if (v < RAIL) settle(RAIL);
    else if (w <= RAIL && e.key === 'ArrowRight') set({ sidebarCollapsed: false, chatFull: false });
    else settle(Math.max(v, 200));
  };

  return (
    <>
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}${compact ? '' : ' is-resizable'}`} style={compact ? undefined : ({ width: w, '--sb-name': fit.name } as CSSProperties)} aria-hidden={!compact && w === 0 ? true : undefined}>
      <div className="sidebar__titlebar" style={compact ? undefined : { paddingLeft: fit.headerLeft }}>
        <div className="sidebar__controls">
          <button type="button" className="icon-btn icon-btn--plain" onClick={() => set({ sidebarCollapsed: !collapsed, chatFull: false })} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={`Toggle sidebar (${keyHint('B')})`}>
            <Icon name="sidebar" opacity={0.66} />
          </button>
          <span className="sidebar__spacer" />
          {fit.tools > 0 && (
            <>
              <button type="button" className="icon-btn" style={{ opacity: fit.tools }} onClick={() => setModal('search')} aria-label="Search" title={`Search (${keyHint('K')})`}>
                <Icon name="search" opacity={0.66} />
              </button>
              {!scoped && <button type="button" className="icon-btn" style={{ opacity: fit.tools }} onClick={() => setModal('create')} aria-label="New Bot" title="New Bot">
                <Icon name="plus" opacity={0.66} />
              </button>}
            </>
          )}
        </div>
      </div>

      <div className="sidebar__scroll">
        <TasksIsland />
        {!scoped && <PluginsIsland />}
        {!collapsed && fit.name >= 1 && bots.length > 1 && (
          <div className="list-filter" role="tablist" aria-label="Which chats to show">
            {([['all', 'All', 0], ['unread', 'Unread', counts.unread], ['needs', 'Needs you', counts.needs]] as [ListFilter, string, number][]).map(([id, label, n]) => (
              <button key={id} type="button" role="tab" aria-selected={filter === id} className={`list-filter__chip${filter === id ? ' is-active' : ''}${id === 'needs' && n ? ' is-attention' : ''}`} onClick={() => setFilter(id)}>
                {label}{n > 0 && <span className="list-filter__n">{n}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="bot-list">
          {primary && shows(primary) && row(primary)}
          {others.map(row)}
          {!collapsed && filter !== 'all' && !(primary && shows(primary)) && sorted.length === 0 && (
            <div className="bot-list__none">
              <div>{filter === 'unread' ? 'Nothing unread. You are all caught up.' : 'No Bot is waiting for you.'}</div>
              <button type="button" className="link-btn" onClick={() => setFilter('all')}>Show all chats</button>
            </div>
          )}
          {!collapsed && !scoped && filter === 'all' && others.length === 0 && (
            <button type="button" className="bot-list__empty" onClick={() => setModal('create')}>
              <span className="bot-list__empty-plus"><Icon name="plus" size={14} opacity={0.66} /></span>
              <span>
                <span className="bot-row__name">Create a Bot</span>
                <span className="bot-row__preview">Give it a job, like research or inbox triage</span>
              </span>
            </button>
          )}
          {outsiders.length > 0 && (
            <>
              {!collapsed ? <div className="bot-list__section" style={{ opacity: fit.name }}>Outside the app</div> : <div className="bot-list__divider" />}
              {outsiders.map(row)}
            </>
          )}
          {!collapsed && fit.name >= 1 && hiddenBots.length > 0 && (
            <div className="bot-list__hidden">
              <button type="button" className="link-btn" onClick={() => setHiddenMenu(!hiddenMenu)} aria-haspopup="menu" aria-expanded={hiddenMenu}
                title="Bots you hid from this list. They still work and talk to the other Bots; you just do not see them or get their notifications.">
                {hiddenBots.length === 1 ? `${hiddenBots[0].name} is hidden` : `${hiddenBots.length} hidden`}
              </button>
              {hiddenMenu && (
                <Menu placement="above" onClose={() => setHiddenMenu(false)}
                  items={hiddenBots.flatMap((b, i) => [
                    { label: `Open ${b.name}`, divider: i > 0, onSelect: () => selectBot(b.id) },
                    { label: `Show ${b.name} in the list again`, onSelect: () => act(useStore.getState().setOwnerHidden(b.id, false), `${b.name} is back in the list, with notifications.`) },
                  ])} />
              )}
            </div>
          )}
        </div>
      </div>

      {note && !collapsed && <div className="sidebar__note" role="status">{note}</div>}
      <div className="sidebar__footer" style={compact ? undefined : { paddingRight: fit.footerRight }}>
        <div className="sidebar__fade" />
        {fit.account > 0 && (
          <div className="account" style={{ opacity: fit.account }}>
            <button type="button" className="account__btn" onClick={() => setAccountMenu(!accountMenu)} aria-haspopup="menu" aria-expanded={accountMenu} title={user?.displayName ?? user?.name}>
              <span className="account__initials">{initials(user?.displayName ?? user?.name ?? user?.email ?? '')}</span>
              <span className="account__name">{user?.displayName ?? user?.name ?? user?.email}</span>
            </button>
            {accountMenu && (
              <Menu
                placement="above"
                onClose={() => setAccountMenu(false)}
                items={[
                  { label: 'Settings', hint: keyHint(','), onSelect: () => useConfigUI.getState().openAppSettings() },
                  ...(scoped ? [] : [{ label: 'Connections', onSelect: () => useConfigUI.getState().openAppSettings('connections') }]),
                  { label: 'Keyboard shortcuts', hint: keyHint('/'), onSelect: () => setModal('shortcuts') },
                  { label: 'Sign in another device', onSelect: () => setModal('device') },
                  { label: 'Sign out', danger: true, divider: true, onSelect: logout },
                ]}
              >
                <div className="menu__header">{user?.displayName ?? user?.name ?? user?.email}</div>
              </Menu>
            )}
          </div>
        )}
        {!scoped && <button type="button" className="icon-btn icon-btn--bordered" onClick={() => useConfigUI.getState().openAppSettings('connections')} aria-label="Connections" title="Connections">
          <Icon name="apps" />
        </button>}
      </div>
    </aside>
    {!compact && (
      <div className={`sidebar__resizer${drag != null ? ' is-dragging' : ''}`} style={{ left: Math.max(0, w - 5) }}
        role="separator" aria-orientation="vertical" aria-label="Resize the bot list" aria-valuemin={RAIL} aria-valuemax={max} aria-valuenow={Math.round(w)} tabIndex={0}
        title="Drag to resize. Double-click for pictures only." onPointerDown={onDown} onDoubleClick={onDouble} onKeyDown={onKey}>
        <span className="sidebar__grip" />
      </div>
    )}
    </>
  );
}
