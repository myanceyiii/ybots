import { useEffect, useRef, useState } from 'react';
import type { Bot, SideChat } from '@shared/types';
import { chatIdFor, useStore } from '../store';
import { relativeShort } from '../lib/time';
import { Icon } from './Icon';

/**
 * Side chats (server/src/side-chats.ts): more conversations with the same bot, each with its own history,
 * running at the same time as the main chat. Shown in two places so they work at every width:
 *  - ChatSwitcher, a chip in the chat header: the open chat's name, and a list to switch, add, rename and delete;
 *  - SideChatList, under the selected bot in the bot list (as Muse does: "Main chat", then "Side chats +").
 */

const EMPTY: SideChat[] = [];

/** The side chats of a bot, and the one open (undefined for the main chat). */
export function useSideChats(botId: string | undefined) {
  const chats = useStore((s) => (botId ? s.sideChats[botId] : undefined)) ?? EMPTY;
  const openId = useStore((s) => (botId ? chatIdFor(s, botId) : undefined));
  const open = chats.find((c) => c.id === openId);
  return { chats, open };
}

export const canHaveSideChats = (bot: Bot) => bot.kind !== 'room' && !bot.outside;

function ChatStatus({ c }: { c: SideChat }) {
  if (c.live.awaiting) return <span className="side-chat__dot is-attention" aria-label="Waiting for you" />;
  if (c.live.isRunning) return <span className="side-chat__dot is-working" aria-label="Working" />;
  if (c.unread > 0) return <span className="unread-badge" aria-label={`${c.unread} unread`}>{c.unread > 99 ? '99+' : c.unread}</span>;
  return null;
}

/** Rename in place: Enter saves, Escape cancels. */
function RenameField({ chat, onDone }: { chat: SideChat; onDone: () => void }) {
  const [v, setV] = useState(chat.title);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.select(); }, []);
  const save = async () => {
    const t = v.trim();
    if (!t || t === chat.title) { onDone(); return; }
    try { await useStore.getState().renameSideChat(chat.id, t); onDone(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <span className="side-chat__rename">
      <input ref={ref} value={v} maxLength={60} aria-label="Chat name" onChange={(e) => setV(e.target.value)} onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onDone(); } }} />
      {err && <span className="side-chat__err">{err}</span>}
    </span>
  );
}

/**
 * The chats in the order they had when the list opened (Android) or a rename began (web), new ones first.
 * The server lists side chats most recent first, and a running chat jumps up on every step; moving a row
 * while its name is being edited took the field away from under the person's fingers.
 */
