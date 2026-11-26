import { ConfirmButton } from '../config/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MessageBody, Row } from '@shared/types';
import { splitReply } from '@shared/message-text';
import { api, type ConversationInfo } from '../../lib/api';
import { clock, dividerLabel, shortDate } from '../../lib/time';
import { useStore } from '../../store';
import { downloadText } from '../ChatView';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';
import { Modal } from './Modal';

/**
 * Earlier conversations with a Bot (or in a group or side chat). "New conversation" never deletes
 * anything: every conversation stays here to read, save as a file, or carry on with.
 */
export function HistoryModal() {
  const target = useStore((s) => s.history);
  const bots = useStore((s) => s.bots);
  const sideChats = useStore((s) => s.sideChats);
  const close = () => useStore.getState().set({ modal: null, history: null });
  const chatId = target?.botId ?? '';
  const owner = bots.find((b) => b.id === chatId) ?? bots.find((b) => (sideChats[b.id] ?? []).some((c) => c.id === chatId));
  const sideTitle = owner && owner.id !== chatId ? sideChats[owner.id]?.find((c) => c.id === chatId)?.title : null;
  const [list, setList] = useState<ConversationInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(target?.generation ?? null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const lit = useRef<number | null>(target?.seq ?? null);

  useEffect(() => {
    if (!chatId) return;
    api.conversations(chatId).then((r) => {
      setList(r.conversations);
      setOpen((cur) => cur ?? (r.conversations.find((c) => !c.current) ?? r.conversations[0])?.generation ?? null);
    }).catch((e) => setError((e as Error).message));
  }, [chatId]);

  useEffect(() => {
    if (open === null || !chatId) return;
    let stale = false;
    setRows(null); setNote(null);
    (async () => {
      // Read back to the message search pointed at, or the newest 200.
      let got = (await api.conversationRows(chatId, open)).rows;
      for (let i = 0; i < 40 && lit.current !== null && got.length && got[0].seq > lit.current && got[0].seq > 1; i++) {
        const more = (await api.conversationRows(chatId, open, got[0].seq)).rows;
        if (!more.length) break;
        got = [...more, ...got];
      }
      if (!stale) setRows(got);
    })().catch((e) => { if (!stale) setError((e as Error).message); });
    return () => { stale = true; };
  }, [open, chatId]);

  // Open on the newest message, or on the one search pointed at.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !rows) return;
    const hit = lit.current !== null ? el.querySelector(`[data-seq="${lit.current}"]`) : null;
    if (hit) { hit.scrollIntoView({ block: 'center' }); hit.classList.add('is-lit'); lit.current = null; }
    else if (!busy) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows === null, open]);

  if (!target) return null;
  const info = list?.find((c) => c.generation === open);
  const first = rows?.[0]?.seq ?? 1;
  const loadEarlier = async () => {
    if (open === null || !rows) return;
    setBusy(true);
    const el = scroller.current;
    const from = el ? el.scrollHeight - el.scrollTop : 0;
    try {
      const more = (await api.conversationRows(chatId, open, first)).rows;
      setRows([...more, ...rows]);
      requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - from; });
    } catch (e) { setNote((e as Error).message); }
    setBusy(false);
  };
  const carryOn = async () => {
    if (open === null) return;
    setBusy(true);
    try {
      await api.openConversation(chatId, open);
      useStore.getState().openChat(chatId);
      close();
    } catch (e) { setNote((e as Error).message || 'Could not open that conversation.'); setBusy(false); }
  };
  const remove = async () => {
    if (open === null) return;
    try {
      const r = await api.deleteConversation(chatId, open);
      setList(r.conversations);
      setRows(null);
      setOpen((r.conversations.find((c) => !c.current) ?? r.conversations[0])?.generation ?? null);
      setNote('Deleted.');
    } catch (e) { setNote((e as Error).message || 'Could not delete the conversation.'); }
  };
  const save = async () => {
    try { const r = await api.exportChat(chatId, open ?? undefined); downloadText(r.name, r.markdown); setNote('Saved as a file.'); }
    catch (e) { setNote((e as Error).message || 'Could not save the conversation.'); }
  };
  const name = owner ? (sideTitle ? `${owner.name} · ${sideTitle}` : owner.name) : 'this chat';

  return (
    <Modal onClose={close} className="history-modal" label={`Earlier conversations with ${name}`}>
      <div className="history">
        <aside className="history__list" aria-label="Conversations">
          <div className="history__head">
            <div className="history__title">Conversations</div>
            <div className="history__sub">{name}</div>
          </div>
          <div className="history__scroll">
            {!list && !error && <div className="history__empty">Loading…</div>}
            {list && list.length === 0 && <div className="history__empty">Nothing has been said here yet.</div>}
            {list?.map((c) => (
              <button key={c.generation} type="button" className={`history-row${c.generation === open ? ' is-active' : ''}`} onClick={() => { lit.current = null; setOpen(c.generation); }} aria-current={c.generation === open || undefined}>
                <span className="history-row__title">{c.title || 'Untitled conversation'}</span>
                <span className="history-row__meta">{c.current ? 'Open now · ' : ''}{shortDate(c.lastAt)} · {c.messages} {c.messages === 1 ? 'message' : 'messages'}</span>
              </button>
            ))}
          </div>
        </aside>
        <section className="history__view">
          <div className="history__bar">
            <div className="history__bar-text">
              <div className="history__title">{info?.title || (open === null ? 'Earlier conversations' : 'Conversation')}</div>
              {info && <div className="history__sub">{dividerLabel(info.startedAt)}{info.current ? ' · this is the conversation open now' : ''}</div>}
            </div>
            {info && (
              <>
                <button type="button" className="btn btn--ghost" onClick={save} title="Save this conversation as a Markdown file"><Icon name="download" size={14} opacity={0.8} /> Save</button>
                {!info.current && <ConfirmButton confirmLabel="Delete for good" className="btn btn--ghost" title="Delete this earlier conversation for good" onConfirm={remove}>Delete</ConfirmButton>}
                {!info.current && owner?.kind !== 'room' && <button type="button" className="btn btn--primary" disabled={busy} onClick={carryOn} title="Make this the open conversation again. The one open now stays in this list.">Continue this conversation</button>}
              </>
            )}
            <button type="button" className="icon-btn icon-btn--plain" onClick={close} aria-label="Close"><Icon name="close" opacity={0.66} /></button>
          </div>
          {(note || error) && <div className="history__note" role="status">{error ?? note}</div>}
          <div className="history__rows" ref={scroller}>
            {open !== null && !rows && !error && <div className="history__empty">Loading…</div>}
            {open === null && list && <div className="history__empty">Pick a conversation on the left.</div>}
            {rows && first > 1 && <div className="earlier"><button type="button" className="link-btn" disabled={busy} onClick={loadEarlier}>{busy ? 'Loading…' : 'Show earlier messages'}</button></div>}
            {rows && <ReadOnlyRows rows={rows} botName={owner?.name ?? 'Bot'} />}
          </div>
        </section>
      </div>
    </Modal>
  );
}

