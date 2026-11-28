import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { api, type SearchHit } from '../../lib/api';
import { shortDate } from '../../lib/time';
import { displayName, useStore } from '../../store';
import { Icon } from '../Icon';
import { Modal } from './Modal';

/** The snippet with the words that were searched for in bold. */
function Marked({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>))}</>;
}

/**
 * Search: chats by name, and every message of every conversation (the open ones and earlier ones).
 * A message opens its chat at that message; one from an earlier conversation opens that conversation to read.
 */
export function SearchModal() {
  const bots = useStore((s) => s.bots);
  const setModal = useStore((s) => s.setModal);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setModal(null), [setModal]);
  const needle = q.trim();

  const chats = useMemo(() => {
    const ordered = [...bots].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || b.lastActivityAt - a.lastActivityAt);
    const n = needle.toLowerCase();
    if (!n) return ordered;
    // The same fields as the Android search: name, label, description and the latest message.
    return ordered.filter((b) => `${b.name} ${b.label} ${b.description} ${b.lastPreview ?? ''}`.toLowerCase().includes(n));
  }, [bots, needle]);

  // Messages: asked a moment after typing stops; an answer for words that have since changed is dropped.
  useEffect(() => {
    if (needle.length < 2) { setHits([]); setState('idle'); return; }
    let stale = false;
    setState('busy');
    const t = setTimeout(() => {
      api.search(needle).then(
        (r) => { if (!stale) { setHits(r.hits); setState('done'); } },
        (e) => { if (!stale) { setHits([]); setError((e as Error).message); setState('error'); } },
      );
    }, 220);
    return () => { stale = true; clearTimeout(t); };
  }, [needle]);

  const total = chats.length + hits.length;
  useEffect(() => setActive(0), [needle]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const openChat = (id: string) => { useStore.getState().openChat(id); close(); };
  const openHit = (h: SearchHit) => {
    if (h.current) { close(); useStore.getState().focusMessage(h.chatId, h.seq); }
    else useStore.getState().openHistory(h.chatId, h.generation, h.seq);
  };
  const pick = (i: number) => { if (i < chats.length) { if (chats[i]) openChat(chats[i].id); } else if (hits[i - chats.length]) openHit(hits[i - chats.length]); };
  const words = needle.split(/\s+/).filter(Boolean);

  return (
    <Modal onClose={close} className="search-modal" label="Search">
      <div className="search-modal__field">
        <span className="search-modal__icon"><Icon name="search" size={18} opacity={0.56} /></span>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search chats and every message"
          aria-label="Search"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.max(0, Math.min(a + 1, total - 1))); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
          }}
        />
        {q && <button type="button" className="search-modal__clear" onClick={() => setQ('')} aria-label="Clear the search" title="Clear"><Icon name="close" size={14} opacity={0.66} /></button>}
      </div>
      <div className="search-modal__results" ref={listRef} role="listbox">
        {chats.length > 0 && <div className="search-modal__section">Chats</div>}
        {chats.map((b, i) => (
          <button key={b.id} type="button" role="option" aria-selected={i === active} data-idx={i} className={`search-row${i === active ? ' is-active' : ''}`} onMouseMove={() => setActive(i)} onClick={() => openChat(b.id)}>
            <BotAvatarFor bot={b} size={44} still head />
            <span className="search-row__text">
              <span className="search-row__name">{displayName(b)}</span>
              <span className="search-row__sub">{b.lastPreview ?? (b.description || 'No messages yet')}</span>
            </span>
          </button>
        ))}
        {needle.length >= 2 && <div className="search-modal__section">Messages{state === 'done' && hits.length ? ` · ${hits.length}${hits.length >= 60 ? '+' : ''}` : ''}</div>}
        {hits.map((h, j) => {
          const i = chats.length + j;
          const bot = bots.find((b) => b.id === h.botId);
          return (
            <button key={`${h.chatId}:${h.generation}:${h.seq}`} type="button" role="option" aria-selected={i === active} data-idx={i} className={`search-row is-message${i === active ? ' is-active' : ''}`} onMouseMove={() => setActive(i)} onClick={() => openHit(h)}>
              {bot ? <BotAvatarFor bot={bot} size={36} still head /> : <span className="search-row__blank" />}
              <span className="search-row__text">
                <span className="search-row__name">
                  {h.who === 'you' ? 'You' : h.from ?? bot?.name ?? 'Bot'}
                  <span className="search-row__where">{h.who === 'you' ? `to ${bot?.name ?? 'a Bot'}` : h.from && bot && h.from !== bot.name ? `in ${bot.name}` : ''}{h.sideTitle ? ` · ${h.sideTitle}` : ''}</span>
                  {!h.current && <span className="search-row__tag">Earlier conversation</span>}
                  <span className="search-row__date">{shortDate(h.createdAt)}</span>
                </span>
                <span className="search-row__sub"><Marked text={h.snippet} words={words} /></span>
              </span>
            </button>
          );
        })}
        {state === 'busy' && hits.length === 0 && <div className="search-modal__empty">Searching messages…</div>}
        {state === 'error' && <div className="search-modal__empty">Message search did not work: {error}</div>}
        {needle.length === 1 && <div className="search-modal__empty">Type one more letter to search messages too.</div>}
        {!needle && <div className="search-modal__hint">Type to search every message in every conversation, including earlier ones. ↑ ↓ to move, Enter to open.</div>}
        {needle.length >= 2 && state === 'done' && total === 0 && <div className="search-modal__empty">Nothing matches “{q}”. Try fewer or different words.</div>}
      </div>
    </Modal>
  );
}
