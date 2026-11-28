import { useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { COMPOSE_EVENT, LISTEN_EVENT, takeListen, type ComposeDetail } from '../lib/compose';
import { useConfigUI } from '../configStore';
import type { Bot } from '@shared/types';
import { api, type RoomMember } from '../lib/api';
import { displayName, useStore } from '../store';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { endCall, isCallActive, startCall, useVoice } from '../voice/call';
import { useDictation } from '../voice/dictation';
import { useProblem } from '../lib/problem';
import { composeEdit, composeReply, editChanged, editDraft, insertMention, mentionMatches, mentionParts, mentionQuery } from '@shared/message-text';
import { useEdit, useReply } from '../lib/reply';
import { emptyDraft, updateDraft, useDrafts } from '../lib/drafts';
import { attachFiles, enqueue, removeAttaching, sizeText, takeAttached, useAttach, type Attaching } from '../lib/outbox';
import { usePrefs } from '../lib/prefs';
import { keyHint } from '../lib/keys';
import type { MessageBody } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';

/**
 * Who @ can name, for the picker and the mention highlight. In a group: its members, fetched again each time
 * the picker opens. In a bot's own chat (or side chat): the other bots on the team, and the server passes the
 * message on to each one named (server/src/direct-mentions.ts). An outside bot's chat has no picker.
 */
function useRoomMembers(bot: Bot): [RoomMember[], () => void] {
  const [members, setMembers] = useState<RoomMember[]>([]);
  const team = useStore((s) => s.bots);
  const load = () => { if (bot.kind === 'room') api.roomMembers(bot.id).then((r) => setMembers(r.members)).catch(() => {}); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [bot.id, bot.kind]);
  const others = useMemo(() => (bot.kind === 'room' || bot.outside ? [] : teamMentions(bot, team)), [bot, team]);
  return [bot.kind === 'room' ? members : others, load];
}

/** The other bots on the team that a bot's own chat can @mention: never itself or a group. */
function teamMentions(bot: Bot, team: Bot[]): RoomMember[] {
  return team
    .filter((b) => b.kind !== 'room' && b.id !== bot.id && b.name.toLowerCase() !== bot.name.toLowerCase())
    .map((b) => ({ id: b.id, name: b.name, label: b.label ?? '', avatarShape: b.avatarShape, avatarColor: b.avatarColor }));
}

/** The message box's text drawn behind the (transparent-backed) textarea, with each @mention tinted. */
function MentionBackdrop({ text, names, scrollTop }: { text: string; names: string[]; scrollTop: number }) {
  if (!names.length || !text.includes('@')) return null;
  return (
    <div className="composer__backdrop" aria-hidden>
      <div style={{ transform: `translateY(${-scrollTop}px)` }}>
        {mentionParts(text, names).map((p, i) => (p.mention ? <mark key={i} className="mention-hl">{p.text}</mark> : <span key={i}>{p.text}</span>))}
        {'\u200b'}
      </div>
    </div>
  );
}

/**
 * A live wave beside the mic while dictating: bars that move with your voice, newest on the right.
 * Drawn straight to the DOM each frame so the composer does not re-render 60 times a second.
 */
const WAVE_BARS = 18;
function MicWave({ level, busy }: { level: () => number; busy: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bars = Array.from(box.current?.children ?? []) as HTMLElement[];
    const hist = new Array<number>(WAVE_BARS).fill(0);
    let raf = 0, last = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 70) return;
      last = now;
      hist.shift();
      hist.push(busy ? 0 : Math.min(1, Math.sqrt(level()) * 1.6));
      for (let i = 0; i < bars.length; i++) bars[i].style.transform = `scaleY(${Math.max(0.12, hist[i])})`;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [level, busy]);
  return (
    <div ref={box} className={`mic-wave${busy ? ' is-busy' : ''}`} role="status" aria-label={busy ? 'Finishing the words' : 'Listening'}>
      {Array.from({ length: WAVE_BARS }, (_, i) => <span key={i} />)}
    </div>
  );
}