/** A conversation to read: the words, who said them and when. Steps and cards are left out. */
function ReadOnlyRows({ rows, botName }: { rows: Row[]; botName: string }) {
  let prev = 0;
  return (
    <div className="history__col">
      {rows.map((r) => {
        const b = r.body;
        if (b.type === 'event') return <div key={r.seq} className="system-event">{b.text}</div>;
        if (b.type !== 'message' || (!b.text && !b.attachments?.length)) return null;
        const m = b as MessageBody;
        const mine = m.role === 'user' && (!m.from || m.from.kind === 'voice');
        const gap = r.createdAt - prev > 60 * 60 * 1000;
        prev = r.createdAt;
        const who = mine ? 'You' : m.from?.name ?? botName;
        return (
          <div key={r.seq} className="history-msg-wrap">
            {gap && <div className="divider">{dividerLabel(r.createdAt)}</div>}
            <div className={`history-msg is-${mine ? 'mine' : 'theirs'}`} data-seq={r.seq}>
              <div className="history-msg__who">{who} · {clock(r.createdAt)}{m.editedTo ? ' · edited later' : ''}</div>
              {!!m.attachments?.length && <div className="history-msg__files">{m.attachments.map((f) => <span key={f.path} className="attach-file"><Icon name={f.kind === 'image' ? 'image' : 'file'} size={14} opacity={0.8} /><span className="attach-file__name">{f.name}</span></span>)}</div>}
              {mine ? <div className="bubble__plain">{splitReply(m.text).body}</div> : <Markdown text={m.text} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