export function keepOrder<T extends { id: string }>(chats: T[], order: string[]): T[] {
  const at = new Map(order.map((id, i) => [id, i] as const));
  const fresh = chats.filter((c) => !at.has(c.id));
  const kept = chats.filter((c) => at.has(c.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  return [...fresh, ...kept];
}

/** The list itself: Main chat, then the side chats with their own Rename and Delete. */
function ChatList({ bot, onPicked, compact }: { bot: Bot; onPicked?: () => void; compact?: boolean }) {
  const { chats, open } = useSideChats(bot.id);
  const mainLive = useStore((s) => s.live[bot.id]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Rows keep their places while a name is being edited, even as a running chat moves up (see keepOrder).
  const order = useRef<string[]>([]);
  if (!renaming) order.current = chats.map((c) => c.id);
  const rows = keepOrder(chats, order.current);
  const st = useStore.getState;
  const pick = (id: string | null) => { st().openSideChat(bot.id, id); onPicked?.(); };
  const add = () => { setError(null); st().newSideChat(bot.id).then(() => onPicked?.()).catch((e) => setError((e as Error).message)); };
  return (
    <div className={`side-chats${compact ? ' is-compact' : ''}`}>
      <button type="button" className={`side-chat${!open ? ' is-selected' : ''}`} onClick={() => pick(null)} aria-current={!open || undefined}>
        <span className="side-chat__title">Main chat</span>
        {mainLive?.awaiting ? <span className="side-chat__dot is-attention" /> : mainLive?.isRunning ? <span className="side-chat__dot is-working" /> : null}
      </button>
      <div className="side-chats__head">
        <span>Side chats</span>
        <button type="button" className="icon-btn icon-btn--plain side-chats__add" onClick={add} aria-label={`New side chat with ${bot.name}`} title="New side chat">
          <Icon name="plus" size={14} opacity={0.66} />
        </button>
      </div>
      {chats.length === 0 && <div className="side-chats__empty">Start another conversation with {bot.name}. It runs alongside this one.</div>}
      {rows.map((c) => (
        <div key={c.id} className={`side-chat${open?.id === c.id ? ' is-selected' : ''}`}>
          {renaming === c.id ? (
            <RenameField chat={c} onDone={() => setRenaming(null)} />
          ) : (
            <button type="button" className="side-chat__open" onClick={() => pick(c.id)} onDoubleClick={() => setRenaming(c.id)} aria-current={open?.id === c.id || undefined} title={c.lastPreview ? `${c.title}\n${c.lastPreview}` : c.title}>
              <span className="side-chat__title">{c.title}</span>
              {!compact && <span className="side-chat__time">{relativeShort(c.lastActivityAt)}</span>}
              <ChatStatus c={c} />
            </button>
          )}
          {renaming !== c.id && (
            <span className="side-chat__actions">
              <button type="button" className="icon-btn icon-btn--plain" onClick={() => setRenaming(c.id)} aria-label={`Rename ${c.title}`} title="Rename">
                <Icon name="edit" size={13} opacity={0.6} />
              </button>
              <button type="button" className="icon-btn icon-btn--plain" onClick={() => st().deleteSideChat(c.id).catch((e) => setError((e as Error).message))} aria-label={`Delete ${c.title}`} title="Delete (Undo for a moment after)">
                <Icon name="trash" size={13} opacity={0.6} />
              </button>
            </span>
          )}
        </div>
      ))}
      {error && <div className="side-chat__err" role="alert">{error}</div>}
    </div>
  );
}

/** Under the selected bot in the bot list. */
export function SideChatList({ bot }: { bot: Bot }) {
  if (!canHaveSideChats(bot)) return null;
  return <ChatList bot={bot} compact />;
}

/** The chip in the chat header: which chat is open, and the list to switch. */
export function ChatSwitcher({ bot }: { bot: Bot }) {
  const { chats, open } = useSideChats(bot.id);
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!shown) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setShown(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setShown(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [shown]);
  if (!canHaveSideChats(bot)) return null;
  const busyElsewhere = chats.filter((c) => c.id !== open?.id && (c.live.isRunning || c.live.awaiting)).length;
  const unreadElsewhere = chats.filter((c) => c.id !== open?.id).reduce((n, c) => n + c.unread, 0);
  return (
    <span className="chat-switcher" ref={ref}>
      <button type="button" className={`chat-switcher__btn${shown ? ' is-active' : ''}`} onClick={() => setShown(!shown)} aria-haspopup="menu" aria-expanded={shown} title="Main chat and side chats">
        <Icon name="chat" size={15} opacity={0.66} />
        <span className="chat-switcher__label">{open ? open.title : 'Main chat'}</span>
        {(unreadElsewhere > 0 || busyElsewhere > 0) && <span className={`side-chat__dot ${unreadElsewhere > 0 ? 'is-unread' : 'is-working'}`} aria-label="Activity in another chat" />}
        <Icon name="chev_down" size={12} opacity={0.5} />
      </button>
      {shown && (
        <div className="menu is-below is-left chat-switcher__menu" role="menu">
          <ChatList bot={bot} onPicked={() => setShown(false)} />
        </div>
      )}
    </span>
  );
}

/** "Deleted <chat>. Undo" for a few seconds after a side chat is deleted. */
export function SideUndoToast() {
  const undo = useStore((s) => s.sideUndo);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!undo) return;
    setError(null);
    const t = setTimeout(() => { if (useStore.getState().sideUndo === undo) useStore.getState().set({ sideUndo: null }); }, Math.max(0, undo.until - Date.now()));
    return () => clearTimeout(t);
  }, [undo]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);
  if (!undo && !error) return null;
  return (
    <div className="undo-toast undo-toast--above-composer" role="status" aria-live="polite">
      <span>{error ?? `Deleted the side chat "${undo!.title}".`}</span>
      {!error && <button type="button" className="undo-toast__btn" onClick={() => { useStore.getState().undoDeleteSideChat().catch((e) => setError((e as Error).message)); }}>Undo</button>}
    </div>
  );
}
