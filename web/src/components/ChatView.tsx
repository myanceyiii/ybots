import { useEffect, useMemo, useRef, useState } from 'react';
import { AVATAR_POSES } from '@shared/avatar-poses';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { useBotPose } from '../avatar/pose';
import { botVars } from '../lib/colors';
import { displayName, sortedRows, useSelectedBot, useStore } from '../store';
import { useLayout } from '../lib/useLayout';
import { useConfigUI } from '../configStore';
import { Composer } from './Composer';
import { BoardDock } from './BoardDock';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { Transcript } from './Transcript';
import { VoiceCallBar } from './VoiceCallBar';
import { ChatSwitcher, useSideChats } from './SideChats';
import { keyHint } from '../lib/keys';
import { api } from '../lib/api';
import { attachFiles, useOutbox } from '../lib/outbox';

/** Save text as a file from the page. */
export function downloadText(name: string, text: string, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * A line across the top of the chat while the live connection is down: what you see may be behind, and
 * what you send waits and goes out by itself. Shown only after a few seconds, so a blip says nothing.
 */
function ConnectionBanner() {
  const connected = useStore((s) => s.sseConnected);
  const restarting = useStore((s) => s.restarting);
  const waiting = useOutbox((s) => s.items.filter((p) => p.state === 'waiting').length);
  const [late, setLate] = useState(false);
  const seen = useRef(false);
  if (connected) seen.current = true;
  useEffect(() => {
    if (connected) { setLate(false); return; }
    // An announced update is said at once; a lost connection only after a few seconds, so a blip says nothing.
    const t = setTimeout(() => setLate(true), restarting ? 300 : seen.current ? 4000 : 8000);
    return () => clearTimeout(t);
  }, [connected, restarting]);
  if (connected || !late) return null;
  return (
    <div className="conn-banner" role="status">
      <Icon name="offline" size={14} opacity={0.8} />
      <span>{navigator.onLine === false ? 'You are offline.' : restarting ? 'The server is updating and will be back in a moment.' : 'Reconnecting to the server…'} {waiting ? `${waiting} ${waiting === 1 ? 'message is' : 'messages are'} waiting and will send by itself.` : 'New messages will show when the connection is back.'}</span>
    </div>
  );
}
import { useSimple } from '../lib/simple';
import { applyAskLink } from '../lib/askLink';

export function ChatView() {
  const bot = useSelectedBot();
  // The open chat: the bot's main chat, or one of its side chats (SideChats.tsx). A side chat is the same bot
  // (name, look, settings) with its own id for its rows, live state, messages and Stop.
  const { open: side } = useSideChats(bot?.id);
  const chatId = side?.id ?? bot?.id;
  const transcript = useStore((s) => (chatId ? s.transcripts[chatId] : undefined));
  const live = useStore((s) => (chatId ? s.live[chatId] ?? (side ? side.live : undefined) : undefined));
  const chatBot = useMemo(() => (bot && side ? { ...bot, id: side.id, unread: side.unread, generation: side.generation, lastActivityAt: side.lastActivityAt } : bot), [bot, side]);
  const detailsOpen = useStore((s) => s.detailsOpen);
  const filesOpen = useStore((s) => s.filesOpen);
  const set = useStore((s) => s.set);
  const chatFull = useStore((s) => s.chatFull);
  const compact = useLayout() === 'compact';
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const muted = useStore((s) => (bot ? s.muted[bot.id] : undefined));
  const isMuted = muted !== undefined && (muted === 0 || muted > Date.now());
  // Dropping pictures or files anywhere on the chat attaches them to the next message.
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const rows = useMemo(() => sortedRows(transcript), [transcript]);
  // A scoped sign-in's view (lib/simple.ts): no computer; plain words for the menu.
  const simple = useSimple();
  // A link that opened the app with words for the message box (lib/askLink.ts).
  const askChat = chatBot?.id;
  useEffect(() => { if (askChat) applyAskLink(askChat); }, [askChat]);

  if (!bot || !chatBot) {
    return (
      <main className="chat chat--empty">
        <div className="empty-chat">
          <div className="empty-chat__title">Pick a chat</div>
          <div className="empty-chat__sub">Choose a Bot from the list to open its chat{useStore.getState().user?.scope ? '.' : ', or make a new one.'}</div>
          {!useStore.getState().user?.scope && <button type="button" className="starter-chip" onClick={() => useStore.getState().setModal('create')}>New Bot</button>}
        </div>
      </main>
    );
  }

  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(null), 3000); };
  const canAttach = bot.kind !== 'room' && !bot.outside;
  const hasFiles = (e: React.DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  const exportChat = async () => {
    try { const r = await api.exportChat(chatBot.id); downloadText(r.name, r.markdown); flash('Saved the conversation as a file.'); }
    catch (e) { flash((e as Error).message || 'Could not export the conversation.'); }
  };
  const act = (p: Promise<unknown>, done?: string) => { p.then(() => { if (done) flash(done); }, (e) => flash((e as Error).message || 'That did not work. Try again.')); };

  return (
    <main className={`chat${bot.kind !== 'room' && !bot.outside ? ' has-side-chats' : ''}`} style={botVars(bot.avatarColor)}
      onDragEnter={(e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current++; setDropping(true); }}
      onDragOver={(e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = canAttach ? 'copy' : 'none'; } }}
      onDragLeave={(e) => { if (!hasFiles(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDropping(false); }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); dragDepth.current = 0; setDropping(false);
        if (!canAttach) { flash(bot.kind === 'room' ? 'A group chat takes words only. Send the file to one Bot in its own chat.' : `${bot.name} is outside the app and takes words only.`); return; }
        const note = attachFiles(chatBot.id, [...e.dataTransfer.files]);
        if (note) flash(note);
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer__input')?.focus());
      }}>
      <Transcript key={`t-${chatBot.id}`} bot={chatBot} ownerId={bot.id} rows={rows} live={live} loaded={!!transcript?.loaded} generation={transcript?.generation} />
      <ConnectionBanner />
      {dropping && <div className="drop-veil" aria-hidden><div className="drop-veil__card"><Icon name="paperclip" size={22} opacity={0.8} /><span>{canAttach ? `Drop to attach to your message to ${bot.name}` : 'This chat takes words only'}</span></div></div>}
      <VoiceCallBar />
      <BoardDock rows={rows} chatId={chatBot.id} simple={simple} />
      <Composer key={chatBot.id} bot={chatBot} running={!!live?.isRunning} />
      <header className="chat__header">
        <span className="chat__pill-anchor">
          <button type="button" className="chat__pill" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
            <BotAvatarFor bot={bot} size={48} head badge />
            <span className="chat__pill-text">
              <span className="chat__pill-name">{displayName(bot)}{bot.outside && <span className="outside-badge">via Slack</span>}{isMuted && <span className="chat__pill-muted" title="Notifications are muted"><Icon name="bell_off" size={12} opacity={0.66} /></span>}</span>
              <PoseLabel botId={chatBot.id} lastActivityAt={chatBot.lastActivityAt} />
            </span>
          </button>
          {menu && (
            <Menu
              align="center"
              onClose={() => setMenu(false)}
              items={[
                { label: detailsOpen ? 'Hide details' : 'Show details', hint: keyHint(',', { shift: true }), onSelect: () => set({ detailsOpen: !detailsOpen }) },
                ...(bot.outside ? [{ label: 'Open in ChatGPT ↗', onSelect: () => { window.open(bot.outside!.callUrl, '_blank', 'noopener'); } }] : []),
                ...(bot.outside || bot.kind === 'room' || simple ? [] : [{ label: 'Open computer', onSelect: () => set({ viewerOpen: true, viewerMode: 'watch', viewerHint: null }) }]),
                { label: 'Search messages', hint: keyHint('K'), onSelect: () => useStore.getState().setModal('search') },
                ...(bot.outside ? [] : [{ label: 'Earlier conversations', onSelect: () => useStore.getState().openHistory(chatBot.id) }]),
                { label: 'Save conversation as a file', onSelect: () => { void exportChat(); } },
                ...(side ? [] : [
                  ...(bot.isPrimary ? [] : [{ label: bot.pinned ? 'Unpin from the top' : 'Pin to the top', onSelect: () => act(useStore.getState().setPinned(bot.id, !bot.pinned)), divider: true }]),
                  { label: isMuted ? 'Turn notifications back on' : 'Mute notifications', onSelect: () => act(useStore.getState().setMute(bot.id, isMuted ? null : 0), isMuted ? `Notifications are back on for ${bot.name}.` : `Muted ${bot.name} until you turn it back on.`), divider: bot.isPrimary },
                  { label: 'Mark as unread', onSelect: () => act(useStore.getState().markUnread(bot.id)) },
                ]),
                { label: side ? 'New conversation in this side chat' : 'New conversation', hint: keyHint('O', { shift: true }), divider: true, onSelect: () => { useStore.getState().startFresh(chatBot.id).catch((e) => flash(e.message)); } },
                ...(bot.kind === 'room' || bot.outside ? [] : [{ label: 'New side chat', onSelect: () => { useStore.getState().newSideChat(bot.id).catch((e) => flash(e.message)); } }]),
                ...(bot.outside || bot.kind === 'room' || simple ? [] : [{ label: 'Engine and providers', onSelect: () => set({ detailsOpen: true, filesOpen: false, chatFull: false, engineReveal: Date.now() }) }]),
                ...(bot.kind === 'room' ? [] : [{ label: 'Change look', onSelect: () => useConfigUI.getState().openBotSettings(bot.id, 'look') }]),
                { label: bot.kind === 'room' ? 'Group settings' : simple ? `${displayName(bot)}’s settings` : 'Bot settings', onSelect: () => useConfigUI.getState().openBotSettings(bot.id) },
              ]}
            />
          )}
        </span>
        <div className="chat__header-left"><ChatSwitcher bot={bot} /></div>
        <div className="chat__header-right">
          {!compact && (
            <button type="button" className={`icon-btn icon-btn--bordered${chatFull ? ' is-active' : ''}`} onClick={() => set({ chatFull: !chatFull })} aria-label={chatFull ? 'Show the bot list' : 'Full screen'} title={chatFull ? 'Show the bot list (Esc)' : `Full screen (${keyHint('F', { shift: true })})`}>
              <Icon name={chatFull ? 'shrink' : 'expand'} opacity={0.66} />
            </button>
          )}
          {!bot.outside && bot.kind !== 'room' && (
            <button type="button" className={`icon-btn icon-btn--bordered${filesOpen ? ' is-active' : ''}`} onClick={() => set({ filesOpen: !filesOpen, filesPath: null, chatFull: false })} aria-label={filesOpen ? 'Hide files' : 'Show files'} title="Files">
              <Icon name="file" opacity={0.66} />
            </button>
          )}
          {(!detailsOpen || filesOpen) && (
            <button type="button" className="icon-btn icon-btn--bordered" onClick={() => set({ detailsOpen: true, filesOpen: false, chatFull: false })} aria-label="Show details" title="Show details">
              <Icon name="sidebar" opacity={0.66} style={{ transform: 'scaleX(-1)' }} />
            </button>
          )}
          {bot.outside?.callUrl && (
            <a className="share-btn" href={bot.outside.callUrl} target="_blank" rel="noreferrer" title={`Opens ChatGPT, where ${displayName(bot)} lives`}>
              Open in ChatGPT ↗
            </a>
          )}
        </div>
      </header>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}

/** What the bot is doing now, in the words of its pose (matches the picture beside it). */
function PoseLabel({ botId, lastActivityAt }: { botId: string; lastActivityAt?: number }) {
  const pose = useBotPose(botId, lastActivityAt);
  // The simple view says "Here for you" where the full app says "Idle", which reads like a machine's state.
  const simple = useSimple();
  const label = simple && pose === 'idle' ? 'Here for you' : AVATAR_POSES.find((p) => p.id === pose)?.label;
  return label ? <span className="chat__pill-pose">{label}</span> : null;
}
