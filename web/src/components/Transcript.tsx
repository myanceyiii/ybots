import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { safeLink } from '@shared/safe-url';
import { plainStep, useSimple } from '../lib/simple';
import type { Bot, ChatFile, LiveState, MessageBody, Row, ToolCallBody } from '@shared/types';
import { HANDOFF_HINT, handoffLabel } from '@shared/handoff-label';
import { BotAvatar, BotAvatarFor } from '../avatar/BotAvatar';
import { isWaitingForYou } from '../lib/phrases';
import { clock, dividerLabel, duration, fullDate } from '../lib/time';
import { chatToken, isCurrentChat, useStore } from '../store';
import { GroupWorking, ThinkingBlock } from './ActivityLine';
import { CardRow } from './cards/Cards';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { mentionParts, plainText, replyExcerpt, splitReply } from '@shared/message-text';
import { useEdit, useReply } from '../lib/reply';
import { listen, stopListening, useListening } from '../voice/listen';
import { MORE_REACTIONS, QUICK_REACTIONS, reactionChips } from '@shared/reactions';
import { api, fileUrl } from '../lib/api';
import { discardPending, retryPending, sizeText, useOutbox, type Pending } from '../lib/outbox';
import { updateDraft } from '../lib/drafts';
import { useConfigUI } from '../configStore';
import { whoVars } from '../lib/colors';
import { chatColorForUnseen } from '@shared/chat-colors';

type Item =
  | { kind: 'divider'; key: string; ts: number }
  | { kind: 'group'; key: string; side: 'left' | 'right'; from?: MessageBody['from']; rows: Row[] }
  | { kind: 'steps'; key: string; rows: Row[]; /** Row timestamps just before and just after the run of steps. */ startTs: number | null; endTs: number | null }
  | { kind: 'row'; key: string; row: Row };

const DIVIDER_GAP = 60 * 60 * 1000;

/**
 * Answered choice buttons (server/src/choices.ts) leave the chat: the tap already put the answer in the chat
 * as your message, so a second "✓ answer" chip above it only repeated it. Same rule on Android
 * (mobile/src/screens/Chat.tsx answeredChoice).
 */
const answeredChoice = (r: Row) => {
  const b: any = r.body;
  return b.type === 'card' && b.card === 'view' && !!b.quick && b.blocks?.[0]?.type === 'choice' && !!b.blocks[0].sentAt;
};
const GROUP_GAP = 5 * 60 * 1000;

/** Turns rows into render items: date dividers, grouped bubbles, collapsed tool-call steps, cards, events. */
function buildItems(rows: Row[]): Item[] {
  const items: Item[] = [];
  let prevTs = 0;
  for (const row of rows) {
    if (answeredChoice(row)) continue;
    if (!prevTs || row.createdAt - prevTs > DIVIDER_GAP) items.push({ kind: 'divider', key: `d${row.seq}`, ts: row.createdAt });
    const before = prevTs;
    prevTs = row.createdAt;
    const last = items[items.length - 1];
    const b = row.body;
    if (b.type === 'tool-call') {
      if (last?.kind === 'steps') last.rows.push(row);
      else items.push({ kind: 'steps', key: `s${row.seq}`, rows: [row], startTs: before || null, endTs: null });
      continue;
    }
    if (last?.kind === 'steps' && last.endTs === null) last.endTs = row.createdAt;
    if (b.type === 'message') {
      if (!b.text && !b.streaming && !b.attachments?.length) continue;
      const side = b.role === 'user' && (!b.from || b.from.kind === 'voice') ? 'right' : 'left';
      const sender = b.from ? `${b.from.kind}:${b.from.id}` : b.role;
      const lastRow = last?.kind === 'group' ? last.rows[last.rows.length - 1] : null;
      const lastBody = lastRow?.body as MessageBody | undefined;
      const lastSender = lastBody ? (lastBody.from ? `${lastBody.from.kind}:${lastBody.from.id}` : lastBody.role) : null;
      if (last?.kind === 'group' && lastSender === sender && row.createdAt - lastRow!.createdAt < GROUP_GAP) last.rows.push(row);
      else items.push({ kind: 'group', key: `g${row.seq}`, side, from: b.from, rows: [row] });
      continue;
    }
    items.push({ kind: 'row', key: `r${row.seq}`, row });
  }
  return items;
}

function cornerClass(i: number, n: number) {
  if (n < 2) return '';
  if (i === 0) return ' is-first';
  if (i === n - 1) return ' is-last';
  return ' is-mid';
}