function elapsed(since: number, now: number) {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** "Waiting for Sheldon · 0:24" while a message to an outside member has no answer yet. */
function WaitingChips({ waiting }: { waiting: NonNullable<Bot['waitingFor']> }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return (
    <div className="waiting-chips" role="status">
      {waiting.map((w) => (
        <span key={w.id} className="waiting-chip"><span className="waiting-chip__dot" />Waiting for {w.name} · {elapsed(w.since, now)}</span>
      ))}
    </div>
  );
}

const MAX_H = 200;
const MAX_TEXT = 200_000;
const NO_FILES: Attaching[] = [];

/** The pictures and files that will go with the next message: a thumbnail or a name each, with Remove. */
function AttachTray({ chatId, list }: { chatId: string; list: Attaching[] }) {
  if (!list.length) return null;
  return (
    <div className="attach-tray" role="list" aria-label="Attached to your next message">
      {list.map((a) => (
        <div key={a.id} role="listitem" className={`attach-chip is-${a.state}${a.preview ? ' has-preview' : ''}`} title={a.error ?? `${a.name} · ${sizeText(a.size)}`}>
          {a.preview ? <img src={a.preview} alt="" /> : <span className="attach-chip__icon"><Icon name="file" size={16} opacity={0.66} /></span>}
          <span className="attach-chip__text">
            <span className="attach-chip__name">{a.name}</span>
            <span className="attach-chip__sub">{a.state === 'uploading' ? 'Uploading…' : a.state === 'failed' ? a.error ?? 'Could not be uploaded' : sizeText(a.size)}</span>
          </span>
          <button type="button" className="attach-chip__x" onClick={() => removeAttaching(chatId, a.id)} aria-label={`Remove ${a.name}`} title="Remove"><Icon name="close" size={12} /></button>
        </div>
      ))}
    </div>
  );
}

export function Composer({ bot, running }: { bot: Bot; running: boolean }) {
  const { text, sending } = useDrafts((drafts) => drafts[bot.id] ?? emptyDraft);
  const setText = (value: SetStateAction<string>) => updateDraft(bot.id, (draft) => ({
    ...draft, text: typeof value === 'function' ? value(draft.text) : value,
  }));
  // What just failed (dictation, sending, stopping...), with Try again; clears once the server answers again.
  const issue = useProblem(api.me);
  const startDictation = useRef<() => void>(() => {});
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Pictures and files for the next message (lib/outbox.ts), in a bot's chat or a group (each answering
  // member gets a copy). A Bot outside the app (Sheldon, over Slack) takes words only.
  const canAttach = !bot.outside;
  const tray = useAttach((s) => s[bot.id] ?? NO_FILES);
  const fileInput = useRef<HTMLInputElement>(null);
  const enterSends = usePrefs((s) => s.enterSends);
  const addFiles = (files: File[]) => {
    if (!files.length) return;
    const note = attachFiles(bot.id, files);
    if (note) issue.show({ area: 'Attachment', text: note });
    ref.current?.focus();
  };
  // Words put in from elsewhere (lib/compose.ts): they fill the box, never send.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<ComposeDetail>).detail;
      if (!d || d.botId !== bot.id) return;
      setText(d.text);
      requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(d.text.length, d.text.length); } });
    };
    window.addEventListener(COMPOSE_EVENT, on);
    return () => window.removeEventListener(COMPOSE_EVENT, on);
  }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const replyTo = useReply((s) => s.to[bot.id]);
  const clearReply = () => useReply.getState().set(bot.id, undefined);
  // Editing one of your sent messages: Send posts the new words and marks the old message Edited.
  const editing = useEdit((s) => s.of[bot.id]);
  const keptDraft = useRef<string | null>(null);
  useEffect(() => {
    if (!editing) return;
    keptDraft.current = useDrafts.getState()[bot.id]?.text ?? '';
    setText(editDraft(editing.text));
    clearReply();
    requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.seq]);
  const cancelEdit = (restore = true) => {
    useEdit.getState().set(bot.id, undefined);
    if (restore && keptDraft.current !== null) setText(keptDraft.current);
    keptDraft.current = null;
  };
  // @ picker (groups, and a bot's own chat for the other bots): the @name at the cursor, the matches, and which one is lit.
  const [members, reloadMembers] = useRoomMembers(bot);
  const [cursor, setCursor] = useState(0);
  const [lit, setLit] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const typed = members.length || bot.kind === 'room' ? mentionQuery(text, cursor) : null;
  const matches = typed && typed.start !== dismissedAt ? mentionMatches(members, typed.query) : [];
  const picking = matches.length > 0;
  const pickerKey = typed ? `${typed.start}` : '';
  // A new @ (or none) opens the list again after Escape closed it; each new @ fetches the members again.
  useEffect(() => { setLit(0); if (dismissedAt !== null && String(dismissedAt) !== pickerKey) setDismissedAt(null); if (pickerKey) reloadMembers(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pickerKey]);
  const trackCursor = (el: HTMLTextAreaElement) => setCursor(el.selectionStart ?? el.value.length);
  const pick = (m: RoomMember) => {
    if (!typed) return;
    const next = insertMention(text, typed.start, cursor, m.name);
    setText(next.text);
    setCursor(next.cursor);
    placeCursor.current = next.cursor;
  };
  // After a pick, the cursor goes just past "@Name " as soon as the new text is in the box (before the next key).
  const placeCursor = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && placeCursor.current !== null) { el.focus(); el.setSelectionRange(placeCursor.current, placeCursor.current); placeCursor.current = null; }
  }, [text]);

  useEffect(() => { ref.current?.focus(); }, [bot.id]);

  const placeholder = bot.outside ? `Message ${displayName(bot)} via your Slack` : running && (bot.busySend ?? 'steer') === 'steer' ? `Add to what ${bot.kind === 'room' ? 'they’re' : `${bot.name} is`} working on…` : bot.kind === 'room' ? `Message ${displayName(bot)} · type @ to ask one Bot` : `Message ${displayName(bot)}`;
  // Auto-grow: the box is as tall as its words (or, when empty, its placeholder), up to MAX_H.
  // It is measured again whenever anything that changes that height changes, not only the words: the
  // placeholder (it changes while the Bot works), and the box's width (window resized or snapped, side
  // panel dragged, zoom). Before, only the words did, so after a long message was sent a box measured at
  // another width or with another placeholder stayed tall and blank until the chat was opened again.
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    // Measure with no scroll bar: on Windows a scroll bar takes width, so the words wrap onto more lines
    // while measuring than they fill once the box is its new height.
    el.style.overflowY = 'hidden';
    el.style.height = '0px';
    const want = el.scrollHeight;
    el.style.height = `${Math.min(want, MAX_H)}px`;
    el.style.overflowY = want > MAX_H ? 'auto' : 'hidden';
  };
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useLayoutEffect(fit, [text, placeholder]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.getBoundingClientRect().width;
    let frame = 0;
    // Only a change of width: the observer also sees the height this sets, which must not loop.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const w = el.getBoundingClientRect().width;
      if (Math.abs(w - width) < 0.5) return;
      width = w;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitRef.current());
    });
    ro?.observe(el);
    // A web font that loads after the first measure changes how the words wrap.
    void document.fonts?.ready.then(() => fitRef.current());
    return () => { ro?.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  // ⌘I focuses the prompt.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const send = async () => {
    const t = text.trim();
    const files = useAttach.getState()[bot.id] ?? [];
    const edit = useEdit.getState().of[bot.id];
    if ((!t && !(files.some((f) => f.state === 'done') && !edit)) || useDrafts.getState()[bot.id]?.sending) return;
    // Enter as well as the button: nothing goes to an outside member while its Slack link is paused or offline.
    if (bot.outside && bot.outside.status !== 'ready') { issue.show({ area: 'Slack link', text: 'The Slack link is not ready, so this was not sent. Your message is kept.' }); return; }
    if (t.length > MAX_TEXT) { issue.show({ area: 'Message', text: `That message is ${(t.length - MAX_TEXT).toLocaleString()} characters too long to send. Shorten it, or attach it as a file instead.` }); return; }
    if (files.some((f) => f.state === 'uploading')) { issue.show({ area: 'Attachment', text: 'A file is still uploading. Send again in a moment.' }); return; }
    if (files.some((f) => f.state === 'failed')) { issue.show({ area: 'Attachment', text: 'A file could not be uploaded. Remove it, or attach it again, then send.' }); return; }
    issue.clear();
    if (!edit) {
      // The message shows in the chat at once and goes out in order (lib/outbox.ts), also after a dropped connection.
      enqueue(bot.id, replyTo ? composeReply(t, replyTo) : t, takeAttached(bot.id));
      updateDraft(bot.id, (draft) => ({ ...draft, text: '' }));
      if (useReply.getState().to[bot.id] === replyTo) clearReply();
      ref.current?.focus();
      return;
    }
    updateDraft(bot.id, (draft) => ({ ...draft, sending: true }));
    try {
      if (!editChanged(edit.text, t)) { cancelEdit(); return; }
      await api.send(bot.id, composeEdit(edit.text, t), { editOf: edit.seq });
      updateDraft(bot.id, (draft) => ({ ...draft, text: draft.text === text ? '' : draft.text }));
      const kept = keptDraft.current; if (useEdit.getState().of[bot.id] === edit) cancelEdit(false); if (kept) setText(kept);
    } catch (e) {
      issue.fail('Message', e, 'Message failed to send', () => { void send(); });
    } finally {
      updateDraft(bot.id, (draft) => ({ ...draft, sending: false }));
      ref.current?.focus();
    }
  };

  /** ↑ in an empty box: edit the last message you typed. */
  const editLast = () => {
    const rows = Object.values(useStore.getState().transcripts[bot.id]?.bySeq ?? {}).sort((x, y) => y.seq - x.seq);
    const last = rows.find((r) => r.body.type === 'message' && r.body.role === 'user' && !r.body.from);
    const body = last?.body as MessageBody | undefined;
    if (!last || !body?.text.trim() || body.editedTo) return false;
    useEdit.getState().set(bot.id, { seq: last.seq, text: body.text });
    return true;
  };

  const stop = () => { issue.clear(); api.interrupt(bot.id).catch((e) => issue.fail('Stop', e, `Couldn't stop ${bot.name}.`, stop)); };
  // Starts at once; an Undo toast (FreshUndoToast) brings the chat back.
  const fresh = () => { useStore.getState().startFresh(bot.id).catch((e: Error) => issue.fail('New conversation', e, "Couldn't start a new conversation.", fresh)); };

  // Dictation: the words go in at the cursor as you speak; the box is read-only until dictation ends.
  // Nothing is sent until Send.
  const anchor = useRef<{ before: string; after: string } | null>(null);
  const dictation = useDictation({
    onStart: () => {
      const el = ref.current;
      const cur = useDrafts.getState()[bot.id]?.text ?? text;
      const focused = el && document.activeElement === el;
      const start = focused ? el.selectionStart : cur.length;
      const end = focused ? el.selectionEnd : cur.length;
      anchor.current = { before: cur.slice(0, start), after: cur.slice(end) };
    },
    onLive: (t, done) => {
      const a = anchor.current;
      if (!a) return;
      const words = [t.settled, t.pending].filter(Boolean).join(' ');
      const pre = words && a.before && !/\s$/.test(a.before) ? ' ' : '';
      const post = words && a.after && !/^\s/.test(a.after) ? ' ' : '';
      setText(a.before + pre + words + post + a.after);
      const el = ref.current;
      const pos = a.before.length + pre.length + words.length;
      requestAnimationFrame(() => {
        if (!el) return;
        el.setSelectionRange(pos, pos);
        // Keep the newest words in view as the box grows.
        el.scrollTop = el.scrollHeight;
        if (done) el.focus();
      });
      if (done) anchor.current = null;
    },
    onError: (msg) => issue.fail('Dictation', msg, 'Dictation failed.', () => startDictation.current()),
  }, bot.voiceLanguage);
  startDictation.current = dictation.start;
  // "Talk to a Bot" (lib/talk.ts): start dictating once this chat's composer is up. Nothing is sent by itself.
  useEffect(() => {
    const go = () => { if (takeListen(bot.id)) window.setTimeout(() => startDictation.current(), 250); };
    go();
    const on = (e: Event) => { if ((e as CustomEvent<string>).detail === bot.id) go(); };
    window.addEventListener(LISTEN_EVENT, on);
    return () => window.removeEventListener(LISTEN_EVENT, on);
  }, [bot.id]);
  const dictating = dictation.state !== 'idle';
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);

  const hasText = text.trim().length > 0 || (!editing && tray.some((f) => f.state === 'done'));
  const over = text.length - MAX_TEXT;
  const outside = bot.outside;
  const sendHint = `Send (${enterSends ? 'Enter' : keyHint('Enter')})`;
  const multiline = text.includes('\n') || (ref.current?.scrollHeight ?? 0) > 30;

  return (
    <div className="composer-area">
      {!!bot.waitingFor?.length && <WaitingChips waiting={bot.waitingFor} />}
      {editing && (
        <div className="composer-reply is-edit">
          <span className="composer-reply__bar" aria-hidden />
          <div className="composer-reply__text">
            <div className="composer-reply__who">Editing your message</div>
            <div className="composer-reply__quote">Send posts the new version and marks the old one Edited.</div>
          </div>
          <button type="button" className="msg-action" onClick={() => cancelEdit()} aria-label="Cancel edit" title="Cancel edit (Esc)"><Icon name="close" size={14} /></button>
        </div>
      )}
      {replyTo && !editing && (
        <div className="composer-reply">
          <span className="composer-reply__bar" aria-hidden />
          <div className="composer-reply__text">
            <div className="composer-reply__who">Replying to {replyTo.name}</div>
            <div className="composer-reply__quote">{replyTo.excerpt.replace(/\s*\n\s*/g, ' ')}</div>
          </div>
          <button type="button" className="msg-action" onClick={clearReply} aria-label="Cancel reply" title="Cancel reply (Esc)"><Icon name="close" size={14} /></button>
        </div>
      )}
      {picking && (
        <div className="mention-picker" role="listbox" id={`mentions-${bot.id}`} aria-label={bot.kind === 'room' ? 'Group members' : 'Other bots'}>
          {matches.map((m, i) => {
            const member = useStore.getState().bots.find((b) => b.id === m.id);
            return (
              <button
                key={m.id}
                id={`mention-${bot.id}-${i}`}
                type="button"
                role="option"
                aria-selected={i === lit}
                className={`mention-picker__row${i === lit ? ' is-lit' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setLit(i)}
                onClick={() => pick(m)}
              >
                {member ? <BotAvatarFor bot={member} size={28} still head /> : <span className="mention-picker__dot" style={{ background: m.avatarColor }} />}
                <span className="mention-picker__name">{m.name}</span>
                {(member?.outside || m.label) && <span className="mention-picker__label">{member?.outside ? 'via Slack' : m.label}</span>}
              </button>
            );
          })}
        </div>
      )}
      {issue.problem && (
        <div className="composer__error" role="status">
          <span><strong>{issue.problem.area}:</strong> {issue.problem.text}{issue.offline ? ' Waiting for the connection to come back…' : ''}</span>
          <span className="composer__error-actions">
            {issue.problem.retry && <button type="button" className="link-btn" onClick={issue.retry}>Try again</button>}
            <button type="button" className="link-btn" onClick={issue.clear}>Dismiss</button>
          </span>
        </div>
      )}
      {over > -20_000 && <div className={`composer__count${over > 0 ? ' is-over' : ''}`} role="status">{over > 0 ? `${over.toLocaleString()} characters too long to send. Shorten it, or attach it as a file.` : `${(-over).toLocaleString()} characters left`}</div>}
      {canAttach && <AttachTray chatId={bot.id} list={tray} />}
      {canAttach && <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />}
      <div className={`composer${multiline ? ' is-multiline' : ''}`}>
        <div className="composer__left">
          <span className="composer__plus-anchor">
            <button type="button" className="composer__btn" onClick={() => setMenu(!menu)} aria-label="More actions" aria-expanded={menu}>
              <Icon name="composer_plus" opacity={0.56} />
            </button>
            {menu && (
              <Menu
                placement="above"
                onClose={() => setMenu(false)}
                items={[
                  ...(canAttach ? [{ label: 'Attach pictures or files', hint: 'or paste, or drop', onSelect: () => fileInput.current?.click() }] : []),
                  { label: 'New conversation', hint: keyHint('O', { shift: true }), onSelect: fresh, divider: canAttach },
                  ...(bot.outside ? [] : [{ label: 'Earlier conversations', onSelect: () => useStore.getState().openHistory(bot.id) }]),
                  ...(useStore.getState().user?.scope ? [] : [{ label: 'Connections', onSelect: () => useConfigUI.getState().openAppSettings('connections') }]),
                ]}
              />
            )}
          </span>
          <div className="composer__field">
            <MentionBackdrop text={text} names={members.map((m) => m.name)} scrollTop={scrollTop} />
            <textarea
              ref={ref}
              className="composer__input"
              rows={1}
              value={text}
              placeholder={placeholder}
              readOnly={dictating}
              onChange={(e) => { if (!dictating) { setText(e.target.value); trackCursor(e.target); } }}
              onSelect={(e) => trackCursor(e.currentTarget)}
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
              onPaste={(e) => {
                // A copied picture or file goes with the message; copied words paste as usual.
                const files = [...(e.clipboardData?.files ?? [])];
                if (canAttach && files.length) { e.preventDefault(); addFiles(files); }
              }}
              onKeyDown={(e) => {
                if (picking) {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setLit((i) => (i + 1) % matches.length); return; }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setLit((i) => (i - 1 + matches.length) % matches.length); return; }
                  if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); pick(matches[Math.min(lit, matches.length - 1)]); return; }
                  if (e.key === 'Escape') { e.preventDefault(); setDismissedAt(typed!.start); return; }
                }
                if (e.key === 'Escape' && editing) { e.preventDefault(); cancelEdit(); return; }
                if (e.key === 'Escape' && replyTo) { e.preventDefault(); clearReply(); return; }
                if (e.key === 'ArrowUp' && !text && !editing && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && editLast()) { e.preventDefault(); return; }
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  // Settings, General: Enter sends (Shift+Enter adds a line), or Enter adds a line and Ctrl/⌘+Enter sends.
                  const mod = e.metaKey || e.ctrlKey;
                  if (mod || (enterSends && !e.shiftKey)) { e.preventDefault(); void send(); }
                }
              }}
              aria-label={`Message ${bot.name}`}
              aria-autocomplete={bot.kind === 'room' ? 'list' : undefined}
              aria-expanded={bot.kind === 'room' ? picking : undefined}
              aria-controls={picking ? `mentions-${bot.id}` : undefined}
              aria-activedescendant={picking ? `mention-${bot.id}-${Math.min(lit, matches.length - 1)}` : undefined}
            />
          </div>
        </div>
        <div className="composer__right">
          {dictating && <MicWave level={dictation.level} busy={dictation.state === 'transcribing'} />}
          <button
            type="button"
            className={`composer__btn${dictation.state === 'recording' ? ' is-recording' : dictation.state === 'transcribing' ? ' is-transcribing' : ''}`}
            aria-label={dictation.state === 'recording' ? 'Stop dictation' : 'Dictate'}
            aria-pressed={dictation.state === 'recording'}
            title={dictation.state === 'recording' ? 'Release or click to stop · Esc cancels' : dictation.state === 'transcribing' ? 'Transcribing…' : 'Hold to dictate, or click to start'}
            disabled={dictation.state === 'transcribing'}
            onPointerDown={dictation.onPointerDown}
            onPointerUp={dictation.onPointerUp}
            onKeyDown={dictation.onKeyDown}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Icon name="mic" opacity={0.56} />
          </button>
          {outside ? (
            <button type="button" className="composer__cta" onClick={send} disabled={!hasText || sending || outside.status !== 'ready'} aria-label="Send" title={outside.status === 'ready' ? `Send to Slack (${enterSends ? 'Enter' : keyHint('Enter')})` : 'The Slack link is not ready'}>
              <Icon name="arrow_up" size={16} />
            </button>
          ) : inCall && !hasText ? (
            <button type="button" className="composer__cta is-in-call" onClick={endCall} aria-label="End voice call" title="End voice call">
              <Icon name="voice_a" size={16} />
            </button>
          ) : running && !hasText ? (
            <button type="button" className="composer__cta" onClick={stop} aria-label="Stop" title="Stop">
              <Icon name="stop" size={14} />
            </button>
          ) : bot.kind === 'room' ? (
            // A group has no voice chat (its members answer in writing), so its button only sends.
            <button type="button" className="composer__cta" onClick={send} disabled={!hasText || sending} aria-label="Send" title={sendHint}>
              <Icon name="arrow_up" size={16} />
            </button>
          ) : (
            <button
              type="button"
              className="composer__cta"
              onClick={hasText ? send : () => startCall(bot.id)}
              disabled={hasText && sending}
              aria-label={hasText ? 'Send' : `Start voice chat with ${bot.name}`}
              title={hasText ? sendHint : 'Start voice chat'}
            >
              <Icon name={hasText ? 'arrow_up' : 'voice_a'} size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
