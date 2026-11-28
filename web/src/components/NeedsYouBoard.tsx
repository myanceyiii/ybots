import { useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import type { NeedsItem } from '@shared/needs-you-types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { displayName, useStore } from '../store';
import { useConfigUI } from '../configStore';
import { useNeedsYou } from '../lib/needsYou';
import { lsGet, lsSet } from '../lib/storage';
import { relativeShort } from '../lib/time';
import { Glyph } from './config/glyphs';
import { ChevronDown, ChevronUp } from 'lucide-react';

/** Rows shown before "Show all". */
const FIRST = 3;
const LS_OPEN = 'needsYouOpen';

/** Where a row goes: the chat at its card, the bot's chat for a task it waits on, or Tasks for one it left behind. */
export function openNeedsItem(it: NeedsItem) {
  const st = useStore.getState();
  if (it.kind === 'stalled') { useConfigUI.getState().setView('tasks'); st.set({ pane: 'content' }); return; }
  st.openChat(it.botId);
  // The card's own chat: the bot's main chat, or the side chat it is in.
  st.openSideChat(it.botId, it.chatId !== it.botId ? it.chatId : null);
  if (it.seq) st.set({ focus: { chatId: it.chatId, seq: it.seq, at: Date.now() } });
  st.set({ pane: 'content' });
}

/**
 * The Needs you board at the top of the bot list (web and Windows): one row for each card, question, form or
 * task waiting on the person, across every bot and group, newest first. A row opens the chat at that card;
 * answering it there goes through the card's own path, so nothing here can approve anything.
 */
export function NeedsYouBoard({ bots, collapsed }: { bots: Bot[]; collapsed: boolean }) {
  const items = useNeedsYou((s) => s.items);
  const [open, setOpen] = useState(() => lsGet(LS_OPEN) !== '0');
  const [all, setAll] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const byId = new Map(bots.map((b) => [b.id, b]));
  const shown = items.filter((it) => byId.has(it.botId));
  if (!shown.length) return null;
  const toggle = () => { setOpen(!open); lsSet(LS_OPEN, open ? '0' : '1'); };

  if (collapsed) {
    return (
      <button type="button" className="sidebar-island needs-island" onClick={() => useStore.getState().set({ sidebarCollapsed: false })} title={`${shown.length} waiting on you`}>
        <span className="sidebar-island__icon"><Glyph name="needs" size={18} /></span>
        <span className="needs-island__dot" aria-label={`${shown.length} waiting on you`}>{shown.length}</span>
      </button>
    );
  }
  const list = all ? shown : shown.slice(0, FIRST);
  return (
    <section className="needs-board" aria-label="Needs you">
      <button type="button" className="needs-board__head" onClick={toggle} aria-expanded={open}>
        <Glyph name="needs" size={16} />
        <span className="needs-board__title">Needs you</span>
        <span className="needs-board__count">{shown.length}</span>
        {open ? <ChevronUp size={14} aria-hidden style={{ opacity: 0.5 }} /> : <ChevronDown size={14} aria-hidden style={{ opacity: 0.5 }} />}
      </button>
      {open && (
        <ul className="needs-board__list">
          {list.map((it) => {
            const bot = byId.get(it.botId)!;
            return (
              <li key={it.id}>
                <button type="button" className={`needs-row is-${it.kind}`} onClick={() => openNeedsItem(it)} title={it.detail || it.title}>
                  <BotAvatarFor bot={bot} size={32} head still className="needs-row__pic" />
                  <span className="needs-row__text">
                    <span className="needs-row__top">
                      <span className="needs-row__tag">{it.label}</span>
                      <span className="needs-row__who">{displayName(bot)}{it.sideTitle ? ` · ${it.sideTitle}` : ''}</span>
                      <span className="needs-row__when">{relativeShort(it.at, now)}</span>
                    </span>
                    <span className="needs-row__title">{it.title}</span>
                  </span>
                </button>
              </li>
            );
          })}
          {shown.length > FIRST && (
            <li><button type="button" className="link-btn needs-board__more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${shown.length}`}</button></li>
          )}
        </ul>
      )}
    </section>
  );
}