async function writeClipboard(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  // Older or locked-down browsers: a hidden textarea and the copy command.
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** React to a message (a toggle). Errors are shown under the message; the new reactions arrive with the row update. */
async function react(chatId: string, seq: number, emoji: string): Promise<string | null> {
  try { await api.react(chatId, seq, emoji); return null; } catch (e) { return (e as Error).message || 'Could not react'; }
}

/** The emoji picker: a quick row, and "more" for the rest. Closes on Escape, a click outside, or a pick. */
function ReactPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const [more, setMore] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  const btn = (e: string) => <button key={e} type="button" className="react-picker__emoji" onClick={() => onPick(e)} aria-label={`React ${e}`}>{e}</button>;
  return (
    <div ref={ref} className="react-picker" role="dialog" aria-label="Pick a reaction">
      <div className="react-picker__row">
        {QUICK_REACTIONS.map(btn)}
        <button type="button" className="react-picker__more" onClick={() => setMore((m) => !m)} aria-expanded={more} aria-label="More reactions" title="More"><Icon name={more ? 'chev_down' : 'plus'} size={16} /></button>
      </div>
      {more && <div className="react-picker__grid">{MORE_REACTIONS.map(btn)}</div>}
    </div>
  );
}

/** Reactions under a message. On a Bot's message a tap on a chip adds or removes your reaction. */
function ReactionChips({ row, chatId, side, onError }: { row: Row; chatId: string; side: 'left' | 'right'; onError?: (msg: string) => void }) {
  const chips = reactionChips((row.body as MessageBody).reactions);
  if (!chips.length) return null;
  const tappable = side === 'left';
  return (
    <div className={`reactions is-${side}`}>
      {chips.map((c) => (
        <button key={c.emoji} type="button" className={`reaction${c.mine ? ' is-mine' : ''}`} disabled={!tappable} title={c.names}
          aria-label={`${c.emoji} ${c.count}, from ${c.names}${tappable ? (c.mine ? '. Tap to remove yours' : '. Tap to add yours') : ''}`}
          onClick={async () => { const err = await react(chatId, row.seq, c.emoji); if (err) onError?.(err); }}>
          <span className="reaction__emoji">{c.emoji}</span>{c.count > 1 && <span className="reaction__count">{c.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** React, Copy, Share and Reply under a Bot's message. Share uses the system share sheet where there is one, else copies. */
function MessageActions({ text, chatId, seq, writer, group, voiceBot }: { text: string; chatId: string; seq: number; writer: string; group: boolean; /** Whose voice reads it aloud (Listen). */ voiceBot: string }) {
  const [picking, setPicking] = useState(false);
  const listenKey = `${chatId}:${seq}`;
  const listening = useListening(listenKey);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const say = (t: string) => { setNote(t); clearTimeout(timer.current); timer.current = setTimeout(() => setNote(null), 1800); };
  const copy = async () => say((await writeClipboard(plainText(text))) ? 'Copied' : 'Could not copy');
  const share = async () => {
    const plain = plainText(text);
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (typeof nav.share === 'function' && (!nav.canShare || nav.canShare({ text: plain }))) {
      try { await nav.share({ text: plain }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
    }
    say((await writeClipboard(plain)) ? 'Copied to share' : 'Could not share');
  };
  const reply = () => {
    useEdit.getState().set(chatId, undefined);
    useReply.getState().set(chatId, { name: writer, excerpt: replyExcerpt(text), mention: group });
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer__input')?.focus());
  };
  const pick = async (emoji: string) => {
    setPicking(false);
    const err = await react(chatId, seq, emoji);
    if (err) say(err);
  };
  return (
    <span className="msg-actions">
      <span className="msg-actions__react">
        <button type="button" className="msg-action" onClick={() => setPicking((p) => !p)} aria-label="React" title="React" aria-expanded={picking}><Icon name="react" size={14} /></button>
        {picking && <ReactPicker onPick={pick} onClose={() => setPicking(false)} />}
      </span>
      <button type="button" className="msg-action" onClick={copy} aria-label="Copy" title="Copy"><Icon name={note === 'Copied' ? 'check' : 'copy'} size={14} /></button>
      <button type="button" className="msg-action" onClick={share} aria-label="Share" title="Share"><Icon name="share" size={14} /></button>
      <button type="button" className="msg-action" onClick={reply} aria-label="Reply" title="Reply"><Icon name="reply" size={14} /></button>
      <button type="button" className={`msg-action${listening ? ' is-on' : ''}`} onClick={() => listen(voiceBot, listenKey, text, say)} aria-label={listening ? 'Stop reading' : 'Listen'} title={listening === 'loading' ? 'Getting the voice ready…' : listening ? 'Stop reading' : 'Listen: read this aloud'} aria-pressed={!!listening} aria-busy={listening === 'loading'}><Icon name={listening ? 'stop' : 'speaker'} size={listening ? 11 : 14} /></button>
      {note && <span className="msg-actions__note" role="status">{note}</span>}
    </span>
  );
}

/** Copy and Edit under a message you sent. Edit puts your words back in the box; Send posts the new version. */
function OwnMessageActions({ text, chatId, seq, editable }: { text: string; chatId: string; seq: number; editable: boolean }) {
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const say = (t: string) => { setNote(t); clearTimeout(timer.current); timer.current = setTimeout(() => setNote(null), 1800); };
  // What you typed, without a reply's quote.
  const copy = async () => say((await writeClipboard(splitReply(text).body)) ? 'Copied' : 'Could not copy');
  const edit = () => useEdit.getState().set(chatId, { seq, text });
  return (
    <span className="msg-actions is-right">
      {note && <span className="msg-actions__note" role="status">{note}</span>}
      <button type="button" className="msg-action" onClick={copy} aria-label="Copy" title="Copy"><Icon name={note === 'Copied' ? 'check' : 'copy'} size={14} /></button>
      {editable && <button type="button" className="msg-action" onClick={edit} aria-label="Edit" title="Edit and send again"><Icon name="edit" size={14} /></button>}
    </span>
  );
}

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;
/** Plain text with its web addresses made into links. */
function Linked({ text }: { text: string }) {
  if (!/https?:\/\//.test(text)) return <>{text}</>;
  return <>{text.split(URL_RE).map((part, i) => (i % 2 ? <a key={i} href={part} target="_blank" rel="noreferrer noopener">{part}</a> : <Fragment key={i}>{part}</Fragment>))}</>;
}

/** Your own text: links open, and each @Bot you named is bold (the Bots it went to, in a group or a bot's own chat). */
function WithMentions({ text }: { text: string; room?: boolean }) {
  const names = useStore((s) => s.bots.filter((b) => b.kind !== 'room').map((b) => b.name).join('\n'));
  if (!names || !text.includes('@')) return <Linked text={text} />;
  return <>{mentionParts(text, names.split('\n')).map((p, i) => (p.mention ? <strong key={i} className="bubble__mention">{p.text}</strong> : <Linked key={i} text={p.text} />))}</>;
}

/** Pictures and files sent with a message. A picture opens large; a file downloads. */
function Attachments({ files, ownerId }: { files: ChatFile[]; ownerId: string }) {
  const pics = files.filter((f) => f.kind === 'image');
  const rest = files.filter((f) => f.kind !== 'image');
  return (
    <div className="attachments">
      {pics.length > 0 && (
        <div className={`attachments__pics${pics.length > 1 ? ' is-many' : ''}`}>
          {pics.map((f) => (
            <button key={f.path} type="button" className="attach-pic" title={f.name} aria-label={`Open ${f.name}`}
              onClick={() => useStore.getState().set({ lightbox: { src: fileUrl(ownerId, f.path), name: f.name, download: fileUrl(ownerId, f.path, false) } })}>
              <img src={fileUrl(ownerId, f.path)} alt={f.name} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {rest.map((f) => (
        <a key={f.path} className="attach-file" href={fileUrl(ownerId, f.path, false)} download={f.name} title={`Download ${f.name}`}>
          <Icon name="file" size={16} opacity={0.8} />
          <span className="attach-file__name">{f.name}</span>
          <span className="attach-file__size">{sizeText(f.size)}</span>
        </a>
      ))}
    </div>
  );
}

/** A message on its way (lib/outbox.ts): shown at once, with what is happening to it underneath. */
function PendingBubble({ p }: { p: Pending }) {
  const reply = splitReply(p.text);
  const edit = () => {
    const back = discardPending(p.clientId);
    if (!back) return;
    updateDraft(p.chatId, (d) => ({ ...d, text: d.text ? `${splitReply(back.text).body}\n${d.text}` : splitReply(back.text).body }));
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer__input')?.focus());
  };
  return (
    <div className="group is-right is-pending">
      <div className="bubble-wrap is-right">
        <div className={`bubble is-user is-pending is-${p.state}`}>
          {p.attachments.length > 0 && <div className="attachments">{p.attachments.map((f) => <span key={f.path} className="attach-file"><Icon name={f.kind === 'image' ? 'image' : 'file'} size={16} opacity={0.8} /><span className="attach-file__name">{f.name}</span></span>)}</div>}
          {reply.quote && <div className="bubble__quote">{reply.quote}</div>}
          {reply.body && <div className="bubble__plain">{reply.body}</div>}
        </div>
      </div>
      <div className={`pending-note is-${p.state}`} role="status">
        {p.state === 'sending' && 'Sending…'}
        {p.state === 'waiting' && <><Icon name="offline" size={12} opacity={0.8} /> No connection. This sends by itself when it is back.</>}
        {p.state === 'failed' && <>Not sent. {p.error}</>}
        {p.state !== 'sending' && (
          <>
            <button type="button" className="link-btn" onClick={() => retryPending(p.clientId)}>Try again</button>
            <button type="button" className="link-btn" onClick={edit}>Edit</button>
          </>
        )}
      </div>
    </div>
  );
}

/** The marker under a message sent while the bot was working (server/src/steer-mode.ts). */
const STEER_LABEL: Record<NonNullable<MessageBody['steer']>, string> = {
  pending: 'Steering · joins the reply at the next step',
  read: 'Steering · taken into the reply',
  next: 'Steering · the reply had finished, so it was answered next',
};

const Bubble = memo(function Bubble({ row, side, pos, chatId, ownerId, chatName, room, lit }: { row: Row; side: 'left' | 'right'; pos: string; chatId: string; ownerId: string; chatName: string; room: boolean; lit: boolean }) {
  const b = row.body as MessageBody;
  const reply = side === 'right' ? splitReply(b.text) : null;
  const actions = side === 'left' && !b.streaming && !!b.text?.trim();
  // Your own typed messages (not a voice call's) can be copied, and edited unless already edited.
  const own = side === 'right' && b.role === 'user' && !b.from && !!b.text?.trim();
  const editingThis = useEdit((s) => s.of[chatId]?.seq === row.seq);
  return (
    <>
    <div className={`bubble-wrap is-${side}${b.editedTo ? ' is-edited' : ''}${editingThis ? ' is-editing' : ''}${lit ? ' is-lit' : ''}`} data-seq={row.seq}>
      <div className={`bubble is-${side === 'right' ? 'user' : 'agent'}${pos}${b.streaming ? ' is-streaming' : ''}`}>
        {!!b.attachments?.length && <Attachments files={b.attachments} ownerId={ownerId} />}
        {side === 'right'
          ? <>{reply?.quote && <div className="bubble__quote">{reply.quote}</div>}{(reply?.body ?? b.text) && <div className="bubble__plain"><WithMentions text={reply?.body ?? b.text} room={room} /></div>}</>
          : (b.text || !b.attachments?.length) && <Markdown text={b.text || ' '} />}
        {b.citations && b.citations.length > 0 && (
          <div className="bubble__cites">
            {b.citations.filter((c) => /^https?:\/\//i.test(c.url)).slice(0, 6).map((c, i) => {
              let host = c.url;
              try { host = new URL(c.url).hostname.replace(/^www\./, ''); } catch { /* keep */ }
              return <a key={i} className="cite-chip" href={c.url} target="_blank" rel="noreferrer noopener" title={c.title ?? c.url}>{host}</a>;
            })}
          </div>
        )}
      </div>
      <span className="bubble__time" title={fullDate(row.createdAt)}>{clock(row.createdAt)}</span>
    </div>
    {(b.editedTo || b.editOf) && <div className={`bubble__edited is-${side}`}>{b.editedTo ? 'Edited · new version below' : 'Edited'}</div>}
    {handoffLabel(b.handoff) && <div className={`bubble__edited bubble__handoff is-${side}`} title={HANDOFF_HINT}>{handoffLabel(b.handoff)}</div>}
    {b.steer && <div className={`bubble__edited bubble__steer is-${side} is-${b.steer}`} title="Sent while the bot was working. It is never an approval.">{STEER_LABEL[b.steer]}</div>}
    <ReactionChips row={row} chatId={chatId} side={side} />
    {own && <OwnMessageActions text={b.text} chatId={chatId} seq={row.seq} editable={!b.editedTo} />}
    {actions && <MessageActions text={b.text} chatId={chatId} seq={row.seq} writer={b.from?.name ?? chatName} group={room && b.from?.kind === 'bot'} voiceBot={b.from?.kind === 'bot' ? b.from.id : ownerId} />}
    </>
  );
});

function SenderLabel({ from, sender, chatId, chatName, room }: { from: NonNullable<MessageBody['from']>; sender: Bot | undefined; chatId: string; chatName: string; room: boolean }) {
  // Who it wrote to: named on the message (an outside member's record), else this chat (never itself).
  const to = from.to?.name ?? (room || from.id === chatId ? null : chatName);
  // Another bot: its face, its name in its chat colour, and (in a bot's own chat) who it wrote to.
  // A bot this sign-in can't see (a scoped one) shows its initial instead of its face.
  if (from.kind === 'bot') {
    return (
      <div className="sender-label is-bot">
        {sender ? <BotAvatarFor bot={sender} size={28} still head className="sender-label__pic" /> : <span className="sender-label__pic sender-label__initial" aria-hidden>{from.name.slice(0, 1).toUpperCase()}</span>}
        <span className="sender-label__name">{from.name}</span>
        {to && <span className="sender-label__to">to {to}</span>}
        {from.via === 'slack' && (safeLink(from.link)
          ? <a className="sender-label__via" href={safeLink(from.link)!} target="_blank" rel="noreferrer">· via Slack ↗</a>
          : <span className="sender-label__via">· via Slack</span>)}
      </div>
    );
  }
  return (
    <div className="sender-label">
      {from.kind === 'routine' ? <Icon name="clock" size={12} opacity={0.56} /> : from.kind === 'voice' ? <Icon name="voice_a" size={12} opacity={0.56} /> : from.kind === 'agent' ? <Icon name="keys" size={12} opacity={0.56} /> : <BotAvatar shape="blob" color="gray" size={16} />}
      {/* A program signed in to the account (a Claude thread, a test) is never shown as the person. */}
      {/* A routine's words name the routine; the name opens the bot's routines, where it can be changed. */}
      {from.kind === 'routine' ? (
        <button type="button" className="sender-label__routine" onClick={() => useConfigUI.getState().openBotSettings(chatId, 'routines')} title="Open this bot's routines">Routine · {from.name}</button>
      ) : <span>{from.kind === 'voice' ? 'Asked on a voice call' : from.kind === 'agent' ? `Sent by ${from.name} · not you` : `From ${from.name}`}</span>}
      {from.via === 'slack' && (safeLink(from.link)
        ? <a className="sender-label__via" href={safeLink(from.link)!} target="_blank" rel="noreferrer">· via Slack ↗</a>
        : <span className="sender-label__via">· via Slack</span>)}
    </div>
  );
}

const MAX_WORK_MS = 12 * 60 * 60 * 1000;

/** How long a finished run of steps took, from the row before it to the row after it. */
function workedMs(item: Extract<Item, { kind: 'steps' }>): number | null {
  const end = item.endTs ?? item.rows[item.rows.length - 1].createdAt;
  if (!item.startTs) return null;
  const ms = end - item.startTs;
  return ms >= 1000 && ms < MAX_WORK_MS ? ms : null;
}

function argsText(args: unknown): string | null {
  if (args === undefined || args === null) return null;
  if (typeof args === 'string') return args.trim() ? args.slice(0, 2000) : null;
  if (typeof args === 'object' && Object.keys(args as object).length === 0) return null;
  try {
    const text = JSON.stringify(args, null, 2);
    return text.length > 2000 ? `${text.slice(0, 2000)}\n…` : text;
  } catch { return null; }
}

const STEP_NOTE: Partial<Record<ToolCallBody['status'], string>> = {
  error: 'Failed', denied: 'Not allowed', 'awaiting-approval': 'Waiting for your OK',
};

function StepRow({ call }: { call: ToolCallBody }) {
  const [open, setOpen] = useState(false);
  // Sam's view (lib/simple.ts): each step in plain words, without the command or its raw arguments.
  const simple = useSimple();
  const args = simple ? null : argsText(call.args);
  const note = STEP_NOTE[call.status];
  const body = (
    <>
      <span className="step__mark" aria-hidden>{call.status === 'running' ? <span className="step__spin" /> : <span className="step__dot" />}</span>
      <span className="step__label">{simple ? plainStep(call.label, call.name) : call.label || call.name}</span>
      {call.summary && !simple && <span className="step__summary">{call.summary}</span>}
      {note && <span className="step__note">{note}</span>}
    </>
  );
  return (
    <li className={`step is-${call.status}`}>
      {args ? (
        <button type="button" className="step__row is-clickable" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Hide details' : 'Show details'}>{body}</button>
      ) : <div className="step__row">{body}</div>}
      {open && args && <pre className="step__args">{args}</pre>}
      {call.screenshot && !simple && <img className="step__shot" src={call.screenshot} alt="" />}
    </li>
  );
}

/**
 * A run of tool calls, folded into one chip. While the turn runs it shows what the bot is doing right
 * now and the step count; afterwards it reads "Worked for 2m 10s · 7 steps". Click to see every step.
 *
 * The list opens upward: it sits above the chip, oldest at the top and newest right next to the chip, so
 * the newest steps are what you see first and the chip (the collapse control) never moves out of reach.
 * Opening or closing keeps the chip where it was on screen, and a long list scrolls inside a capped box
 * that stays pinned to its newest step while steps stream in (unless you scrolled up inside it).
 */
function Steps({ item, active, open: unfinished, extra }: {
  item: Extract<Item, { kind: 'steps' }>;
  /** The bot is working on this run of steps right now. */
  active: boolean;
  /** The turn this run belongs to has not ended (it may be paused, waiting for the person). */
  open: boolean;
  /** Steps the server has counted that have no row yet. */
  extra: number;
}) {
  const [open, setOpen] = useState(false);
  const simple = useSimple();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** Where the chip sat on screen just before it was clicked, so opening upward does not push it away. */
  const anchor = useRef<number | null>(null);
  /** The inner list follows the newest step unless the person scrolled up inside it. */
  const listStick = useRef(true);
  const toggle = () => {
    anchor.current = toggleRef.current?.getBoundingClientRect().top ?? null;
    listStick.current = true;
    setOpen((o) => !o);
  };
  useLayoutEffect(() => {
    const list = listRef.current;
    if (open && list && listStick.current) list.scrollTop = list.scrollHeight;
    const before = anchor.current;
    anchor.current = null;
    const btn = toggleRef.current;
    const pane = btn?.closest('.transcript') as HTMLElement | null;
    if (before === null || !btn || !pane) return;
    const delta = btn.getBoundingClientRect().top - before;
    if (Math.abs(delta) > 0.5) pane.scrollTop += delta;
  });
  const onListScroll = () => {
    const el = listRef.current;
    if (el) listStick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  const calls = item.rows.map((r) => r.body as ToolCallBody);
  const n = calls.length + (unfinished ? extra : 0);
  const count = `${n} ${n === 1 ? 'step' : 'steps'}`;
  const current = [...calls].reverse().find((c) => c.status === 'running') ?? calls[calls.length - 1];
  const worked = unfinished ? null : workedMs(item);
  const flag = calls.some((c) => c.status === 'awaiting-approval') ? 'waiting' : calls.some((c) => c.status === 'error' || c.status === 'denied') ? 'problem' : null;
  return (
    <div className={`steps${open ? ' is-open' : ''}${active ? ' is-active' : ''}`}>
      {open && <ul className="steps__list" ref={listRef} onScroll={onListScroll} id={`${item.key}-list`}>{calls.map((c) => <StepRow key={c.callId} call={c} />)}</ul>}
      <button type="button" className="steps__toggle" ref={toggleRef} onClick={toggle} aria-expanded={open} aria-controls={open ? `${item.key}-list` : undefined} title={open ? 'Hide steps' : 'Show steps'}>
        {active ? (
          <>
            <span className="step__spin" aria-hidden />
            <span className="steps__now" key={current.callId}>{simple ? plainStep(current.label, current.name) : current.label || current.name}</span>
            <span className="steps__sep" aria-hidden>·</span>
          </>
        ) : (
          <>
            {flag && <span className={`steps__flag is-${flag}`} title={flag === 'waiting' ? 'A step is waiting for your OK' : 'A step did not finish'} />}
            {worked !== null && <><span className="steps__worked">Worked for {duration(worked)}</span><span className="steps__sep" aria-hidden>·</span></>}
          </>
        )}
        <span className="steps__count">{count}</span>
        <Icon name="chev_right" size={10} opacity={0.66} className="steps__chev" />
      </button>
    </div>
  );
}

function SystemRow({ row }: { row: Row }) {
  const b = row.body;
  if (b.type === 'event') return <div className="system-event">{b.text}</div>;
  if (b.type === 'notice') return <div className={`notice is-${b.tone ?? 'info'}`}>{b.text}</div>;
  // A view card marks its own place; every other card gets one here, so a Needs you row (NeedsYouBoard.tsx)
  // or a search can bring it to the middle and light it up.
  if (b.type === 'card') return b.card === 'view' ? <CardRow row={row} /> : <div className="card-anchor" data-seq={row.seq}><CardRow row={row} /></div>;
  return null;
}

interface Props { bot: Bot; rows: Row[]; live: LiveState | undefined; loaded: boolean; /** The conversation the rows belong to. */ generation?: number; /** The bot whose Library holds this chat's files (a side chat's bot). */ ownerId?: string }

const NO_PENDING: Pending[] = [];
/** A bot's (or a card's) row: what "new" and "unread" count. */
const isIncoming = (r: Row) => !answeredChoice(r) && (r.body.type === 'message' ? (r.body.role === 'assistant' || (!!r.body.from && r.body.from.kind !== 'voice')) && !r.body.streaming : r.body.type === 'card');

export function Transcript({ bot, rows, live, loaded, generation, ownerId = bot.id }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const items = useMemo(() => buildItems(rows), [rows]);
  const allBots = useStore((s) => s.bots);

  const running = !!live?.isRunning;
  const waiting = isWaitingForYou(live);
  const last = rows[rows.length - 1];
  const streamingNow = last?.body.type === 'message' && last.body.role === 'assistant' && !!last.body.streaming;
  const showActivity = (running && !streamingNow) || waiting;

  // The chip that is still growing: the last thing in the transcript while the turn runs.
  const lastItem = items[items.length - 1];
  const openKey = (running || waiting) && lastItem?.kind === 'steps' ? lastItem.key : null;
  const activeKey = running && !waiting ? openKey : null;
  // `live.steps` counts the whole turn; anything beyond the rows we hold for this turn has no row yet.
  const turnSteps = useMemo(() => {
    let n = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const b = rows[i].body;
      if (b.type === 'message' && b.role === 'user') break;
      if (b.type === 'tool-call') n++;
    }
    return n;
  }, [rows]);
  const serverSteps = running ? live?.steps ?? 0 : 0;
  const extraSteps = Math.max(0, serverSteps - turnSteps);

  // Keep pinned to the bottom while new content arrives, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  // Jump to bottom when switching bots.
  useLayoutEffect(() => {
    stick.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bot.id]);

  // When the box gets shorter (a phone keyboard opening, the message box growing), or what is in it grows after it
  // was drawn (pictures and answer views loading, fonts arriving), keep the latest message in view. Someone who has
  // scrolled up to read is left where they are (stick is false then).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    const col = el.firstElementChild;
    if (col) ro.observe(col);
    return () => ro.disconnect();
  }, []);

  // The chat opens with its newest rows; a conversation's rows count from 1, so anything before the first
  // one held is still on the server. Loading more keeps the message being read where it is on screen.
  const firstSeq = rows[0]?.seq ?? 1;
  const [earlier, setEarlier] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const keepFrom = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && keepFrom.current !== null) { el.scrollTop = el.scrollHeight - keepFrom.current; keepFrom.current = null; }
  }, [firstSeq]);
  const loadEarlier = async () => {
    const el = scrollRef.current;
    setEarlier({ busy: true, error: null });
    try {
      const token = chatToken(bot.id);
      const r = await api.rowsBefore(bot.id, firstSeq);
      if (!isCurrentChat(bot.id, token)) { setEarlier({ busy: false, error: null }); return; } // the chat was cleared or restored meanwhile
      stick.current = false;
      if (el) keepFrom.current = el.scrollHeight - el.scrollTop;
      useStore.getState().upsertRows(bot.id, r.generation, r.rows);
      setEarlier({ busy: false, error: null });
    } catch (e) {
      setEarlier({ busy: false, error: (e as Error).message || 'Could not load earlier messages.' });
    }
  };

  // Messages on their way from this device. One whose own row has arrived (the live update beat the answer) is hidden.
  const outbox = useOutbox((s) => s.items);
  const pending = useMemo(() => {
    const mine = outbox.filter((p) => p.chatId === bot.id);
    if (!mine.length) return NO_PENDING;
    // A failed one always stays (with Retry and Edit); one with no words (pictures only) is never matched by its words.
    return mine.filter((p) => p.state === 'failed' || !p.text || !rows.some((r) => r.seq > p.afterSeq && r.body.type === 'message' && r.body.role === 'user' && !r.body.from && r.body.text === p.text));
  }, [outbox, rows, bot.id]);
  // Your own message always scrolls into view.
  const pendingCount = pending.length;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pendingCount) { stick.current = true; el.scrollTop = el.scrollHeight; }
  }, [pendingCount]);

  // "New" line: the chat was opened with unread messages; the line sits above the first of them.
  const unreadAtOpen = useRef(bot.unread);
  const [newLine, setNewFrom] = useState<{ generation: number | undefined; seq: number } | null>(null);
  // A new conversation counts its rows from 1 again, so the line belongs to the conversation it was placed in.
  const newFrom = newLine && newLine.generation === generation ? newLine.seq : null;
  const placedNew = useRef(false);
  useLayoutEffect(() => {
    if (!loaded || placedNew.current) return;
    placedNew.current = true;
    let left = unreadAtOpen.current;
    if (!(left > 0)) return;
    let at: number | null = null;
    for (let i = rows.length - 1; i >= 0 && left > 0; i--) if (isIncoming(rows[i])) { at = rows[i].seq; left--; }
    // A line above the very last message says nothing; show it when there is something to read back to.
    if (at === null) return;
    setNewFrom({ generation, seq: at });
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      const line = el?.querySelector<HTMLElement>('.new-divider');
      if (!el || !line) return;
      if (line.offsetTop < el.scrollTop) { el.scrollTop = Math.max(0, line.offsetTop - 16); stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // While scrolled up, the jump button counts what has arrived below.
  const lastSeq = last?.seq ?? 0;
  const [seenSeq, setSeenSeq] = useState(0);
  useEffect(() => { if (stick.current) setSeenSeq(lastSeq); }, [lastSeq]);
  const newBelow = showJump ? rows.reduce((n, r) => n + (r.seq > seenSeq && isIncoming(r) ? 1 : 0), 0) : 0;

  // A message picked in search: load back to it if needed, bring it to the middle and light it up for a moment.
  const focus = useStore((s) => (s.focus && s.focus.chatId === bot.id ? s.focus : null));
  const [lit, setLit] = useState<number | null>(null);
  // Leaving the chat stops a reply being read aloud.
  useEffect(() => () => stopListening(), [bot.id]);
  useEffect(() => {
    if (!focus || !loaded) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 40; i++) {
        const seqs = Object.keys(useStore.getState().transcripts[bot.id]?.bySeq ?? {}).map(Number);
        const first = seqs.length ? Math.min(...seqs) : 1;
        if (focus.seq >= first || first <= 1) break;
        const token = chatToken(bot.id);
        const r = await api.rowsBefore(bot.id, first);
        if (cancelled || !isCurrentChat(bot.id, token) || !r.rows.length) break;
        stick.current = false;
        useStore.getState().upsertRows(bot.id, r.generation, r.rows);
      }
      if (cancelled) return;
      stick.current = false;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (cancelled) return;
        const el = scrollRef.current?.querySelector(`[data-seq="${focus.seq}"]`);
        if (el) {
          el.scrollIntoView({ block: 'center' }); setLit(focus.seq); setTimeout(() => setLit(null), 2600);
          // A card (a pinned board's Jump to message) lights up the same way a message does.
          if (el.classList.contains('view-card') || el.classList.contains('card-anchor')) { el.classList.add('is-lit'); setTimeout(() => el.classList.remove('is-lit'), 2600); }
        }
        if (useStore.getState().focus === focus) useStore.getState().set({ focus: null });
      }));
    })().catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.at, loaded]);

  const earlierBusy = useRef(false);
  earlierBusy.current = earlier.busy;
  const onScroll = () => {
    const el = scrollRef.current!;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = dist < 40;
    if (stick.current) setSeenSeq(lastSeq);
    setShowJump(dist > 200);
    // Near the top: earlier messages load by themselves (the link stays for keyboards and failures).
    if (el.scrollTop < 160 && loaded && firstSeq > 1 && !earlierBusy.current && !earlier.error) { earlierBusy.current = true; void loadEarlier(); }
  };

  const jump = () => {
    const el = scrollRef.current!;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div className="transcript-wrap">
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      <div className="transcript__col">
        {!loaded && <div className="transcript__loading" role="status">Loading messages…</div>}
        {loaded && rows.length === 0 && pending.length === 0 && <EmptyChat bot={bot} />}
        {loaded && firstSeq > 1 && (
          <div className="earlier">
            <button type="button" className="link-btn" disabled={earlier.busy} onClick={loadEarlier}>{earlier.busy ? 'Loading…' : 'Show earlier messages'}</button>
            {earlier.error && <div className="earlier__error" role="alert">{earlier.error}</div>}
          </div>
        )}
        {items.map((it) => {
          switch (it.kind) {
            case 'divider':
              return <div key={it.key} className="divider">{dividerLabel(it.ts)}</div>;
            case 'steps':
              return <Steps key={it.key} item={it} active={it.key === activeKey} open={it.key === openKey} extra={extraSteps} />;
            case 'row':
              return <Fragment key={it.key}>{it.row.seq === newFrom && <div className="new-divider" role="separator"><span>New</span></div>}<SystemRow row={it.row} /></Fragment>;
            case 'group': {
              // Another bot's words wear its chat colour (chat-colors.ts), so they never read as this bot's own.
              const sender = it.from?.kind === 'bot' ? allBots.find((b) => b.id === it.from!.id) : undefined;
              const color = it.from?.kind === 'bot' ? sender?.chatColor ?? chatColorForUnseen(it.from.id) : null;
              return (
                <div key={it.key} className={`group is-${it.side}${color ? ' is-from-bot' : ''}`} style={color ? whoVars(color) : undefined}>
                  {it.from && <SenderLabel from={it.from} sender={sender} chatId={bot.id} chatName={bot.name} room={bot.kind === 'room'} />}
                  {it.rows.map((r, i) => (
                    <Fragment key={r.seq}>
                      {r.seq === newFrom && <div className="new-divider" role="separator"><span>New</span></div>}
                      <Bubble row={r} side={it.side} pos={cornerClass(i, it.rows.length)} chatId={bot.id} ownerId={ownerId} chatName={bot.name} room={bot.kind === 'room'} lit={lit === r.seq} />
                    </Fragment>
                  ))}
                </div>
              );
            }
          }
        })}
        {pending.map((p) => <PendingBubble key={p.clientId} p={p} />)}
        {bot.kind === 'room'
          ? running && live && <GroupWorking bot={bot} live={live} bots={allBots} onStop={(id) => api.interrupt(bot.id, id)} />
          : showActivity && live && <ThinkingBlock bot={bot} live={live} rows={rows} steps={openKey ? 0 : serverSteps} />}
      </div>
    </div>
      {showJump && (
        <button type="button" className={`jump-btn${newBelow ? ' has-new' : ''}`} onClick={jump} aria-label={newBelow ? `${newBelow} new below. Scroll to the newest` : 'Scroll to the newest'} title="Scroll to the newest">
          {newBelow > 0 && <span className="jump-btn__count">{newBelow > 99 ? '99+' : newBelow} new</span>}
          <Icon name="arrow_down" size={16} />
        </button>
      )}
    </div>
  );
}

const STARTERS = ['What can you help me with?', 'What should I know today?', 'Help me plan my week'];

function EmptyChat({ bot }: { bot: Bot }) {
  // A scoped sign-in's view offers none here.
  const simple = useSimple();
  const start = (text: string) => {
    updateDraft(bot.id, (d) => ({ ...d, text }));
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer__input')?.focus());
  };
  return (
    <div className="empty-chat">
      <BotAvatarFor bot={bot} size={72} />
      <div className="empty-chat__title">{bot.name}</div>
      <div className="empty-chat__sub">{bot.description || (bot.kind === 'room' ? 'A group chat. Everyone in it sees what you write; type @ to ask one Bot.' : bot.mode === 'teammate' ? 'A Bot for the whole team. Hand it a task and it will see it through.' : 'Your personal assistant. Hand it a task and it will see it through.')}</div>
      {bot.kind !== 'room' && !bot.outside && !simple && (
        <div className="empty-chat__starters">
          {STARTERS.map((t) => <button key={t} type="button" className="starter-chip" onClick={() => start(t)}>{t}</button>)}
        </div>
      )}
    </div>
  );
}
