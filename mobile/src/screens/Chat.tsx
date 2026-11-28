import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from '../toast';
import { ActivityIndicator, Alert, Animated, Easing, FlatList, Image, Keyboard, LayoutAnimation, Linking, Platform, Pressable, ScrollView, type ScrollViewInstance, Share, Switch, Text, TextInput, View, useWindowDimensions, type TextInputInstance } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { Bot, Client, Row } from '../api';
import { BotAvatar, BotShape } from '../components/BotAvatar';
import { ModelBadge, ModelBadgeInline, WithModelBadge } from '../components/ModelBadge';
import { plainStep, useSimple, useScopedSignIn } from '../simple';
import { celebrate, useBotPose, useLive } from '../live';
import { KeyboardSafe, RevealFocused, useRevealOnFocus } from '../components/KeyboardSafe';
import { BoardDock } from '../components/BoardDock';
import { AllowedHere } from '../components/AllowedHere';
import { ACTIVITY_LABEL, POSE_LABELS } from '../poses';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { CheckBadge } from '../components/CheckBadge';
import { startFresh } from '../fresh';
import { Chip, Header, OutsideTag, PillButton, RoundButton, Sheet, SheetRow } from '../components/ui';
import { FileChips, downloadToPhone } from './Files';
import { ViewCard } from '../components/ViewCard';
import { MailView } from '../components/MailView';
import { ArgsDetails } from '../components/ArgsDetails';
import { color, type, currentScheme } from '../theme';
import { composeEdit, composeReply, editChanged, editDraft, insertMention, mentionMatches, mentionParts, mentionQuery, plainText, replyExcerpt, splitReply, type ReplyTarget } from '../messageText';
import { MORE_REACTIONS, QUICK_REACTIONS, reactionChips, type Reaction } from '../reactions';
import { getDraft, setDraft } from '../drafts';
import { useDictation } from '../voice/dictation';
import { onListen, takeListen } from '../assist';
import { useProblem } from '../problem';
import { MicWave } from '../components/MicWave';
import { isCallActive, useCall } from '../voice/call';
import { CallBar } from './Call';
import { safeUrl as safeLink } from '../components/Markdown';
import { stepState, STEP_LABEL } from '../steps';
import { pendingCard, replyWait } from '../replyWait';
import { chatColorForUnseen, chatInk, type ChatInk } from '../chatColors';
import { AttachTray, MessageAttachments, PendingBubble, pick, upload, type Attaching } from '../components/Attachments';
import { enqueue, usePending, type Pending } from '../outbox';
import { sized, useTextSize } from '../prefs';
import { shareConversation } from './History';
import { RowGuard } from '../components/ErrorBoundary';
import { tap } from '../haptics';
import { useBack } from '../back';
import { appIcon, cardIcon, type IconData } from '../cardIcon';
import { IconTile } from '../components/CardIcon';
import { listen, listenAvailable, stopListening, useListening } from '../voice/listen';
import { HANDOFF_HINT, handoffLabel } from '../handoffLabel';

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Grok Bot's chat: bot name pill, grey bot bubbles, black user bubbles, action cards, composer. */
/** How far (in points) a scroll down takes the big picture to its small size, and a scroll up back again. */
const COLLAPSE_AT = 160;
/** Room kept under a focused card field for the card's buttons (Fill in / Don't fill and the line under them). */
const REVEAL_BELOW = 112;

export function Chat({ api, bot, bots, rows, onBack, onCall, onSettings, onComputer, onRefresh, onEarlier, onTasks, onPluginCode, onFiles, onPages, onExchanges, loadError, earlierError, onRetryLoad, focusSeq, onFocused, fullScreen, onFullScreen, switcher, ownerId, onHistory, onSearch, loaded }: {
  api: Client; bot: Bot; rows: Row[]; onBack?: () => void;
  /** The server has answered for this chat (rows before that are the phone's saved copy). */
  loaded?: boolean;
  /** Every bot this account sees, for other bots' faces and colours on their messages (chatColors.ts). */
  bots?: Bot[];
  /** The chat could not be read (shown instead of an empty chat), or an earlier page could not. */
  loadError?: string | null; earlierError?: string | null; onRetryLoad?: () => void;
  /** A notification for this row was tapped: bring it into view. */
  focusSeq?: number; /** Called once the focused row has been shown (or given up on), so the chat opens at its newest message next time. */ onFocused?: () => void; onCall: () => void; onSettings: (tab?: 'look') => void; onComputer: () => void; onRefresh: () => void; onEarlier?: () => void | Promise<void>; onTasks?: () => void; singleBot?: boolean;
  /** Beside the bot list (an unfolded phone): the chat can take the whole screen and come back. */
  fullScreen?: boolean; onFullScreen?: () => void;
  /** A bot outside the app (Sheldon): its exchanges with the other bots (Exchanges.tsx). */
  onExchanges?: () => void;
  /** The files screen (Files.tsx), optionally on one file. */
  onFiles?: (path?: string) => void;
  /** The bot's Pages list (Pages.tsx). */
  onPages?: () => void;
  /** Opens a made plugin's code, from its review card. */
  onPluginCode?: (draftId: string) => void;
  /** Which of the bot's chats is open (its main chat or a side chat), and the way to switch (SideChats.tsx). */
  switcher?: ReactNode;
  /** The bot whose Library holds this chat's pictures and files (a side chat's files live under its bot). */
  ownerId?: string;
  /** This chat's earlier conversations (History.tsx), and the search of every message (Search.tsx). */
  onHistory?: () => void; onSearch?: () => void;
}) {
  const owner = ownerId ?? bot.id;
  // The words in chats follow the phone's text size setting (src/prefs.ts).
  const textSize = useTextSize();
  const [typing, setTyping] = useState(false);
  /** A group chat has no computer or look of its own. */
  const isGroup = bot.kind === 'room';
  // Earlier messages are being fetched (the chat was scrolled to its top).
  const [earlier, setEarlier] = useState(false);
  const { height } = useWindowDimensions();
  // The bot's picture is big at the top of the chat so its poses show, and small while the keyboard is open.
  const onKeyboard = useCallback((open: boolean) => {
    LayoutAnimation.configureNext(LayoutAnimation.create(180, 'easeInEaseOut', 'opacity'));
    setTyping(open);
  }, []);
  const big = !typing && height >= 560;
  // A third smaller than it was (140 / 16% of the height, until 2026-11-23), so the chat gets more room.
  const avatar = big ? Math.min(94, Math.round(height * 0.107)) : 44;
  // Scrolling down through the chat (toward the newest messages) shrinks the big picture smoothly to a small
  // one beside the buttons; scrolling back up grows it again, wherever you are in the chat. The list is
  // inverted, so its offset grows going up: the picture follows the scroll's direction (diffClamp), frame by frame.
  const scrollY = useRef(new Animated.Value(0)).current;
  useEffect(() => { scrollY.setValue(0); }, [bot.id, scrollY]);
  const SMALL = 44;
  const shrink = useRef(Animated.diffClamp(Animated.multiply(scrollY, -1), 0, COLLAPSE_AT)).current
    .interpolate({ inputRange: [0, COLLAPSE_AT], outputRange: [0, 1], extrapolate: 'clamp' });
  const avatarScale = shrink.interpolate({ inputRange: [0, 1], outputRange: [1, SMALL / Math.max(avatar, SMALL)] });
  const avatarBox = shrink.interpolate({ inputRange: [0, 1], outputRange: [avatar, SMALL] });
  // Big: the picture sits under the button row (overlapping it a little). Small: in the row, between the buttons.
  const avatarLift = shrink.interpolate({ inputRange: [0, 1], outputRange: [-30, -SMALL] });
  const faceFade = shrink.interpolate({ inputRange: [0.45, 0.85], outputRange: [0, 1], extrapolate: 'clamp' });
  const bodyFade = shrink.interpolate({ inputRange: [0.45, 0.85], outputRange: [1, 0], extrapolate: 'clamp' });
  const poseFade = shrink.interpolate({ inputRange: [0, 0.6], outputRange: [1, 0], extrapolate: 'clamp' });
  const poseHeight = shrink.interpolate({ inputRange: [0, 1], outputRange: [22, 0] });
  // The model chip (ModelBadge) while the bot works: big, it hangs on the lower body under the face; as the
  // picture shrinks to its face, the chip slides out to sit beside the face's lower-right edge, so it never
  // covers the face. Its width is capped to the room left before the right-hand buttons (long model names
  // shorten with an ellipsis instead of running into them).
  const [headRow, setHeadRow] = useState({ row: 0, right: 0 });
  const [chipW, setChipW] = useState(0);
  const chipRoom = headRow.row > 0 ? Math.max(56, Math.floor(headRow.row / 2 - (SMALL / 2 - 6) - headRow.right - 6)) : undefined;
  const chipShift = shrink.interpolate({ inputRange: [0, 1], outputRange: [0, SMALL / 2 - 6 + chipW / 2] });
  const chipDrop = shrink.interpolate({ inputRange: [0, 1], outputRange: [-4, 0] });
  // A scoped sign-in's view (src/simple.ts): no computer, plain steps.
  const simple = useSimple();
  const onScroll = Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: false });
  // The composer's text lives per bot (src/drafts.ts); this screen is keyed by bot in App.tsx.
  const [text, setTextState] = useState(() => getDraft(bot.id));
  const setText = useCallback((t: string) => { setTextState(t); setDraft(bot.id, t); }, [bot.id]);
  // @ picker: typing @ lists the group's members (or, in a bot's own chat, the other bots); a tap puts "@Name " in the box.
  const members = useGroupMembers(api, bot);
  const [sel, setSel] = useState<{ start: number; end: number }>(() => ({ start: getDraft(bot.id).length, end: getDraft(bot.id).length }));
  // Set only for the render right after a pick, to move the cursor past the inserted name.
  const [forceSel, setForceSel] = useState<{ start: number; end: number } | undefined>();
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const typed = (isGroup || members.list.length > 0) && sel.start === sel.end ? mentionQuery(text, sel.start) : null;
  const matches = typed && typed.start !== dismissedAt ? mentionMatches(members.list, typed.query) : [];
  // A new @ (or none) opens the list again after it was closed; each new @ fetches the members again.
  useEffect(() => {
    if (dismissedAt !== null && typed?.start !== dismissedAt) setDismissedAt(null);
    if (typed) members.reload();
  /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [typed?.start]);
  const pickMention = (name: string) => {
    if (!typed) return;
    const next = insertMention(text, typed.start, sel.start, name);
    setText(next.text);
    const at = { start: next.cursor, end: next.cursor };
    setSel(at);
    setForceSel(at);
    requestAnimationFrame(() => setForceSel(undefined));
  };
  const mounted = useRef(true);
  // Leaving the chat stops a reply being read aloud (its Stop button would be out of reach).
  useEffect(() => () => { mounted.current = false; stopListening(); }, []);
  const [sending, setSending] = useState(false);
  // The server takes at most this many characters in one message (the same limit and counter as the web).
  const tooLong = text.length > MAX_TEXT;
  // What just failed (dictation, sending, stopping...), with Try again; clears once the server answers again.
  const issue = useProblem(api.me);
  const startDictation = useRef<() => void>(() => {});
  // Dictation: what you say is written into the message box as you speak, after what was already
  // there (nothing is sent until you press Send). The box can't be typed in until dictation ends.
  const dictBase = useRef<string | null>(null);
  const dictation = useDictation(api, {
    onStart: () => { stopListening(); dictBase.current = getDraft(bot.id); },
    onLive: (t, done) => {
      const base = dictBase.current;
      if (base === null) return;
      const words = [t.settled, t.pending].filter(Boolean).join(' ');
      setText(words ? (base.trim() ? `${base.replace(/\s*$/, '')} ${words}` : words) : base);
      if (done) dictBase.current = null;
    },
    onError: (msg) => issue.fail('Dictation', msg, 'Dictation failed.', () => startDictation.current()),
  }, bot.voiceLanguage);
  startDictation.current = dictation.start;
  // Opened by the phone's assistant gesture with "Start listening" on (src/assist.ts): start dictating once the
  // chat is up. Words go in the message box only; nothing is sent until you press Send.
  useEffect(() => {
    const go = () => { if (takeListen(bot.id)) setTimeout(() => { if (mounted.current) startDictation.current(); }, 350); };
    go();
    return onListen((id) => { if (id === bot.id) go(); });
  }, [bot.id]);
  const dictating = dictation.state !== 'idle';
  const call = useCall();
  const inCall = call.botId === bot.id && isCallActive(call);
  // A bot outside the app gets messages only through its Slack link, and only while that link is up.
  const linkDown = !!bot.outside && bot.outside.status !== 'ready';
  const [menu, setMenu] = useState(false);
  // Pictures and files for the next message: uploaded as they are picked, sent with the message.
  const [tray, setTray] = useState<Attaching[]>([]);
  const uploading = tray.some((a) => a.state === 'uploading');
  const ready = tray.filter((a) => a.state === 'done' && a.file);
  const attach = (source: 'photos' | 'camera' | 'files') => {
    setMenu(false);
    issue.clear();
    // The sheet closes first: Android cannot open its picker over a closing sheet.
    setTimeout(() => {
      pick(source).then((picked) => {
        if (!picked.length || !mounted.current) return;
        const note = upload(api, bot.id, picked, tray.length, (f) => { if (mounted.current) setTray(f); });
        if (note) issue.show({ area: 'Attachment', text: note });
      }).catch((e) => issue.fail('Attachment', e, 'That could not be added.'));
    }, 250);
  };
  // Messages on their way (src/outbox.ts), until their own row arrives.
  const queued = usePending(bot.id);
  const [sharing, setSharing] = useState(false);
  // Reply: the message the composer answers, quoted when sent (and @mentioning its writer in a group).
  const [replyTo, setReplyTo] = useState<ReplyTarget | undefined>();
  const input = useRef<TextInputInstance>(null);
  // Edit: one of your sent messages, its words back in the box; Send posts the new version and marks the old one Edited.
  const [editing, setEditing] = useState<{ seq: number; text: string } | undefined>();
  const keptDraft = useRef<string | null>(null);
  useEffect(() => { setReplyTo(undefined); setEditing(undefined); keptDraft.current = null; }, [bot.id]);
  const onReply = useCallback((to: ReplyTarget) => { setEditing(undefined); setReplyTo(to); input.current?.focus(); }, []);
  const onEdit = useCallback((seq: number, original: string) => {
    if (keptDraft.current === null) keptDraft.current = getDraft(bot.id);
    setReplyTo(undefined);
    setEditing({ seq, text: original });
    setText(editDraft(original));
    input.current?.focus();
  }, [bot.id, setText]);
  const cancelEdit = (restore = true) => {
    setEditing(undefined);
    if (restore && keptDraft.current !== null) setText(keptDraft.current);
    keptDraft.current = null;
  };
  // The phone's back button first drops an edit or a reply in progress, then leaves the chat.
  useBack(!!editing || !!replyTo, () => { if (editing) cancelEdit(); else setReplyTo(undefined); });
  const live = useLive(bot.id);
  // While the bot is on a turn, the composer's mic becomes Stop (as on the web and Windows apps).
  // In a group it stops every member answering the group's messages.
  const running = !!live?.isRunning && !bot.outside;
  const [stopping, setStopping] = useState(false);
  useEffect(() => { if (!running) setStopping(false); }, [running]);
  const stop = () => {
    if (stopping) return;
    setStopping(true);
    tap('medium');
    issue.clear();
    api.interrupt(bot.id).catch((e) => { setStopping(false); issue.fail('Stop', e, `Couldn't stop ${bot.name}.`, stop); });
  };
  // "New" line: the chat was opened with unread messages; the line sits above the first of them (as on the web).
  const [unreadAtOpen] = useState(bot.unread);
  const [newFrom, setNewFrom] = useState<number | null>(null);
  const placedNew = useRef(false);
  useEffect(() => {
    if (!loaded || placedNew.current || !rows.length) return;
    placedNew.current = true;
    let left = unreadAtOpen;
    let at: number | null = null;
    for (let i = rows.length - 1; i >= 0 && left > 0; i--) if (isIncoming(rows[i])) { at = rows[i].seq; left--; }
    if (at !== null) setNewFrom(at);
  /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [loaded, rows.length > 0]);
  // Messages and cards, with each run of the bot's tool calls folded into one "steps" row (as on the web).
  // Built only when the rows (or the queue) change, so typing in the message box does not rebuild the chat.
  const list = useMemo(() => {
    const items: Item[] = [];
    for (const r of rows) {
      const t = r.body.type;
      if (t === 'tool-call') {
        const last = items[items.length - 1];
        if (last?.kind === 'steps') last.rows.push(r);
        else items.push({ kind: 'steps', key: `s${r.generation}:${r.seq}`, createdAt: r.createdAt, rows: [r] });
      } else if (answeredChoice(r)) {
        continue;
      } else if ((t === 'message' && (r.body.text || r.body.streaming || r.body.attachments?.length)) || t === 'card' || (t === 'notice' && r.body.text)) {
        items.push({ kind: 'row', key: `${r.generation}:${r.seq}`, createdAt: r.createdAt, row: r });
      }
    }
    // Where a time goes above a row, and how close it sits to the one before it.
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as Extract<Item, { kind: 'row' | 'steps' }>;
      const older = items[i - 1];
      item.stamp = !older || item.createdAt - older.createdAt > 30 * 60_000 || new Date(item.createdAt).toDateString() !== new Date(older.createdAt).toDateString();
      const mine = item.kind === 'row' && isMine(item.row);
      const olderMine = older?.kind === 'row' && isMine(older.row);
      item.gap = item.stamp ? 6 : older && olderMine === mine ? 6 : 12;
      item.fresh = newFrom !== null && (item.kind === 'row' ? item.row.seq === newFrom : item.rows.some((r) => r.seq === newFrom));
    }
    // The live "working" line sits at the newest end as a list item, so it scrolls and flips with the messages.
    const waitingToSend = queued.filter((p) => !rows.some((r) => r.seq > p.afterSeq && r.body.type === 'message' && r.body.role === 'user' && (r.body.text ?? '') === p.text.trim()));
    const pendingItems: Item[] = [...waitingToSend].reverse().map((p) => ({ kind: 'pending', key: `p${p.clientId}`, createdAt: p.createdAt, pending: p }));
    const out: Item[] = items.length || pendingItems.length ? [...pendingItems, ...(items.length ? [{ kind: 'working', key: 'working', createdAt: Infinity } as Item] : []), ...items.reverse()] : [];
    return out;
  }, [rows, queued, newFrom]);
  // A message taken back out of the queue: its words (and files) go back to the message box.
  const takeBack = (p: Pending) => {
    setText(getDraft(bot.id) ? `${p.text}\n${getDraft(bot.id)}` : p.text);
    if (p.attachments.length) setTray((l) => [...p.attachments.map((f, i) => ({ id: `${p.clientId}-${i}`, name: f.name, size: f.size, uri: api.fileRawUrl(owner, f.path), image: false, state: 'done' as const, file: f })), ...l]);
    input.current?.focus();
  };

  const send = async () => {
    const t = text.trim();
    if ((!t && !ready.length) || sending || uploading || tooLong) return;
    if (linkDown) { issue.show({ area: 'Slack link', text: `The Slack link to ${bot.name} is ${bot.outside?.status === 'paused' ? 'paused' : 'not ready'}, so nothing was sent. Your message is kept.` }); return; }
    setSending(true);
    issue.clear();
    const submitted = text;
    const reply = replyTo;
    const edit = editing;
    if (edit && !t) { setSending(false); return; }
    if (edit && !editChanged(edit.text, t)) { setSending(false); cancelEdit(); return; }
    try {
      if (edit) await api.send(bot.id, composeEdit(edit.text, t), { editOf: edit.seq });
      else {
        // A new message goes through the queue: it shows at once and survives a dropped connection.
        enqueue(bot.id, reply && t ? composeReply(t, reply) : t, ready.map((a) => a.file!), rows[rows.length - 1]?.seq ?? 0);
        tap('medium');
        // Your own message always comes into view.
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
        if (mounted.current) setTray((l) => l.filter((a) => a.state === 'failed'));
      }
      // Only the text that was sent is cleared: anything typed meanwhile stays.
      if (getDraft(bot.id) === submitted) { setDraft(bot.id, ''); if (mounted.current) setTextState(''); }
      if (edit && mounted.current) { const kept = keptDraft.current; keptDraft.current = null; setEditing((cur) => (cur === edit ? undefined : cur)); if (kept) setText(kept); }
      if (mounted.current) setReplyTo((cur) => (cur === reply ? undefined : cur));
    } catch (e: any) {
      if (mounted.current) issue.fail('Message', e instanceof Error ? new Error(`${e.message} Your message is kept.`) : e, 'The server did not answer. Your message is kept.', () => { void send(); });
    } finally { if (mounted.current) setSending(false); }
  };

  // Long chats: a button back to the newest message once you have scrolled up a way.
  const listRef = useRef<FlatList<Item>>(null);
  const [farUp, setFarUp] = useState(false);
  // Away from the newest message at all: what arrives meanwhile is counted on the button.
  const [away, setAway] = useState(false);
  const listOffset = useRef(0);
  const onListScroll = (e: any) => {
    onScroll(e);
    const y = e?.nativeEvent?.contentOffset?.y ?? 0;
    listOffset.current = y;
    if ((y > 900) !== farUp) setFarUp(y > 900);
    if ((y > 160) !== away) setAway(y > 160);
  };
  // A field in a card (a secure input, a form) that gets focus is scrolled above the keyboard with the buttons
  // under it (Fill in, Send), as much as fits; never so far that the field's own top leaves the chat.
  const listBox = useRef<React.ComponentRef<typeof View>>(null);
  const cardField = useRef<unknown>(null);
  const reveal = useCallback(() => {
    // Only a field a card registered on focus: never the message box under the chat.
    const focused: any = (TextInput as any).State?.currentlyFocusedInput?.();
    if (!focused || focused !== cardField.current || focused === input.current || typeof focused.measureInWindow !== 'function') return;
    listBox.current?.measureInWindow((_lx, ly, _lw, lh) => {
      focused.measureInWindow((_x: number, y: number, _w: number, h: number) => {
        if (!lh || !h) return;
        const top = ly + 8;
        const bottom = ly + lh - 8;
        const below = Math.max(0, Math.min(REVEAL_BELOW, bottom - top - h));
        let delta = Math.max(0, y + h + below - bottom);
        if (y - delta < top) delta = y - top;
        if (Math.abs(delta) < 4) return;
        // The list is upside down: its offset grows going up the chat, so showing what is lower means a smaller offset.
        listRef.current?.scrollToOffset({ offset: Math.max(0, listOffset.current - delta), animated: true });
      });
    });
  }, []);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealSoon = useCallback((ms = 320) => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => { revealTimer.current = null; reveal(); }, ms);
  }, [reveal]);
  // The chat shrinks above the keyboard (KeyboardSafe) and its header folds (about 180 ms) after the keyboard opens: measure after.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => revealSoon(260));
    return () => { show.remove(); if (revealTimer.current) clearTimeout(revealTimer.current); };
  }, [revealSoon]);
  const revealOnFocus = useCallback(() => {
    cardField.current = (TextInput as any).State?.currentlyFocusedInput?.() ?? null;
    revealSoon();
  }, [revealSoon]);

  const lastSeq = rows[rows.length - 1]?.seq ?? 0;
  const [seenSeq, setSeenSeq] = useState(lastSeq);
  useEffect(() => { if (!away) setSeenSeq(lastSeq); }, [away, lastSeq]);
  const newBelow = useMemo(() => (away ? rows.reduce((n, r) => n + (r.seq > seenSeq && isIncoming(r) ? 1 : 0), 0) : 0), [away, rows, seenSeq]);
  // Opened with a few unread messages that run off the top of the screen: start at the first of them.
  const wentToNew = useRef(false);
  useEffect(() => {
    if (newFrom === null || wentToNew.current || focusSeq) return;
    wentToNew.current = true;
    const i = list.findIndex((it) => (it.kind === 'row' || it.kind === 'steps') && it.fresh);
    if (i >= 4 && i <= 40) setTimeout(() => listRef.current?.scrollToIndex({ index: i, viewPosition: 1, animated: false }), 80);
  /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [newFrom]);

  // A tapped notification's (or search hit's) row: scroll to it, loading earlier pages until it is there.
  // The focus is used once: onFocused clears it, so opening this chat again later starts at the newest message
  // (until 2026-11-24 it stayed set, and every later visit opened halfway up, at an old notification's message).
  // A row that is already among the newest needs no scroll: the chat opens at the bottom, where it is.
  const focused = useRef<number | null>(null);
  // The first row held when earlier rows were last asked for: asking again with nothing new loaded is a loop.
  const triedFrom = useRef<number | null>(null);
  useEffect(() => {
    if (!focusSeq || focused.current === focusSeq || !rows.length) return;
    const i = list.findIndex((it) => (it.kind === 'row' && it.row.seq === focusSeq) || (it.kind === 'steps' && it.rows.some((r) => r.seq === focusSeq)));
    if (i >= 0) {
      focused.current = focusSeq;
      const newest = list.findIndex((it) => it.kind === 'row' || it.kind === 'steps');
      if (i > newest) setTimeout(() => listRef.current?.scrollToIndex({ index: i, viewPosition: 0.5, animated: true }), 50);
      onFocused?.();
    } else if ((rows[0]?.seq ?? 1) > focusSeq && onEarlier && !earlier && triedFrom.current !== (rows[0]?.seq ?? 1)) {
      triedFrom.current = rows[0]?.seq ?? 1;
      setEarlier(true);
      void Promise.resolve(onEarlier()).finally(() => setEarlier(false));
    } else if (!earlier) { focused.current = focusSeq; triedFrom.current = null; onFocused?.(); }
  }, [focusSeq, rows, earlier]);

  // A pinned board's Jump to message (BoardDock): scroll to its card in the chat.
  const jumpTo = (seq: number) => {
    const i = list.findIndex((it) => it.kind === 'row' && it.row.seq === seq);
    if (i >= 0) listRef.current?.scrollToIndex({ index: i, viewPosition: 0.5, animated: true });
  };
  // Rows are drawn through stable callbacks and memoized pieces, so a keystroke (or a word of a streaming
  // reply) redraws only what changed instead of every message on screen.
  const latest = useRef({ onPluginCode, onFiles, onComputer, onRefresh, takeBack });
  latest.current = { onPluginCode, onFiles, onComputer, onRefresh, takeBack };
  const stable = useMemo(() => ({
    onPluginCode: (id: string) => latest.current.onPluginCode?.(id),
    onFiles: (path?: string) => latest.current.onFiles?.(path),
    onComputer: () => latest.current.onComputer(),
    onRefresh: () => latest.current.onRefresh(),
    takeBack: (p: Pending) => latest.current.takeBack(p),
  }), []);
  const hasPluginCode = !!onPluginCode;
  const hasFiles = !!onFiles;
  const look = `${currentScheme()}:${textSize}`;
  const names = members.names;
  const renderItem = useCallback(({ item }: { item: Item }) => {
    if (item.kind === 'pending') return <View style={{ paddingTop: 12 }}><RowGuard what="message" resetKey={item.key}><PendingBubble api={api} ownerId={owner} p={item.pending} onEdit={stable.takeBack} /></RowGuard></View>;
    if (item.kind === 'working') return <RowGuard what="status line">{isGroup ? <GroupWorking api={api} bot={bot} bots={bots} /> : <Working api={api} bot={bot} rows={rows} onRefresh={stable.onRefresh} />}</RowGuard>;
    return (
      <View style={{ paddingTop: item.gap }}>
        {item.fresh && <NewLine />}
        {item.stamp && <Text style={[type.time, { alignSelf: 'center', marginBottom: 14, marginTop: 8 }]}>{dayStamp(item.createdAt)}</Text>}
        <RowGuard what={item.kind === 'steps' ? 'step list' : item.row.body.type === 'card' ? 'card' : 'message'} resetKey={item.kind === 'row' ? `${item.row.createdAt}:${(item.row.body.text ?? '').length}:${item.row.body.status ?? ''}` : String(item.rows.length)}>
          {item.kind === 'steps' ? <StepsMemo rows={item.rows} look={look} /> : <RowMemo api={api} bot={bot} ownerId={owner} bots={bots} row={item.row} onPluginCode={hasPluginCode ? stable.onPluginCode : undefined} onFiles={hasFiles ? stable.onFiles : undefined} onReply={onReply} onEdit={onEdit} names={names} onComputer={stable.onComputer} look={look} />}
        </RowGuard>
      </View>
    );
  }, [api, bot, bots, owner, isGroup, rows, names, look, onReply, onEdit, stable, hasPluginCode, hasFiles]);
  const fullButton = onFullScreen ? <RoundButton icon={fullScreen ? 'shrink' : 'expand'} label={fullScreen ? 'Show the bot list' : 'Full screen'} onPress={onFullScreen} /> : null;
  const sideButton = bot.outside ? <RoundButton icon="link" label={`Open ${bot.name} in ChatGPT`} onPress={onCall} /> : isGroup ? (fullButton ? null : <View style={{ width: 44 }} />) : simple ? <RoundButton icon="sliders" label={`${bot.name}'s settings`} onPress={() => onSettings()} /> : <RoundButton icon="monitor" label={`${bot.name}'s computer`} onPress={onComputer} />;
  const rightButtons = fullButton ? <View style={{ flexDirection: 'row', gap: 8 }}>{fullButton}{sideButton}</View> : sideButton;

  return (
    <KeyboardSafe style={{ backgroundColor: color.ground }} onKeyboard={onKeyboard}>
      {big ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }} onLayout={(e) => { const row = Math.round(e.nativeEvent.layout.width); setHeadRow((h) => (h.row === row ? h : { ...h, row })); }}>
            {onBack ? <RoundButton icon="back" label="Back" onPress={onBack} /> : <View style={{ width: 44 }} />}
            <View onLayout={(e) => { const right = Math.round(e.nativeEvent.layout.width); setHeadRow((h) => (h.right === right ? h : { ...h, right })); }}>{rightButtons}</View>
          </View>
          <Animated.View style={{ alignSelf: 'center', marginTop: avatarLift }}>
            <Pressable accessibilityRole="button" accessibilityLabel={`${bot.name}'s settings`} onPress={() => onSettings()}
              style={({ pressed }) => ({ alignItems: 'center', opacity: pressed ? 0.75 : 1 })}>
              <Animated.View style={{ width: avatar, height: avatarBox, alignItems: 'center', justifyContent: 'center' }}>
                <Animated.View style={{ transform: [{ scale: avatarScale }] }}>
                  {/* The model and effort it is using while it works (ModelBadge), on the picture at every size. */}
                  {/* Big: the whole character, so its poses show. Shrunk beside the buttons: its face (crop=head), which reads at that size. */}
                  <Animated.View style={{ opacity: bodyFade }}><BotAvatar bot={bot} size={avatar} server={api.server} auth={api.authHeader} /></Animated.View>
                  <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, opacity: faceFade }}><BotAvatar bot={bot} size={avatar} server={api.server} auth={api.authHeader} crop="portrait" /></Animated.View>
                </Animated.View>
                <View pointerEvents="box-none" style={{ position: 'absolute', left: -200, right: -200, bottom: 0, alignItems: 'center' }}>
                  <Animated.View onLayout={(e) => { const w = Math.round(e.nativeEvent.layout.width); setChipW((c) => (c === w ? c : w)); }}
                    style={{ transform: [{ translateX: chipShift }, { translateY: chipDrop }] }}>
                    <ModelBadgeInline botId={bot.id} maxWidth={chipRoom} />
                  </Animated.View>
                </View>
              </Animated.View>
              <Text numberOfLines={1} style={{ marginTop: 6, fontSize: 18, fontWeight: '600', color: color.ink }}>{bot.name}</Text>
              {bot.outside && <View style={{ alignSelf: 'center', marginVertical: 2 }}><OutsideTag bot={bot} /></View>}
              <Animated.View style={{ opacity: poseFade, height: poseHeight, overflow: 'hidden' }}><PoseLabel bot={bot} /></Animated.View>
            </Pressable>
          </Animated.View>
          {switcher}
        </View>
      ) : (
        <Header>
          {onBack && <RoundButton icon="back" label="Back" onPress={onBack} />}
          <Pressable accessibilityRole="button" accessibilityLabel={`${bot.name}'s settings`} onPress={() => onSettings()}
            style={({ pressed }) => ({ flexShrink: 1, height: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 4, paddingRight: 16, borderRadius: 26, backgroundColor: pressed ? color.pressed : color.fill })}>
            <WithModelBadge botId={bot.id}><BotAvatar bot={bot} size={avatar} server={api.server} auth={api.authHeader} crop="portrait" /></WithModelBadge>
            <View style={{ flexShrink: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 17, fontWeight: '600', color: color.ink }}>{bot.name}</Text>
                <OutsideTag bot={bot} />
              </View>
              <PoseLabel bot={bot} />
            </View>
          </Pressable>
          <View style={{ flex: 1 }} />
          {rightButtons}
        </Header>
      )}
      {!big && switcher ? <View style={{ paddingBottom: 6 }}>{switcher}</View> : null}
      <RevealFocused.Provider value={revealOnFocus}>
      <View ref={listBox} collapsable={false} style={{ flex: 1 }}>
      <Animated.FlatList
        ref={listRef as any}
        style={{ flex: 1 }}
        inverted
        // Android drops the drawn text of very tall rows (a long group reply) while scrolling an upside-down list
        // when off-screen rows are detached; keeping them attached costs little at chat sizes.
        removeClippedSubviews={false}
        onScroll={onListScroll}
        onScrollToIndexFailed={(info: { averageItemLength: number; index: number }) => listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true })}
        scrollEventThrottle={16}
        data={list}
        // Rows are drawn again when light/dark changes (their colours are read while drawing).
        extraData={look}
        // The list is upside down, so its end is the top of the chat: reaching it brings in earlier messages.
        onEndReached={() => {
          if ((rows[0]?.seq ?? 1) <= 1 || earlier || !onEarlier) return;
          setEarlier(true);
          void Promise.resolve(onEarlier()).finally(() => setEarlier(false));
        }}
        onEndReachedThreshold={0.4}
        ListFooterComponent={earlier ? <View style={{ paddingVertical: 14 }}><ActivityIndicator color={color.inkMuted} /></View>
          : earlierError && (rows[0]?.seq ?? 1) > 1 ? (
            <View style={{ paddingVertical: 12, alignItems: 'center', gap: 6 }}>
              <Text style={[type.caption, { color: color.problemInk, textAlign: 'center' }]}>Couldn't load earlier messages: {earlierError}</Text>
              {onEarlier && <PillButton title="Try again" kind="secondary" onPress={() => { setEarlier(true); void Promise.resolve(onEarlier()).finally(() => setEarlier(false)); }} />}
            </View>
          ) : undefined}
        keyExtractor={(it) => it.key}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10 }}
        keyboardShouldPersistTaps="handled"
        // The list flips its empty state itself (on Android with scale -1, elsewhere scaleY -1). A transform here
        // would replace that flip and leave the text upside down or mirrored, so none is set.
        ListEmptyComponent={loadError ? (
          <View style={{ alignItems: 'center', paddingTop: 80, gap: 14, paddingHorizontal: 24 }}>
            <Text style={[type.body, { textAlign: 'center' }]}>Couldn't load this chat.</Text>
            <Text style={[type.caption, { textAlign: 'center' }]}>{loadError}</Text>
            {onRetryLoad && <PillButton title="Try again" kind="secondary" onPress={onRetryLoad} />}
          </View>
        ) : (
          <View style={{ alignItems: 'center', paddingTop: 80, gap: 14 }}>
            {/* The big header already shows the picture; a second one under it only pushes the hint down. */}
            {!(simple && big) && <BotAvatar bot={bot} size={96} server={api.server} auth={api.authHeader} />}
            <Text style={[type.caption, { textAlign: 'center', paddingHorizontal: 32, lineHeight: 20 }]}>{isGroup ? 'A group chat. Everyone in it sees what you write; type @ to ask one bot.' : simple ? `Type or talk to ${bot.name} below. Nothing is too small to ask.` : `Ask ${bot.name} anything.`}</Text>
            {!isGroup && !bot.outside && !simple && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, paddingHorizontal: 24 }}>
                {STARTERS.map((t) => <Chip key={t} title={t} onPress={() => { setText(t); input.current?.focus(); }} />)}
              </View>
            )}
          </View>
        )}
        renderItem={renderItem}
      />
      </View>
      </RevealFocused.Provider>
      {(farUp || newBelow > 0) && (
        <Pressable accessibilityRole="button" accessibilityLabel={newBelow > 0 ? `${newBelow} new ${newBelow === 1 ? 'message' : 'messages'}. Jump to the newest` : 'Jump to the newest message'} onPress={() => { tap('light'); listRef.current?.scrollToOffset({ offset: 0, animated: true }); }}
          style={({ pressed }) => ({ position: 'absolute', right: 16, bottom: 92, minWidth: 44, height: 44, borderRadius: 22, paddingHorizontal: newBelow > 0 ? 14 : 0, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: newBelow > 0 ? color.primary : color.surface, borderWidth: newBelow > 0 ? 0 : 1, borderColor: color.secondaryBorder, opacity: pressed ? 0.8 : 1, zIndex: 2 })}>
          {newBelow > 0 && <Text style={{ fontSize: 14, fontWeight: '700', color: color.onPrimary }}>{newBelow > 99 ? '99+' : newBelow} new</Text>}
          <View style={{ transform: [{ rotate: '-90deg' }] }}><Icon name="back" size={18} color={newBelow > 0 ? color.onPrimary : color.ink} /></View>
        </Pressable>
      )}
      {!isGroup && !bot.outside && <CallBar bot={bot} onOpen={onCall} />}
      {!!bot.waitingFor?.length && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginHorizontal: 16, marginTop: 6 }}>
          {bot.waitingFor.map((w) => <WaitingChip key={w.id} name={w.name} since={w.since} />)}
        </View>
      )}
      {!!issue.problem && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 14, backgroundColor: color.problemFill }} accessibilityLiveRegion="polite">
          <Text style={[type.caption, { flex: 1, fontSize: 13, color: color.problemInk }]}>
            <Text style={{ fontWeight: '700' }}>{issue.problem.area}: </Text>{issue.problem.text}{issue.offline ? ' Waiting for the connection to come back…' : ''}
          </Text>
          {issue.problem.retry && (
            <Pressable accessibilityRole="button" accessibilityLabel={`Try ${issue.problem.area.toLowerCase()} again`} onPress={issue.retry} hitSlop={8}
              style={({ pressed }) => ({ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: pressed ? color.pressed : 'transparent' })}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: color.problemInk }}>Try again</Text>
            </Pressable>
          )}
          <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={issue.clear} hitSlop={8}><Icon name="close" size={16} color={color.problemInk} /></Pressable>
        </View>
      )}
      {linkDown && (
        <Text style={[type.caption, { fontSize: 13, marginHorizontal: 20, marginTop: 6 }]}>The Slack link to {bot.name} is {bot.outside?.status === 'paused' ? 'paused' : 'offline'}. Messages can't be sent until it is back.</Text>
      )}
      <BoardDock api={api} bot={bot} bots={bots} rows={rows} onJump={jumpTo} />
      <AllowedHere api={api} chatId={bot.id} rows={rows} />
      {editing && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginTop: 6, paddingLeft: 12, paddingVertical: 6, paddingRight: 4, borderRadius: 16, backgroundColor: color.fill }}>
          <View style={{ alignSelf: 'stretch', width: 3, borderRadius: 2, backgroundColor: color.primary }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, fontWeight: '600', color: color.inkSecondary }}>Editing your message</Text>
            <Text numberOfLines={1} style={{ fontSize: 14, color: color.inkMuted }}>Send posts the new version and marks the old one Edited.</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel edit" onPress={() => cancelEdit()} hitSlop={6}
            style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.pressed : 'transparent' })}>
            <Icon name="close" size={18} color={color.inkSecondary} />
          </Pressable>
        </View>
      )}
      {replyTo && !editing && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginTop: 6, paddingLeft: 12, paddingVertical: 6, paddingRight: 4, borderRadius: 16, backgroundColor: color.fill }}>
          <View style={{ alignSelf: 'stretch', width: 3, borderRadius: 2, backgroundColor: color.primary }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, fontWeight: '600', color: color.inkSecondary }}>Replying to {replyTo.name}</Text>
            <Text numberOfLines={1} style={{ fontSize: 14, color: color.inkMuted }}>{replyTo.excerpt.replace(/\s*\n\s*/g, ' ')}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel reply" onPress={() => setReplyTo(undefined)} hitSlop={6}
            style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.pressed : 'transparent' })}>
            <Icon name="close" size={18} color={color.inkSecondary} />
          </Pressable>
        </View>
      )}
      {text.length > MAX_TEXT * 0.9 && (
        <Text accessibilityLiveRegion="polite" style={[type.caption, { fontSize: 13, marginHorizontal: 20, marginTop: 6, color: tooLong ? color.problemInk : color.inkMuted }]}>
          {text.length.toLocaleString()} of {MAX_TEXT.toLocaleString()} characters.{tooLong ? ' Too long to send: shorten it, or attach it as a file.' : ''}
        </Text>
      )}
      <AttachTray list={tray} onRemove={(id) => setTray((l) => l.filter((a) => a.id !== id))} />
      {matches.length > 0 && (
        <MentionPicker api={api} matches={matches} onPick={pickMention} onClose={() => setDismissedAt(typed?.start ?? null)} />
      )}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 14 }}>
        {dictation.state === 'recording'
          ? <RoundButton icon="close" label="Cancel dictation" onPress={dictation.cancel} size={48} />
          : <RoundButton icon="plus" label="More" onPress={() => setMenu(true)} size={48} />}
        <View style={{ flex: 1, minHeight: 48, borderRadius: 24, backgroundColor: color.fill, flexDirection: 'row', alignItems: 'flex-end', paddingLeft: 18, paddingRight: 6 }}>
          <TextInput ref={input} {...(Platform.OS === 'web' ? { value: text } : {})} onChangeText={setText} placeholder={dictation.state === 'recording' ? 'Listening… tap the red button when you’re done' : dictation.state === 'transcribing' ? 'Writing down what you said…' : replyTo ? `Reply to ${replyTo.name}` : bot.outside ? `Message ${bot.name} via your Slack` : running && (bot.busySend ?? 'steer') === 'steer' ? `Add to what ${isGroup ? 'they’re' : `${bot.name} is`} working on…` : isGroup ? 'Message the group · @ to ask one bot' : `Ask ${bot.name}`} placeholderTextColor={color.timestamp} multiline
            editable={!dictating} selection={forceSel} onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
            style={{ flex: 1, fontSize: 16, color: color.ink, paddingTop: 12, paddingBottom: 12, maxHeight: 140 }}>
            {/* On the phone the text is children (not value) so each @mention of a member shows in bold, in the primary colour (the web preview can't). */}
            {Platform.OS === 'web' ? null : <Text>{isGroup && members.names.length && text.includes('@')
              ? mentionParts(text, members.names).map((p, i) => (p.mention ? <Text key={i} style={{ fontWeight: '700', color: color.primary }}>{p.text}</Text> : p.text))
              : text}</Text>}
          </TextInput>
          {dictating && <MicWave level={dictation.level} busy={dictation.state === 'transcribing'} />}
          <Pressable accessibilityRole="button" accessibilityLabel={dictation.state === 'recording' ? 'Stop dictation' : dictation.state === 'transcribing' ? 'Transcribing' : 'Dictate'}
            accessibilityHint="Tap to start and tap again to stop, or hold and let go" accessibilityState={{ busy: dictation.state === 'transcribing', selected: dictation.state === 'recording' }}
            disabled={dictation.state === 'transcribing'} onPressIn={dictation.onPressIn} onPressOut={dictation.onPressOut} hitSlop={4}
            style={({ pressed }) => ({ width: 36, height: 36, marginBottom: 6, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: dictation.state === 'recording' ? color.danger : pressed ? color.pressed : 'transparent' })}>
            {dictation.state === 'transcribing' ? <ActivityIndicator size="small" color={color.inkSecondary} />
              : dictation.state === 'recording' ? <Icon name="stop" size={14} color="#FFFFFF" />
              : <Icon name="mic" size={21} color={color.inkSecondary} />}
          </Pressable>
          {text.trim() || tray.length ? (
            <Pressable accessibilityRole="button" accessibilityLabel={uploading ? 'Waiting for the upload to finish' : bot.outside ? 'Send to Slack' : 'Send'} accessibilityState={{ disabled: sending || linkDown || uploading || tooLong || (!text.trim() && !ready.length), busy: sending || uploading }} disabled={sending || linkDown || uploading || tooLong || (!text.trim() && !ready.length)} onPress={send} hitSlop={6}
              style={{ width: 36, height: 36, marginBottom: 6, borderRadius: 18, backgroundColor: color.primary, alignItems: 'center', justifyContent: 'center', opacity: sending || linkDown || uploading || tooLong || (!text.trim() && !ready.length) ? 0.5 : 1 }}>
              <Icon name="send" size={19} color={color.onPrimary} strokeWidth={2.2} />
            </Pressable>
          ) : running ? (
            <Pressable accessibilityRole="button" accessibilityLabel={isGroup ? 'Stop everyone answering' : `Stop ${bot.name}`} accessibilityState={{ busy: stopping }} onPress={stop} hitSlop={6}
              style={({ pressed }) => ({ width: 36, height: 36, marginBottom: 6, borderRadius: 18, backgroundColor: color.primary, alignItems: 'center', justifyContent: 'center', opacity: stopping ? 0.5 : pressed ? 0.8 : 1 })}>
              <Icon name="stop" size={16} color={color.onPrimary} />
            </Pressable>
          ) : isGroup ? null : (
            <Pressable accessibilityRole="button" accessibilityLabel={bot.outside ? `Open ${bot.name} in ChatGPT` : inCall ? 'Back to the voice call' : 'Start voice chat'} onPress={onCall} hitSlop={6}
              style={{ width: 36, height: 36, marginBottom: 6, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: bot.outside ? 'transparent' : color.primary }}>
              <Icon name={bot.outside ? 'link' : 'voice'} size={bot.outside ? 20 : 18} color={bot.outside ? color.inkSecondary : color.onPrimary} strokeWidth={2.2} />
            </Pressable>
          )}
        </View>
      </View>
      <Sheet visible={menu} onClose={() => setMenu(false)}>
        <ScrollView style={{ maxHeight: height * 0.74 }}>
        {!bot.outside && !editing && (
          // Pictures and files go with the next message; the bot finds them in its files.
          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 8, paddingBottom: 8 }}>
            <AttachButton icon="camera" title="Camera" onPress={() => attach('camera')} />
            <AttachButton icon="image" title="Photos" onPress={() => attach('photos')} />
            <AttachButton icon="file" title="Files" onPress={() => attach('files')} />
          </View>
        )}
        {/* A group has no voice chat: its members answer in writing. */}
        {!isGroup && <SheetRow icon={bot.outside ? 'link' : 'phone'} title={bot.outside ? `Open ${bot.name} in ChatGPT` : 'Start voice chat'} onPress={() => { setMenu(false); onCall(); }} />}
        {!isGroup && !bot.outside && !simple && <SheetRow icon="monitor" title={`Show ${bot.name}'s computer`} onPress={() => { setMenu(false); onComputer(); }} />}
        {bot.outside && onExchanges && <SheetRow icon="tasks" title={`Exchanges with ${bot.name}`} onPress={() => { setMenu(false); onExchanges(); }} />}
        {!isGroup && !bot.outside && onPages && <SheetRow icon="bookmark" title={simple ? 'Lists and pages' : `${bot.name}'s pages`} onPress={() => { setMenu(false); onPages(); }} />}
        {!isGroup && !bot.outside && onFiles && <SheetRow icon="file" title={simple ? `Files ${bot.name} made` : `${bot.name}'s files`} onPress={() => { setMenu(false); onFiles(); }} />}
        {!isGroup && !bot.outside && onTasks && <SheetRow icon="tasks" title={simple ? `What ${bot.name} is working on` : `${bot.name}'s tasks`} onPress={() => { setMenu(false); onTasks(); }} />}
        {onSearch && <SheetRow icon="search" title="Search messages" onPress={() => { setMenu(false); onSearch(); }} />}
        <SheetRow icon="refresh" title="New conversation" onPress={() => { setMenu(false); startFresh(api, bot).catch((e) => Alert.alert('Could not start fresh', e?.message ?? 'Try again.')); }} />
        <SheetRow icon="sliders" title={isGroup ? 'Group settings' : `${bot.name}'s settings`} onPress={() => { setMenu(false); onSettings(); }} />
        {onHistory && <SheetRow icon="history" title="Earlier conversations" onPress={() => { setMenu(false); onHistory(); }} />}
        {rows.length > 0 && <SheetRow icon="share" title={sharing ? 'Getting the conversation ready…' : 'Share or save this conversation'} onPress={() => {
          if (sharing) return;
          setSharing(true);
          shareConversation(api, bot.id).then(() => setMenu(false), (e) => { setMenu(false); issue.fail('Conversation', e, 'The conversation could not be shared.'); }).finally(() => setSharing(false));
        }} />}
        {!isGroup && <SheetRow icon="palette" title={`Change ${bot.name}'s look`} onPress={() => { setMenu(false); onSettings('look'); }} />}
        </ScrollView>
      </Sheet>
    </KeyboardSafe>
  );
}

/** The longest message the server accepts (server MAX_TEXT). */
const MAX_TEXT = 200_000;
const STARTERS = ['What can you help me with?', 'What should I know today?', 'Help me plan my week'];

/** One of the three ways to add something to the next message, at the top of the + sheet. */
function AttachButton({ icon, title, onPress }: { icon: 'image' | 'camera' | 'file'; title: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Attach: ${title}`} onPress={onPress}
      style={({ pressed }) => ({ flex: 1, height: 76, borderRadius: 16, backgroundColor: pressed ? color.pressed : color.fill, alignItems: 'center', justifyContent: 'center', gap: 6 })}>
      <Icon name={icon} size={22} color={color.ink} />
      <Text style={{ fontSize: 14, fontWeight: '500', color: color.ink }}>{title}</Text>
    </Pressable>
  );
}

type Item =
  | { kind: 'row'; key: string; createdAt: number; row: Row; stamp?: boolean; gap?: number; fresh?: boolean }
  | { kind: 'pending'; key: string; createdAt: number; pending: Pending }
  | { kind: 'steps'; key: string; createdAt: number; rows: Row[]; stamp?: boolean; gap?: number; fresh?: boolean }
  | { kind: 'working'; key: string; createdAt: number };

type Member = Pick<Bot, 'id' | 'name' | 'label' | 'avatarShape' | 'avatarColor'> & Partial<Pick<Bot, 'avatarImageUrl' | 'outside'>>;

/** A group's members, with their pictures, for the @ picker and the mention highlight. */
function useGroupMembers(api: Client, bot: Bot): { list: Member[]; names: string[]; reload: () => void } {
  const [list, setList] = useState<Member[]>([]);
  const reload = useCallback(() => {
    // A bot's own chat (or side chat): the other bots on the team; the server passes the message on to each
    // one named (server/src/direct-mentions.ts). An outside bot's chat has no picker.
    if (bot.kind !== 'room') {
      if (bot.outside) { setList([]); return; }
      api.bots().then((all) => setList(all.bots
        .filter((b) => b.kind !== 'room' && b.id !== bot.id && b.name.toLowerCase() !== bot.name.toLowerCase())
        .map((b) => ({ id: b.id, name: b.name, label: b.label, avatarShape: b.avatarShape, avatarColor: b.avatarColor, avatarImageUrl: b.avatarImageUrl, outside: b.outside } as Member)))).catch(() => {});
      return;
    }
    Promise.all([api.roomMembers(bot.id), api.bots().catch(() => null)]).then(([r, all]) => {
      setList(r.members.map((m) => {
        const full = all?.bots.find((b) => b.id === m.id);
        return { ...m, avatarImageUrl: full?.avatarImageUrl, outside: full?.outside } as Member;
      }));
    }).catch(() => {});
  }, [api, bot.id, bot.kind, bot.name, bot.outside]);
  useEffect(reload, [reload]);
  const names = useMemo(() => list.map((m) => m.name), [list]);
  return { list, names, reload };
}

/** The group's members that fit the @name being typed, just above the message box. Tap one to put "@Name " in. */
function MentionPicker({ api, matches, onPick, onClose }: { api: Client; matches: Member[]; onPick: (name: string) => void; onClose: () => void }) {
  return (
    <View accessibilityRole="menu" accessibilityLabel="Bots to mention" style={{ marginHorizontal: 16, marginTop: 6, paddingVertical: 4, borderRadius: 18, backgroundColor: color.surface, borderWidth: 1, borderColor: color.secondaryBorder, maxHeight: 248, overflow: 'hidden' }}>
      <ScrollView keyboardShouldPersistTaps="always">
        {matches.map((m) => (
          <Pressable key={m.id} accessibilityRole="menuitem" accessibilityLabel={`Mention ${m.name}`} onPress={() => onPick(m.name)}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingLeft: 14, paddingRight: 44, paddingVertical: 6, backgroundColor: pressed ? color.pressed : 'transparent' })}>
            <BotAvatar bot={{ ...m, avatarImageUrl: m.avatarImageUrl ?? null }} size={36} server={api.server} auth={api.authHeader} still crop="portrait" />
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 16, fontWeight: '600', color: color.ink }}>{m.name}</Text>
            {(m.outside || m.label) ? <Text numberOfLines={1} style={[type.caption, { fontSize: 13, maxWidth: 120 }]}>{m.outside ? 'via Slack' : m.label}</Text> : null}
          </Pressable>
        ))}
      </ScrollView>
      <Pressable accessibilityRole="button" accessibilityLabel="Close the member list" onPress={onClose} hitSlop={8}
        style={{ position: 'absolute', top: 4, right: 4, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="close" size={14} color={color.inkSecondary} />
      </Pressable>
    </View>
  );
}

/** Your own messages (typed or spoken) are the black bubbles on the right. */
/** A bot's (or a card's) row: what "new" counts (the same rule as the web's Transcript). */
/**
 * Answered choice buttons (server/src/choices.ts) leave the chat: the tap already put the answer in the chat
 * as your message, so a second "✓ answer" chip above it only repeated it. Same rule on the web and Windows
 * apps (web/src/components/Transcript.tsx answeredChoice).
 */
const answeredChoice = (r: Row) => {
  const b: any = r.body;
  return b.type === 'card' && b.card === 'view' && !!b.quick && b.blocks?.[0]?.type === 'choice' && !!b.blocks[0].sentAt;
};
const isIncoming = (r: Row) => !answeredChoice(r) && (r.body.type === 'message' ? (r.body.role === 'assistant' || (!!r.body.from && r.body.from.kind !== 'voice')) && !r.body.streaming : r.body.type === 'card');

/** The line above the first message that arrived while you were away. */
function NewLine() {
  return (
    <View accessibilityRole="text" accessibilityLabel="New messages" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, marginBottom: 12 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: color.primary, opacity: 0.45 }} />
      <Text style={{ fontSize: 12.5, fontWeight: '700', color: color.primary }}>New</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: color.primary, opacity: 0.45 }} />
    </View>
  );
}

const isMine = (r: Row) => r.body.type === 'message' && r.body.role === 'user' && (!r.body.from || r.body.from.kind === 'voice');

function dayStamp(t: number) {
  const d = new Date(t);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return `Today ${time(t)}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time(t)}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time(t)}`;
}

/** The line above another bot's message: its face (crop=head), its name in its colour, and who it wrote to. */
function SenderLine({ api, name, sender, ink, to, via }: { api: Client; name: string; sender?: Bot; ink: ChatInk; to: string | null; via?: string }) {
  return (
    <View accessible accessibilityLabel={`From ${name}${to ? ` to ${to}` : ''}${via === 'slack' ? ', via Slack' : ''}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 5, marginLeft: 2 }}>
      <View style={{ borderRadius: 17, borderWidth: 2, borderColor: ink.bar, padding: 1 }}>
        {sender
          ? <BotAvatar bot={sender} size={28} server={api.server} auth={api.authHeader} still crop="portrait" />
          : <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: ink.tint, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 13, fontWeight: '700', color: ink.ink }}>{name.slice(0, 1).toUpperCase()}</Text></View>}
      </View>
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 14, fontWeight: '700', color: ink.ink }}>{name}</Text>
      {(to || via === 'slack') && <Text numberOfLines={1} style={[type.caption, { fontSize: 13, flexShrink: 1 }]}>{to ? `to ${to}` : ''}{via === 'slack' ? `${to ? ' · ' : ''}via Slack` : ''}</Text>}
    </View>
  );
}

function Bubble({ mine, text, from, names, ink }: { mine: boolean; text: string; from?: string; names?: string[]; ink?: ChatInk | null }) {
  const reply = mine ? splitReply(text) : null;
  const body = reply?.body ?? text;
  return (
    <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '86%', backgroundColor: mine ? color.bubbleMine : ink ? ink.tint : color.fill, borderRadius: 20, paddingVertical: 10, paddingHorizontal: 15, ...(ink ? { borderLeftWidth: 3, borderLeftColor: ink.bar, borderTopLeftRadius: 6, borderBottomLeftRadius: 6 } : null) }}>
      {!!from && <Text style={[type.caption, { fontSize: 13, fontWeight: '600', marginBottom: 2 }]}>{from}</Text>}
      {!!reply?.quote && (
        <Text numberOfLines={4} style={{ color: color.onBubbleMine, opacity: 0.75, fontSize: 14, lineHeight: 19, borderLeftWidth: 2, borderLeftColor: 'rgba(255,255,255,0.45)', paddingLeft: 9, marginBottom: 6 }}>{reply.quote}</Text>
      )}
      {mine ? <Text selectable style={{ color: color.onBubbleMine, fontSize: sized(16), lineHeight: sized(22) }}>{names?.length && body.includes('@')
        ? mentionParts(body, names).map((p, i) => (p.mention ? <Text key={i} style={{ fontWeight: '700', textDecorationLine: 'underline' }}>{p.text}</Text> : p.text))
        : body}</Text> : <Markdown text={text} />}
    </View>
  );
}

/** Reactions under a message. On a Bot's message a tap on a chip adds or takes back your reaction. */
function ReactionChips({ reactions, mine, onToggle }: { reactions?: Reaction[]; mine: boolean; onToggle?: (emoji: string) => void }) {
  const chips = reactionChips(reactions);
  if (!chips.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4, alignSelf: mine ? 'flex-end' : 'flex-start', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
      {chips.map((c) => (
        <Pressable key={c.emoji} disabled={!onToggle} onPress={() => onToggle?.(c.emoji)} accessibilityRole="button"
          accessibilityLabel={`${c.emoji} ${c.count}, from ${c.names}${onToggle ? (c.mine ? '. Tap to remove yours' : '. Tap to add yours') : ''}`}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 4, height: 32, paddingHorizontal: 10, borderRadius: 16, backgroundColor: pressed ? color.pressed : color.fill, borderWidth: c.mine ? 1.5 : 0, borderColor: color.primary })}>
          <Text style={{ fontSize: 16 }}>{c.emoji}</Text>
          {c.count > 1 && <Text style={[type.caption, { fontSize: 13, fontWeight: '600', color: color.ink }]}>{c.count}</Text>}
        </Pressable>
      ))}
    </View>
  );
}

/** The emoji picker under a Bot's message: a quick row, and "more" for the rest. */
function ReactPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [more, setMore] = useState(false);
  const btn = (e: string) => (
    <Pressable key={e} onPress={() => onPick(e)} accessibilityRole="button" accessibilityLabel={`React ${e}`} hitSlop={2}
      style={({ pressed }) => ({ width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.pressed : 'transparent' })}>
      <Text style={{ fontSize: 24 }}>{e}</Text>
    </Pressable>
  );
  return (
    <View style={{ alignSelf: 'flex-start', maxWidth: 340, marginTop: 4, padding: 6, borderRadius: 18, backgroundColor: color.fill }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
        {QUICK_REACTIONS.map(btn)}
        <Pressable onPress={() => setMore((m) => !m)} accessibilityRole="button" accessibilityLabel={more ? 'Fewer reactions' : 'More reactions'} hitSlop={2}
          style={({ pressed }) => ({ width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.pressed : 'transparent' })}>
          <Icon name={more ? 'close' : 'plus'} size={20} color={color.inkMuted} strokeWidth={1.8} />
        </Pressable>
      </View>
      {more && <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: color.hairline }}>{MORE_REACTIONS.map(btn)}</View>}
    </View>
  );
}

/** React, Copy, Share (the Android share sheet) and Reply under a Bot's message. */
function MessageActions({ text, onReply, onReactPress, reacting, voice }: { text: string; onReply: () => void; onReactPress: () => void; reacting: boolean; /** Listen: whose voice reads it, and a name for this message. */ voice?: { api: Client; botId: string; key: string } }) {
  const [copied, setCopied] = useState(false);
  const listening = useListening(voice?.key ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const [problem, setProblem] = useState<string | null>(null);
  const copy = async () => {
    setProblem(null);
    try { await Clipboard.setStringAsync(plainText(text)); } catch (e: any) { setProblem(`Couldn't copy: ${e?.message ?? 'the clipboard refused'}`); return; }
    tap('light');
    setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800);
  };
  // Closing the share sheet is not an error; a share that fails says so.
  const share = () => { setProblem(null); Share.share({ message: plainText(text) }).catch((e: any) => setProblem(`Couldn't share: ${e?.message ?? 'try again'}`)); };
  const btn = (icon: 'copy' | 'share' | 'reply' | 'check' | 'react' | 'close' | 'speaker', label: string, onPress: () => void) => (
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4}
      style={({ pressed }) => ({ width: 40, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.pressed : 'transparent' })}>
      <Icon name={icon} size={18} color={color.inkMuted} strokeWidth={1.8} />
    </Pressable>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2, marginLeft: 2 }}>
      {btn(reacting ? 'close' : 'react', reacting ? 'Close reactions' : 'React', onReactPress)}
      {btn(copied ? 'check' : 'copy', 'Copy', copy)}
      {btn('share', 'Share', share)}
      {btn('reply', 'Reply', onReply)}
      {voice && listenAvailable && (
        <Pressable accessibilityRole="button" accessibilityLabel={listening ? 'Stop reading' : 'Listen'} accessibilityState={{ busy: listening === 'loading', selected: !!listening }} hitSlop={4}
          onPress={() => { setProblem(null); tap('light'); listen(voice.api, voice.botId, voice.key, text, (m) => setProblem(`Couldn't read it aloud: ${m}`)); }}
          style={({ pressed }) => ({ width: 40, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: listening ? color.fill : pressed ? color.pressed : 'transparent' })}>
          {listening === 'loading' ? <ActivityIndicator size="small" color={color.inkMuted} />
            : listening ? <Icon name="stop" size={13} color={color.ink} />
            : <Icon name="speaker" size={18} color={color.inkMuted} strokeWidth={1.8} />}
        </Pressable>
      )}
      {copied && <Text style={[type.caption, { fontSize: 13, marginLeft: 4 }]} accessibilityLiveRegion="polite">Copied</Text>}
      {!!problem && <Text style={[type.caption, { fontSize: 13, marginLeft: 4, color: color.problemInk, flexShrink: 1 }]} accessibilityLiveRegion="polite">{problem}</Text>}
    </View>
  );
}

/** Copy and Edit under a message you typed. Copy leaves out a reply's quote; Edit puts your words back in the box. */
function OwnActions({ text, editable, onEdit }: { text: string; editable: boolean; onEdit: () => void }) {
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    setProblem(null);
    try { await Clipboard.setStringAsync(splitReply(text).body); } catch (e: any) { setProblem(`Couldn't copy: ${e?.message ?? 'the clipboard refused'}`); return; }
    tap('light');
    setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800);
  };
  const btn = (icon: 'copy' | 'check' | 'edit', label: string, onPress: () => void) => (
    <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4}
      style={({ pressed }) => ({ width: 40, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? color.pressed : 'transparent' })}>
      <Icon name={icon} size={18} color={color.inkMuted} strokeWidth={1.8} />
    </Pressable>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', marginTop: 2, marginRight: 2 }}>
      {!!problem && <Text style={[type.caption, { fontSize: 13, marginRight: 4, color: color.problemInk, flexShrink: 1 }]} accessibilityLiveRegion="polite">{problem}</Text>}
      {copied && <Text style={[type.caption, { fontSize: 13, marginRight: 4 }]} accessibilityLiveRegion="polite">Copied</Text>}
      {btn(copied ? 'check' : 'copy', 'Copy', copy)}
      {editable && btn('edit', 'Edit', onEdit)}
    </View>
  );
}

/** A finished Bot message with its reactions, the React picker, and Copy/Share/Reply. */
function BotMessage({ api, bot, row, bubble, onReply, voiceBot }: { api: Client; bot: Bot; row: Row; bubble: React.ReactNode; onReply: (to: ReplyTarget) => void; voiceBot: string }) {
  const b = row.body;
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (emoji: string) => {
    setPicking(false);
    setError(null);
    tap('select');
    api.react(bot.id, row.seq, emoji).catch((e) => setError(e instanceof Error ? e.message : 'Could not react'));
  };
  const writer = b.from?.name ?? bot.name;
  return (
    <View>
      {bubble}
      <ReactionChips reactions={b.reactions} mine={false} onToggle={toggle} />
      {picking && <ReactPicker onPick={toggle} />}
      {!!error && <Text style={[type.caption, { fontSize: 13, color: color.danger, marginTop: 2 }]}>{error}</Text>}
      <MessageActions text={b.text} voice={{ api, botId: voiceBot, key: `${bot.id}:${row.generation}:${row.seq}` }} reacting={picking} onReactPress={() => setPicking((p) => !p)} onReply={() => onReply({ name: writer, excerpt: replyExcerpt(b.text), mention: bot.kind === 'room' && b.from?.kind === 'bot' })} />
    </View>
  );
}

/** The marker under a message sent while the bot was working (server steer-mode.ts). */
const STEER_LABEL = {
  pending: 'Steering · joins the reply at the next step',
  read: 'Steering · taken into the reply',
  next: 'Steering · the reply had finished, so it was answered next',
} as const;

function RowView({ api, bot, ownerId, bots, row, onPluginCode, onFiles, onReply, onEdit, names, onComputer }: { api: Client; bot: Bot; ownerId: string; bots?: Bot[]; row: Row; onPluginCode?: (draftId: string) => void; onFiles?: (path?: string) => void; onReply?: (to: ReplyTarget) => void; onEdit?: (seq: number, text: string) => void; names?: string[]; onComputer?: () => void }) {
  const b = row.body;
  // A line from the app itself, such as "Stopped." after the Stop button.
  if (b.type === 'notice') return <Text style={[type.caption, { alignSelf: 'center', textAlign: 'center', fontSize: 13, color: b.tone === 'error' ? color.danger : color.inkMuted }]}>{b.text}</Text>;
  if (b.type === 'message') {
    const mine = isMine(row);
    const source = b.from?.kind === 'routine' ? `Routine: ${b.from.name}` : b.from?.kind === 'agent' ? `Sent by ${b.from.name} · not you` : undefined;
    // Another bot's words: its face, its name in its colour and a tinted bubble with a bar (chatColors.ts).
    const sender = b.from?.kind === 'bot' ? { from: b.from, bot: bots?.find((x) => x.id === b.from!.id) } : null;
    const ink = sender ? chatInk(sender.bot?.chatColor ?? chatColorForUnseen(sender.from.id), currentScheme()) : null;
    const bubble = (
      <View>
        {sender && ink && <SenderLine api={api} name={sender.from.name} sender={sender.bot} ink={ink} to={sender.from.to?.name ?? (bot.kind === 'room' || sender.from.id === bot.id ? null : bot.name)} via={sender.from.via} />}
        {!!b.attachments?.length && <MessageAttachments api={api} ownerId={ownerId} files={b.attachments} mine={mine} onOpenFile={onFiles} />}
        {(!!b.text || b.streaming || !b.attachments?.length) && <View style={b.editedTo ? { opacity: 0.55 } : undefined}><Bubble mine={mine} text={b.text || '…'} from={source} names={names} ink={ink} /></View>}
        <Citations list={b.citations} />
        {!b.streaming && <Text style={[type.time, { alignSelf: mine ? 'flex-end' : 'flex-start', marginTop: 3, marginHorizontal: 6 }]}>{b.from?.kind === 'voice' ? 'Spoken · ' : ''}{time(row.createdAt)}{b.editedTo ? ' · Edited, new version below' : b.editOf ? ' · Edited' : ''}</Text>}
        {!!handoffLabel(b.handoff) && <Text accessibilityHint={HANDOFF_HINT} style={[type.time, { alignSelf: mine ? 'flex-end' : 'flex-start', marginTop: 1, marginHorizontal: 6, color: color.inkMuted, fontWeight: '600' }]}>↩ {handoffLabel(b.handoff)}</Text>}
        {!!b.steer && STEER_LABEL[b.steer as keyof typeof STEER_LABEL] && <Text accessibilityHint="Sent while the bot was working. It is never an approval." style={[type.time, { alignSelf: mine ? 'flex-end' : 'flex-start', marginTop: 1, marginHorizontal: 6, color: b.steer === 'pending' ? color.timestamp : color.inkMuted, fontStyle: b.steer === 'pending' ? 'italic' : 'normal', fontWeight: '600' }]}>↪ {STEER_LABEL[b.steer as keyof typeof STEER_LABEL]}</Text>}
      </View>
    );
    // Your own typed messages (not a voice call's): Copy, and Edit unless already edited.
    if (mine && !b.from && !b.streaming && b.text?.trim() && onEdit) {
      return <View>{bubble}<ReactionChips reactions={b.reactions} mine /><OwnActions text={b.text} editable={!b.editedTo} onEdit={() => onEdit(row.seq, b.text)} /></View>;
    }
    if (mine || b.streaming || !b.text?.trim() || !onReply) return b.reactions?.length ? <View>{bubble}<ReactionChips reactions={b.reactions} mine={mine} /></View> : bubble;
    return <BotMessage api={api} bot={bot} row={row} bubble={bubble} onReply={onReply} voiceBot={b.from?.kind === 'bot' ? b.from.id : ownerId} />;
  }
  if (b.type === 'card' && b.card === 'approval' && b.postingPlan) return <PostingPlanCard api={api} bot={bot} ownerId={ownerId} body={b} />;
  if (b.type === 'card' && b.card === 'approval' && b.secret) return <SecretCard api={api} body={b} />;
  if (b.type === 'card' && b.card === 'approval' && b.vault) return <VaultCard api={api} body={b} />;
  if (b.type === 'card' && b.card === 'approval' && b.purchase) return <PurchaseCard api={api} body={b} />;
  if (b.type === 'card' && b.card === 'approval' && b.screenHelp) return <ScreenHelpCard api={api} body={b} onComputer={onComputer} />;
  if (b.type === 'card' && b.card === 'approval') return <ApprovalCard api={api} body={b} />;
  if (b.type === 'card' && b.card === 'question') return <QuestionCard api={api} bot={bot} row={row} />;
  if (b.type === 'card' && b.card === 'connect') return <ConnectCard api={api} bot={bot} row={row} />;
  if (b.type === 'card' && b.card === 'draft') return <DraftCard api={api} body={b} />;
  if (b.type === 'card' && b.card === 'look') return <LookCard api={api} bot={bot} row={row} />;
  if (b.type === 'card' && b.card === 'look-reveal') return <LookReveal api={api} bot={bot} row={row} />;
  if (b.type === 'card' && b.card === 'skill-proposal') return <SkillProposalCard api={api} bot={bot} row={row} />;
  if (b.type === 'card' && b.card === 'plugin-plan') return <PluginPlanCard api={api} body={b} />;
  if (b.type === 'card' && b.card === 'plugin-review') return <PluginReviewCard api={api} body={b} onCode={onPluginCode} />;
  if (b.type === 'card' && b.card === 'plugin') return <PluginView body={b} />;
  if (b.type === 'card' && b.card === 'files') return <FileChips files={b.files ?? []} onOpen={(p) => onFiles?.(p)} onDownload={bot.outside ? undefined : (p) => downloadToPhone(api, ownerId, p).then(() => undefined, (e: any) => { Alert.alert('Couldn’t download it', e?.message ?? 'Something went wrong.'); })} />;
  if (b.type === 'card' && b.card === 'view') return <ViewCard api={api} bot={bot} row={row} onOpenPage={onFiles ? (p) => onFiles(p) : undefined} />;
  if (b.type === 'card') return (
    <CardShell title={b.title ?? 'A card from ' + bot.name}>
      <Text style={type.caption}>Open the web app to answer this one.</Text>
    </CardShell>
  );
  return null;
}

/**
 * An approval card. The buttons name the action; the answer is sent with the card's digest so it
 * can only approve what is shown here, and the server's read-back is shown afterwards. "Always allow"
 * shows when the server offers it (it covers this bot and these tools only); for a risky tool the card
 * shows the server's one-line warning next to it.
 */
function ApprovalCard({ api, body }: { api: Client; body: any }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pending = body.status === 'pending';
  const decide = async (decision: 'allow' | 'always' | 'conversation' | 'deny') => {
    if (!body.digest) { setNote('This card is too old to answer. Ask for a new card.'); return; }
    setBusy(true);
    setNote(null);
    try {
      const { approval } = await api.approve(body.approvalId, decision, body.digest);
      tap(decision === 'deny' ? 'light' : 'success');
      const said = body.mail ? (approval.status === 'denied' ? 'Not sent' : 'Sending') : body.handoff ? (approval.status === 'denied' ? 'Not done' : 'Done by you') : approval.status === 'always' ? 'Always allowed' : approval.status === 'conversation' ? 'Allowed for this conversation' : approval.status === 'allowed' ? 'Allowed' : 'Not allowed';
      setNote(`${said} at ${time(approval.resolvedAt ?? Date.now())}${approval.status === 'always' ? '. Undo it in this bot\'s settings.' : approval.status === 'conversation' ? '. Turn it off above the message box.' : ''}`);
    } catch (e: any) {
      setNote(e?.data?.code === 'not_rememberable' || e?.data?.code === 'agent_session' ? e.message : e?.data?.approval ? `Nothing changed: already ${e.data.approval.status}.` : e?.message ?? 'Something went wrong.');
    } finally { setBusy(false); }
  };
  const mail = body.mail;
  const done = mail
    ? body.status === 'denied' ? 'Not sent' : body.status === 'expired' ? 'Expired, not sent' : body.sendResult ? (body.sendResult.ok ? 'Sent' : `Send failed: ${body.sendResult.detail}`) : 'Send pressed'
    : body.handoff ? { allowed: 'You did it yourself', denied: 'Not done', expired: 'Expired' }[body.status as string]
    : body.status === 'conversation' && body.convOff ? 'Allowed for this conversation, then turned off'
    : { allowed: 'Allowed', always: 'Always allowed', conversation: 'Allowed for this conversation', denied: 'Not allowed', expired: 'Expired' }[body.status as string];
  const tools: string[] = body.tools ?? [];
  const many = tools.length > 1;
  const handoff = !!body.handoff;
  return (
    <CardShell title={body.title} icon={cardIcon(body)} sub={appLine(body)}>
      {!!body.kindName && !mail && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <View style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, backgroundColor: color.fill }}>
            <Text style={{ fontSize: 13, fontWeight: '600', color: color.ink }}>{body.kindName}</Text>
          </View>
          {!!body.kindSays && !handoff && !String(body.detail ?? '').includes(body.kindSays) && <Text style={[type.caption, { flexShrink: 1 }]}>{body.kindSays}</Text>}
        </View>
      )}
      {!!mail && <MailView mail={mail} />}
      {many && !mail && (
        <Text selectable style={{ fontSize: 16, lineHeight: 23, color: color.ink }}>
          {tools.map((tool) => `• ${tool}`).join('\n')}
        </Text>
      )}
      {!!body.detail && (
        <View style={{ backgroundColor: color.surface, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 }}>
          <Text selectable style={{ fontSize: 16, lineHeight: 23, color: color.ink }}>{body.detail}</Text>
        </View>
      )}
      {!mail && <ArgsDetails args={body.args} />}
      {pending ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <PillButton title={mail ? 'Send' : handoff ? 'I did it myself' : 'Allow once'} disabled={busy} onPress={() => decide('allow')} style={{ flex: 1 }} />
            <PillButton title={mail ? 'Don\'t send' : handoff ? 'Don\'t do it' : 'Deny'} kind="secondary" disabled={busy} onPress={() => decide('deny')} style={{ flex: 1 }} />
          </View>
          {/* "Allow for this conversation" (server/src/conversation-allows.ts): only where the server offered it. */}
          {body.canAlways === true && body.canConversation === true && !mail && !handoff && (
            <PillButton title="Allow for this conversation" kind="secondary" disabled={busy} onPress={() => decide('conversation')} />
          )}
          {body.canAlways === true && !mail && !handoff && (
            <PillButton title={many ? 'Always allow all' : 'Always allow'} kind="secondary" disabled={busy} onPress={() => decide('always')} />
          )}
          {!!body.alwaysNote && <Text style={[type.caption, { color: color.danger }]}>⚠ {body.alwaysNote}</Text>}
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {(body.status === 'allowed' || body.status === 'always' || body.status === 'conversation') && (!mail || body.sendResult?.ok) && <Icon name="check" size={16} color={color.inkMuted} />}
          <Text style={type.caption}>{done ?? body.status}{body.answeredBy && body.status !== 'expired' ? ` by ${body.answeredBy}${body.answeredVia ? ` · ${body.answeredVia}` : ''}` : ''}</Text>
        </View>
      )}
      {note && <Text style={type.caption}>{note}</Text>}
    </CardShell>
  );
}

const hostOf = (origin: string) => { try { return new URL(origin).host; } catch { return origin; } };
const answeredLine = (body: any) => body.answeredBy && body.status !== 'expired' ? ` by ${body.answeredBy}${body.answeredVia ? ` · ${body.answeredVia}` : ''}` : '';

/** The site a browser card is about, in big type so a look-alike domain stands out. */
function SiteLine({ origin, frameOrigin }: { origin: string; frameOrigin?: string }) {
  const https = origin.startsWith('https://');
  return (
    <View style={{ gap: 2 }}>
      <Text selectable style={{ fontSize: 20, fontWeight: '600', color: color.ink }}>{hostOf(origin)}</Text>
      <Text style={[type.caption, !https && { color: color.danger }]}>{https ? 'Secure page' : 'Not https'}{frameOrigin ? ` · field in a frame from ${frameOrigin}` : ''}</Text>
    </View>
  );
}

function CardRow({ label, value, lines }: { label: string; value?: string | null; lines?: number }) {
  if (!value) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <Text style={[type.caption, { width: 72 }]}>{label}</Text>
      <Text selectable numberOfLines={lines} style={{ flex: 1, fontSize: 15, lineHeight: 21, color: color.ink }}>{value}</Text>
    </View>
  );
}

/**
 * A secure input card (server/src/browser-cards.ts): the person types a password, code or card detail; the
 * server types it into that field of the bot's browser. A password field (no keyboard learning or
 * suggestions); the value is cleared from the card as soon as it is sent and never put on the clipboard.
 */
function SecretCard({ api, body }: { api: Client; body: any }) {
  const s = body.secret;
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // While typing, the bot's reason folds to two lines so the field and its buttons fit above the keyboard.
  const [typing, setTyping] = useState(false);
  const revealOnFocus = useRevealOnFocus();
  const pending = body.status === 'pending';
  const fill = async () => {
    if (!value || !body.digest) return;
    const v = value;
    setValue(''); setBusy(true); setNote(null);
    try { await api.secretInput(body.approvalId, v, body.digest, save && !!s.canSave); setNote('Sent to the page.'); }
    catch (e: any) { setNote(e?.data?.approval ? `Nothing changed: already ${e.data.approval.status}.` : e?.message ?? 'Something went wrong.'); }
    finally { setBusy(false); }
  };
  const deny = async () => {
    setBusy(true); setNote(null);
    try { await api.approve(body.approvalId, 'deny', body.digest); } catch (e: any) { setNote(e?.message ?? 'Something went wrong.'); } finally { setBusy(false); }
  };
  const done = body.status === 'denied' ? 'Not filled' : body.status === 'expired' ? 'Expired' : s.result ? (s.result.ok ? 'Filled' : `Not filled: ${s.result.detail}`) : 'Filling…';
  return (
    <CardShell title={body.title} icon={cardIcon(body)}>
      {s.kind === 'service_key' ? <Text style={{ fontSize: 19, fontWeight: '600', color: color.ink }}>{s.site}</Text> : <SiteLine origin={s.origin} frameOrigin={s.frameOrigin} />}
      <CardRow label="Field" value={s.fieldLabel} />
      {!!s.why && <CardRow label="For" value={`${s.why} (the bot's words)`} lines={typing && pending ? 2 : undefined} />}
      {pending ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <TextInput
              value={value} onChangeText={setValue} placeholder={s.kindLabel} placeholderTextColor={color.inkMuted}
              secureTextEntry={s.masked && !show} autoCorrect={false} autoCapitalize="none" spellCheck={false}
              autoComplete={s.kind === 'one_time_code' ? 'sms-otp' : 'off'} importantForAutofill={s.kind === 'one_time_code' ? 'yes' : 'no'}
              keyboardType={s.numeric ? 'number-pad' : s.kind === 'email' ? 'email-address' : 'default'} maxLength={s.kind === 'service_key' ? 8192 : 512}
              accessibilityLabel={`${s.kindLabel} for ${s.site}`} editable={!busy} onSubmitEditing={fill}
              onFocus={() => { setTyping(true); revealOnFocus(); }} onBlur={() => setTyping(false)}
              style={{ flex: 1, minWidth: 0, fontSize: 17, color: color.ink, backgroundColor: color.surface, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 }}
            />
            {s.masked && (
              <Pressable onPress={() => setShow(!show)} accessibilityRole="button" accessibilityLabel={show ? 'Hide what you typed' : 'Show what you typed'} hitSlop={8} style={{ paddingHorizontal: 6, paddingVertical: 8 }}>
                <Text style={{ fontSize: 15, fontWeight: '500', color: color.link }}>{show ? 'Hide' : 'Show'}</Text>
              </Pressable>
            )}
          </View>
          {!!s.canSave && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Switch value={save} onValueChange={setSave} disabled={busy} accessibilityLabel={`Save to my logins for ${s.site}`} />
              <Text style={[type.caption, { flex: 1, color: color.ink }]}>Save to my logins for {s.site}</Text>
            </View>
          )}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <PillButton title="Fill in" disabled={busy || !value} onPress={fill} style={{ flex: 1 }} />
            <PillButton title="Don't fill" kind="secondary" disabled={busy} onPress={deny} style={{ flex: 1 }} />
          </View>
          <Text style={type.caption}>{s.kind === 'service_key' ? 'Paste the whole key file. Goes straight to your server; the bot never sees it.' : 'Goes straight into the page. The bot never sees it.'}</Text>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {body.status === 'allowed' && s.result?.ok !== false && <Icon name="check" size={16} color={color.inkMuted} />}
          <Text style={type.caption}>{done}{answeredLine(body)}</Text>
        </View>
      )}
      {note && <Text style={type.caption}>{note}</Text>}
    </CardShell>
  );
}

/**
 * A saved-login card (server/src/vault.ts), as on the web: a bot asks to sign in with a login someone saved.
 * Only that person's sign-in gets Sign in (the server checks too); the server types it into the page.
 */
function VaultCard({ api, body }: { api: Client; body: any }) {
  const v = body.vault;
  const scoped = useScopedSignIn();
  const mine = !!v.forScoped === scoped;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pending = body.status === 'pending';
  const act = async (f: () => Promise<unknown>) => {
    if (!body.digest) return;
    setBusy(true); setNote(null);
    try { await f(); } catch (e: any) { setNote(e?.data?.approval ? `Nothing changed: already ${e.data.approval.status}.` : e?.message ?? 'Something went wrong.'); } finally { setBusy(false); }
  };
  const what = v.fields.length === 2 ? 'username and password' : v.fields[0];
  const done = body.status === 'denied' ? 'Not signed in' : body.status === 'expired' ? 'Expired' : v.result ? (v.result.ok ? v.result.detail : `Not filled: ${v.result.detail}`) : 'Filling…';
  return (
    <CardShell title={body.title} icon={cardIcon(body)}>
      <SiteLine origin={v.origin} frameOrigin={v.frameOrigin} />
      <CardRow label="Login" value={`${v.label}${v.userHint ? ` · ${v.userHint}` : ''}${v.savedSite !== v.site ? ` (saved for ${v.savedSite})` : ''}`} />
      <CardRow label="Fills" value={`The ${what}${v.fieldLabels?.length ? ` ("${v.fieldLabels.join('", "')}")` : ''}`} />
      {!!v.why && <CardRow label="For" value={`${v.why} (the bot's words)`} />}
      {!!v.connectorFirst && <Text style={[type.caption, { color: color.danger }]}>This is a mail, calendar or money site. Bots use the connected app for this. Sign in only if no connected app covers it, not because one failed.</Text>}
      {pending ? (
        <View style={{ gap: 8 }}>
          {mine ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <PillButton title="Sign in" disabled={busy} onPress={() => act(() => api.useSavedLogin(body.approvalId, body.digest))} style={{ flex: 1 }} />
              <PillButton title="Don't sign in" kind="secondary" disabled={busy} onPress={() => act(() => api.approve(body.approvalId, 'deny', body.digest))} style={{ flex: 1 }} />
            </View>
          ) : (
            <>
              <Text style={type.caption}>This is {v.owner}'s login. Only {v.owner} can press Sign in.</Text>
              <PillButton title="Don't sign in" kind="secondary" disabled={busy} onPress={() => act(() => api.approve(body.approvalId, 'deny', body.digest))} />
            </>
          )}
          <Text style={type.caption}>The app types it into the page. The bot never sees it.</Text>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {body.status === 'allowed' && v.result?.ok !== false && <Icon name="check" size={16} color={color.inkMuted} />}
          <Text style={type.caption}>{done}{answeredLine(body)}</Text>
        </View>
      )}
      {note && <Text style={type.caption}>{note}</Text>}
    </CardShell>
  );
}

const PLATFORM_NAME: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', x: 'X', tiktok: 'TikTok', linkedin: 'LinkedIn', threads: 'Threads' };
const planDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * A posting plan card (server/src/posting.ts), as on the web: each day's video, cover and posts with a switch
 * per day; one press approves exactly the days left on. Tap a post to read its whole caption.
 */
function PostingPlanCard({ api, bot, ownerId, body }: { api: Client; bot: Bot; ownerId: string; body: any }) {
  const plan = body.postingPlan;
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(plan.days.map((d: any) => [d.date, true])));
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pending = body.status === 'pending';
  const days = plan.days.filter((d: any) => on[d.date]).map((d: any) => d.date as string);
  const posts = plan.days.filter((d: any) => on[d.date]).reduce((n: number, d: any) => n + d.posts.length, 0);
  const approved = new Set<string>(plan.result?.days ?? []);
  const answer = async (d: 'allow' | 'always' | 'deny') => {
    if (!body.digest) return;
    setBusy(true); setNote(null);
    try { if (d === 'deny') await api.approve(body.approvalId, 'deny', body.digest); else await api.postingPlan(body.approvalId, days, d, body.digest); }
    catch (e: any) { setNote(e?.data?.approval ? `Nothing changed: already ${e.data.approval.status}.` : e?.message ?? 'Something went wrong.'); }
    finally { setBusy(false); }
  };
  const until = new Date(plan.expires).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const done = body.status === 'denied' ? 'Not approved' : body.status === 'expired' ? 'Expired, nothing approved' : plan.result ? `Approved ${plan.result.days.map(planDay).join(', ')}${body.status === 'always' ? ' (Always allow)' : ''}` : 'Approved';
  return (
    <CardShell title={body.title} icon={cardIcon(body)}>
      <Text style={type.caption}>Each post is locked to its exact caption and video. Switch off any day you don't want.</Text>
      {!!plan.why && <Text style={type.caption}>{plan.why} (the bot's words)</Text>}
      {plan.days.map((d: any) => {
        const live = pending ? !!on[d.date] : approved.has(d.date);
        return (
          <View key={d.date} style={{ borderWidth: 1, borderColor: color.hairline, borderRadius: 14, padding: 12, gap: 6, opacity: live ? 1 : 0.5 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {pending
                ? <Switch value={!!on[d.date]} disabled={busy} onValueChange={(v) => setOn({ ...on, [d.date]: v })} accessibilityLabel={`Post on ${planDay(d.date)}`} />
                : <Text style={[type.caption, { width: 28, textAlign: 'center', fontWeight: '700' }]}>{live ? '✓' : '–'}</Text>}
              <Text style={{ flex: 1, fontSize: 16, color: color.ink }}><Text style={{ fontWeight: '700' }}>{planDay(d.date)}</Text>{d.label ? ` · ${d.label}` : ''}</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              {d.cover?.ok && <Image source={{ uri: api.fileRawUrl(ownerId, d.cover.path), headers: api.authHeader }} style={{ width: 40, height: 70, borderRadius: 6, backgroundColor: color.surface }} />}
              <View style={{ flex: 1 }}>
                {d.video && <Text style={type.caption}>🎬 {d.video.name}{d.video.ok ? ` · ${(d.video.size / 1e6).toFixed(1)} MB` : ''}</Text>}
                {d.cover && <Text style={type.caption}>🖼 {d.cover.name}</Text>}
              </View>
            </View>
            {(d.warnings ?? []).map((w: string) => <Text key={w} style={[type.caption, { color: color.danger }]}>⚠ {w}</Text>)}
            {d.posts.map((p: any, i: number) => {
              const k = `${d.date}:${i}`;
              return (
                <Pressable key={k} onPress={() => setOpen(open === k ? null : k)} accessibilityRole="button" accessibilityState={{ expanded: open === k }} style={{ paddingVertical: 6, borderTopWidth: 1, borderTopColor: color.hairline, gap: 2 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: color.ink }}>{PLATFORM_NAME[p.platform] ?? p.platform}{p.kind !== 'post' ? ` ${p.kind}` : ''} <Text style={type.caption}>· {p.time}</Text></Text>
                  <Text selectable numberOfLines={open === k ? undefined : 2} style={{ fontSize: 14, lineHeight: 20, color: color.ink, textDecorationLine: live ? 'none' : 'line-through' }}>{p.title ? `${p.title}. ` : ''}{p.caption}</Text>
                </Pressable>
              );
            })}
          </View>
        );
      })}
      {pending ? (
        <View style={{ gap: 8 }}>
          <PillButton title={days.length ? `Approve ${days.length} ${days.length === 1 ? 'day' : 'days'} · ${posts} ${posts === 1 ? 'post' : 'posts'}` : 'No days on'} disabled={busy || !days.length} onPress={() => answer('allow')} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {body.canAlways && <PillButton title="Always allow" kind="secondary" disabled={busy || !days.length} onPress={() => answer('always')} style={{ flex: 1 }} />}
            <PillButton title="Don't post" kind="secondary" disabled={busy} onPress={() => answer('deny')} style={{ flex: 1 }} />
          </View>
          <Text style={type.caption}>Good until {until}. A changed caption is held; a changed video or cover cancels its day.</Text>
          {body.canAlways && !!body.alwaysNote && <Text style={[type.caption, { color: color.danger }]}>⚠ {body.alwaysNote}</Text>}
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {(body.status === 'allowed' || body.status === 'always') && <Icon name="check" size={16} color={color.inkMuted} />}
          <Text style={type.caption}>{done}{answeredLine(body)}</Text>
        </View>
      )}
      {note && <Text style={type.caption}>{note}</Text>}
    </CardShell>
  );
}

/** A purchase card: the checkout as the server read it from the page. Approve arms one purchase at that total. */
function PurchaseCard({ api, body }: { api: Client; body: any }) {
  const p = body.purchase;
  const pg = p.page;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pending = body.status === 'pending';
  const decide = async (d: 'allow' | 'deny') => {
    if (!body.digest) return;
    setBusy(true); setNote(null);
    try { await api.approve(body.approvalId, d, body.digest); }
    catch (e: any) { setNote(e?.data?.approval ? `Nothing changed: already ${e.data.approval.status}.` : e?.message ?? 'Something went wrong.'); }
    finally { setBusy(false); }
  };
  const said = [p.botSays.amount && `${p.botSays.amount} ${p.botSays.currency}`.trim(), p.botSays.merchant, (p.botSays.items ?? []).join(', '), p.botSays.why].filter(Boolean).join(' · ');
  const done = body.status === 'denied' ? 'Not bought' : body.status === 'expired' ? 'Expired, not bought' : p.result && !p.result.ok ? `Not armed: ${p.result.detail}` : 'Approved';
  return (
    <CardShell title={body.title} icon={cardIcon(body)}>
      <Text selectable style={{ fontSize: 30, fontWeight: '700', color: color.ink }}>{pg.total ? pg.total.text : 'Total not read'}{pg.total ? <Text style={type.caption}> {pg.total.currency}</Text> : null}</Text>
      <SiteLine origin={pg.origin} />
      <CardRow label="Paid to" value={pg.site} />
      <CardRow label="Pay with" value={pg.card ? `${pg.card.brand}${pg.card.last4 ? ` ending ${pg.card.last4}` : ''}` : 'Not shown on the page'} />
      <CardRow label="Items" value={(pg.items ?? []).join('\n')} />
      <CardRow label="Shipping" value={pg.shipping} />
      <CardRow label="Ship to" value={pg.shipTo} />
      <CardRow label="Repeats" value={pg.recurring ? `Yes: ${pg.recurring}` : ''} />
      {!!said && <Text style={type.caption}>The bot says: {said}</Text>}
      {(p.warnings ?? []).map((w: string) => <Text key={w} style={[type.caption, { color: color.danger }]}>⚠ {w}</Text>)}
      {pending ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <PillButton title="Approve" disabled={busy} onPress={() => decide('allow')} style={{ flex: 1 }} />
            <PillButton title="Don't buy" kind="secondary" disabled={busy} onPress={() => decide('deny')} style={{ flex: 1 }} />
          </View>
          <Text style={type.caption}>The bot may press pay once, within 3 minutes, at exactly this total. If anything changes it has to ask again.</Text>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {body.status === 'allowed' && p.result?.ok !== false && <Icon name="check" size={16} color={color.inkMuted} />}
          <Text style={type.caption}>{done}{answeredLine(body)}</Text>
        </View>
      )}
      {note && <Text style={type.caption}>{note}</Text>}
    </CardShell>
  );
}

/** A needs-you card: a CAPTCHA or passkey on the bot's screen. Opens the screen; Done lets the bot carry on. */
function ScreenHelpCard({ api, body, onComputer }: { api: Client; body: any; onComputer?: () => void }) {
  const h = body.screenHelp;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pending = body.status === 'pending';
  const decide = async (d: 'allow' | 'deny') => {
    setBusy(true); setNote(null);
    try { await api.approve(body.approvalId, d, body.digest); } catch (e: any) { setNote(e?.message ?? 'Something went wrong.'); } finally { setBusy(false); }
  };
  return (
    <CardShell title={body.title} icon={cardIcon(body)}>
      {!!h.note && <Text style={[type.body, { fontSize: 15 }]}>{h.note}</Text>}
      {pending ? (
        <View style={{ gap: 8 }}>
          {onComputer && <PillButton title="Open the screen" kind="secondary" onPress={onComputer} />}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <PillButton title="Done" disabled={busy} onPress={() => decide('allow')} style={{ flex: 1 }} />
            <PillButton title="Skip" kind="secondary" disabled={busy} onPress={() => decide('deny')} style={{ flex: 1 }} />
          </View>
        </View>
      ) : (
        <Text style={type.caption}>{body.status === 'allowed' ? 'Done' : body.status === 'denied' ? 'Skipped' : 'Expired'}</Text>
      )}
      {note && <Text style={type.caption}>{note}</Text>}
    </CardShell>
  );
}

function QuestionCard({ api, bot, row }: { api: Client; bot: Bot; row: Row }) {
  const b = row.body;
  const { busy, note, run } = useRun();
  return (
    <CardShell>
      <Text style={type.body}>{b.question}</Text>
      {b.status === 'pending' ? (
        <View style={{ gap: 8 }}>
          {(b.options ?? []).map((o: string) => <PillButton key={o} title={o} kind="secondary" disabled={busy} onPress={() => run(() => api.answer(bot.id, row, o))} />)}
          <PillButton title="Skip" kind="secondary" disabled={busy} onPress={() => run(() => api.dismiss(bot.id, row))} />
        </View>
      ) : (
        <Text style={type.caption}>{b.status === 'answered' ? `Answered: ${b.answer}` : 'Skipped'}</Text>
      )}
      {note && <Text style={[type.caption, { color: color.problemInk }]}>{note}</Text>}
    </CardShell>
  );
}

/**
 * A bot asks to connect an app (as on the web): Connect opens the app's sign-in in the browser, tied to
 * this card so it updates once connected; Skip tells the bot to go on without it.
 */
function ConnectCard({ api, bot, row }: { api: Client; bot: Bot; row: Row }) {
  const b = row.body;
  const { busy, note, run } = useRun();
  const [opened, setOpened] = useState(false);
  const name = b.toolkitName ?? b.toolkit;
  return (
    <CardShell title={`Connect ${name}`} icon={appIcon(b.toolkit ?? '', name ?? '') ?? undefined}>
      {!!b.reason && <Text style={[type.body, { fontSize: 15 }]}>{b.reason}</Text>}
      {b.status === 'pending' ? (
        <View style={{ gap: 8 }}>
          <PillButton title={opened ? 'Open the sign-in again' : 'Connect'} disabled={busy} onPress={() => run(async () => {
            const { redirectUrl } = await api.connectApp(b.toolkit, bot.id, row.seq);
            const u = safeLink(redirectUrl);
            if (!u) throw new Error('The sign-in address was not a web link.');
            await Linking.openURL(u);
            setOpened(true);
          })} />
          <PillButton title="Skip" kind="secondary" disabled={busy} onPress={() => run(() => api.dismiss(bot.id, row))} />
          {opened && <Text style={type.caption}>Finish signing in on the page that opened. This card changes to Connected when it is done.</Text>}
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name={b.status === 'connected' ? 'check' : 'close'} size={15} color={color.inkMuted} />
          <Text style={type.caption}>{b.status === 'connected' ? `${name} connected` : 'Skipped'}</Text>
        </View>
      )}
      {note && <Text style={[type.caption, { color: color.problemInk }]}>{note}</Text>}
    </CardShell>
  );
}

/**
 * An older draft card (bots now send email only through a full-email card). Shown read-only with
 * Copy and Discard; sending it again means asking the bot, which makes a new email card to check.
 */
function DraftCard({ api, body }: { api: Client; body: any }) {
  const { busy, note, run } = useRun();
  const [copied, setCopied] = useState(false);
  const channel = body.channel === 'email' ? 'Email' : body.channel === 'slack' ? 'Slack message' : 'Message';
  return (
    <CardShell title={`${channel} draft`}>
      <View style={{ backgroundColor: color.surface, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, gap: 4 }}>
        {!!body.to && <Text selectable style={{ fontSize: 15, color: color.ink }}><Text style={{ color: color.inkMuted }}>To  </Text>{body.to}</Text>}
        {!!body.subject && <Text selectable style={{ fontSize: 15, color: color.ink }}><Text style={{ color: color.inkMuted }}>Subject  </Text>{body.subject}</Text>}
        <Text selectable style={{ fontSize: 16, lineHeight: 23, color: color.ink, marginTop: 6 }}>{body.text || '(empty)'}</Text>
      </View>
      <PillButton title={copied ? 'Copied' : 'Copy'} kind="secondary" onPress={() => run(async () => { await Clipboard.setStringAsync(body.text ?? ''); setCopied(true); })} />
      {body.status === 'pending' ? (
        <>
          <PillButton title="Discard" kind="secondary" disabled={busy || !body.digest} onPress={() => run(() => api.approve(body.approvalId, 'deny', body.digest))} />
          <Text style={type.caption}>To send it, ask the bot again: it shows the whole email on a new card for you to send.</Text>
        </>
      ) : <Text style={type.caption}>{body.status === 'sent' ? 'Sent' : 'Discarded'}</Text>}
      {note && <Text style={[type.caption, { color: color.problemInk }]}>{note}</Text>}
    </CardShell>
  );
}

/** "Waiting for Sheldon · 2m 10s" while a message to an outside member has no answer yet (as on the web). */
function WaitingChip({ name, since }: { name: string; since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return (
    <View accessibilityLabel={`Waiting for ${name}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: color.fill }}>
      <Dots />
      <Text style={[type.caption, { fontSize: 13, color: color.inkSecondary }]}>Waiting for {name} · {ago(now - since)}</Text>
    </View>
  );
}

/** Sources a bot gave for its answer: web links only, opened in the browser. */
function Citations({ list }: { list?: { url: string; title?: string }[] }) {
  const items: { url: string; title?: string }[] = [];
  for (const c of list ?? []) { const url = safeLink(c.url); if (url) items.push({ url, title: c.title }); }
  if (!items.length) return null;
  return (
    <View style={{ alignSelf: 'flex-start', maxWidth: '86%', marginTop: 6, gap: 4 }}>
      <Text style={[type.caption, { fontSize: 12, fontWeight: '600' }]}>Sources</Text>
      {items.slice(0, 8).map((c, i) => (
        <Text key={i} numberOfLines={1} accessibilityRole="link" onPress={() => Linking.openURL(c.url).catch(() => toast("Couldn't open that link."))} style={{ fontSize: 13, color: color.link, textDecorationLine: 'underline' }}>
          {i + 1}. {c.title || c.url.replace(/^https?:\/\//, '')}
        </Text>
      ))}
    </View>
  );
}

/**
 * A group member's proposed group skill (server/src/agent/rooms.ts). Only a person's Save stores it,
 * as shown or as edited here; every member then reads it in this group.
 */
function SkillProposalCard({ api, bot, row }: { api: Client; bot: Bot; row: Row }) {
  const revealOnFocus = useRevealOnFocus();
  const b = row.body;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState<string>(b.name ?? '');
  const [description, setDescription] = useState<string>(b.description ?? '');
  const [steps, setSteps] = useState<string>(b.body ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const field = { borderRadius: 14, backgroundColor: color.surface, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: color.ink } as const;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setNote(null);
    try { await fn(); } catch (e: any) { setNote(e?.message ?? 'Something went wrong.'); } finally { setBusy(false); }
  };
  return (
    <CardShell title={`${b.fromBotName ?? 'A member'} proposes a group skill`}>
      {editing ? (
        <View style={{ gap: 8 }}>
          <TextInput value={name} onChangeText={setName} onFocus={revealOnFocus} maxLength={80} style={field} accessibilityLabel="Skill name" />
          <TextInput value={description} onChangeText={setDescription} onFocus={revealOnFocus} maxLength={300} placeholder="When to use it" placeholderTextColor={color.timestamp} style={field} accessibilityLabel="When to use it" />
          <TextInput value={steps} onChangeText={setSteps} onFocus={revealOnFocus} multiline style={[field, { minHeight: 160, textAlignVertical: 'top' }]} accessibilityLabel="Steps" />
        </View>
      ) : (
        <View style={{ gap: 6 }}>
          <Text style={[type.body, { fontWeight: '600' }]}>{b.name}</Text>
          {!!b.description && <Text style={[type.caption, { fontSize: 14 }]}>{b.description}</Text>}
          <Text selectable numberOfLines={14} style={{ fontFamily: 'monospace', fontSize: 13, lineHeight: 19, color: color.ink, padding: 10, borderRadius: 12, backgroundColor: color.surface }}>{b.body}</Text>
        </View>
      )}
      {b.status === 'pending' ? (
        <View style={{ gap: 8 }}>
          <PillButton title={busy ? 'Saving…' : 'Save to group skills'} disabled={busy || (editing && (!name.trim() || !steps.trim()))}
            onPress={() => run(() => api.saveProposedSkill(bot.id, row, editing ? { name, description, body: steps } : undefined))} />
          {!editing && <PillButton title="Edit first" kind="secondary" disabled={busy} onPress={() => setEditing(true)} />}
          <PillButton title="Dismiss" kind="secondary" disabled={busy} onPress={() => run(() => api.dismiss(bot.id, row))} />
        </View>
      ) : (
        <Text style={type.caption}>{b.status === 'saved' ? 'Saved to this group’s skills' : 'Dismissed'}</Text>
      )}
      {note && <Text style={type.caption}>{note}</Text>}
    </CardShell>
  );
}

// ---------- plugins (server/src/plugins/builder.ts, ui-schema.ts), as on the web's PluginBuilderCards ----------

type PlanTool = { name: string; description: string; writes: boolean };
function ToolList({ tools }: { tools: PlanTool[] }) {
  return (
    <View style={{ gap: 6 }}>
      {tools.map((t) => (
        <View key={t.name} style={{ gap: 2 }}>
          <Text style={{ fontFamily: 'monospace', fontSize: 13, color: color.ink }}>{t.name} <Text style={{ fontFamily: undefined, fontSize: 12, color: t.writes ? color.problemInk : color.inkMuted }}>{t.writes ? '· changes things' : '· reads only'}</Text></Text>
          {!!t.description && <Text style={[type.caption, { fontSize: 13 }]}>{t.description}</Text>}
        </View>
      ))}
    </View>
  );
}
function useRun() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setNote(null); try { await fn(); } catch (e: any) { setNote(e?.message ?? 'Something went wrong.'); } finally { setBusy(false); } };
  return { busy, note, run };
}

/** A bot's plan for a plugin. Build authorizes building this plan only; nothing is installed. */
function PluginPlanCard({ api, body }: { api: Client; body: any }) {
  const { busy, note, run } = useRun();
  const pending = body.status === 'pending';
  const outcome: Record<string, string> = { building: 'Building. You review the code before anything is installed.', built: 'Built and installed', dismissed: 'Not built', expired: 'Expired. Ask the Bot to plan it again.' };
  return (
    <CardShell title="New plugin plan">
      <View style={{ gap: 8, backgroundColor: color.surface, borderRadius: 14, padding: 12 }}>
        <Text style={[type.body, { fontWeight: '600' }]}>{body.title}</Text>
        <Text style={[type.caption, { fontSize: 14 }]}>{body.purpose}</Text>
        <ToolList tools={body.tools ?? []} />
        <Text style={[type.caption, { fontSize: 13 }]}>{body.network?.length ? `Talks to: ${body.network.join(', ')}` : 'No network access.'}</Text>
      </View>
      {pending ? (
        <View style={{ gap: 8 }}>
          <PillButton title={busy ? 'Working…' : 'Build'} disabled={busy} onPress={() => run(() => api.buildPlugin(body.draftId))} />
          <PillButton title="Not now" kind="secondary" disabled={busy} onPress={() => run(() => api.dismissPlugin(body.draftId))} />
        </View>
      ) : <Text style={type.caption}>{outcome[body.status] ?? body.status}</Text>}
      {note && <Text style={type.caption}>{note}</Text>}
    </CardShell>
  );
}

const REVIEW_OUTCOME: Record<string, string> = { installed: 'Installed', rejected: 'Not installed', removed: 'Removed (restore it from Plugins)', superseded: 'Replaced by a newer version below', failed: 'Checks failed; the Bot was told what to fix', expired: 'Expired. Ask the Bot to submit it again.' };

/** The checked draft. Install sends back the fingerprint shown here; only the owner can press it. */
function PluginReviewCard({ api, body, onCode }: { api: Client; body: any; onCode?: (draftId: string) => void }) {
  const { busy, note, run } = useRun();
  const pending = body.status === 'pending';
  const [bots, setBots] = useState<Bot[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => { if (pending) api.bots().then((r) => setBots(r.bots.filter((b) => b.kind !== 'room' && !b.outside))).catch(() => {}); }, [api, pending]);
  return (
    <CardShell title="Plugin ready for review">
      <View style={{ gap: 8, backgroundColor: color.surface, borderRadius: 14, padding: 12 }}>
        <Text style={[type.body, { fontWeight: '600' }]}>{body.title}</Text>
        {!!body.digest && <Text style={[type.caption, { fontSize: 12 }]}>Fingerprint {String(body.digest).slice(0, 16)}</Text>}
        {(body.checks ?? []).map((c: any) => (
          <Text key={c.name} style={[type.caption, { fontSize: 13, color: c.ok ? color.ink : color.problemInk }]}>{c.ok ? '✓' : '✗'} {c.name}: {c.detail}</Text>
        ))}
        {(body.notes ?? []).map((n: string) => <Text key={n} style={[type.caption, { fontSize: 13 }]}>• {n}</Text>)}
        <ToolList tools={body.tools ?? []} />
        <Text style={[type.caption, { fontSize: 13 }]}>{body.network?.length ? `Talks to: ${body.network.join(', ')}` : 'No network access.'} Files: {(body.files ?? []).join(', ')}</Text>
      </View>
      {body.status !== 'superseded' && onCode && <PillButton title="View code" kind="secondary" onPress={() => onCode(body.draftId)} />}
      {pending && bots.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={type.caption}>Turn it on for (optional)</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {bots.map((b) => <Chip key={b.id} onCard title={b.name} selected={picked.includes(b.id)} onPress={() => setPicked((p) => (p.includes(b.id) ? p.filter((x) => x !== b.id) : [...p, b.id]))} />)}
          </View>
        </View>
      )}
      {pending ? (
        <View style={{ gap: 8 }}>
          <PillButton title={busy ? 'Installing…' : 'Install'} disabled={busy} onPress={() => run(() => api.installPlugin(body.draftId, body.digest, picked))} />
          <PillButton title="Don’t install" kind="secondary" disabled={busy} onPress={() => run(() => api.dismissPlugin(body.draftId))} />
        </View>
      ) : body.status === 'installed' ? (
        <View style={{ gap: 8 }}>
          <Text style={type.caption}>Installed</Text>
          <PillButton title="Undo" kind="secondary" disabled={busy} onPress={() => run(() => api.undoPlugin(body.draftId))} />
        </View>
      ) : <Text style={type.caption}>{REVIEW_OUTCOME[body.status] ?? body.status}</Text>}
      {note && <Text style={type.caption}>{note}</Text>}
    </CardShell>
  );
}

/** https links only (and small data: pictures), checked again here as on the web. */
function safeUrl(u: unknown, image = false): string | null {
  if (typeof u !== 'string' || u.length > (image ? 200_000 : 2000)) return null;
  if (image && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(u)) return u;
  return /^https:\/\/[^\s]+$/i.test(u) ? u : null;
}

/** A plugin's card: plain data, drawn with fixed pieces. Nothing in it runs. */
function PluginView({ body }: { body: any }) {
  const v = body.view ?? { title: '', blocks: [] };
  return (
    <CardShell title={body.pluginName}>
      <View style={{ gap: 8, backgroundColor: color.surface, borderRadius: 14, padding: 12 }}>
        <Text style={[type.body, { fontWeight: '600' }]}>{v.title}</Text>
        {!!v.subtitle && <Text style={[type.caption, { fontSize: 13 }]}>{v.subtitle}</Text>}
        {(v.blocks ?? []).map((b: any, i: number) => {
          switch (b.kind) {
            case 'heading': return <Text key={i} style={[type.body, { fontWeight: '600' }]}>{b.text}</Text>;
            case 'text': return <Text key={i} selectable style={[type.body, { fontSize: 15 }]}>{b.text}</Text>;
            case 'fields': return <View key={i} style={{ gap: 4 }}>{b.items.map((f: any, j: number) => <Text key={j} style={[type.caption, { fontSize: 14 }]}><Text style={{ fontWeight: '600', color: color.ink }}>{f.label}: </Text>{f.value}</Text>)}</View>;
            case 'table': return (
              <ScrollView key={i} horizontal><View>
                <View style={{ flexDirection: 'row' }}>{b.columns.map((c: string, j: number) => <Text key={j} style={{ width: 120, fontWeight: '600', fontSize: 13, color: color.ink, paddingVertical: 4 }}>{c}</Text>)}</View>
                {b.rows.map((r: string[], j: number) => <View key={j} style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: color.hairline }}>{r.map((c, k) => <Text key={k} style={{ width: 120, fontSize: 13, color: color.ink, paddingVertical: 4 }}>{c}</Text>)}</View>)}
              </View></ScrollView>
            );
            case 'link': { const u = safeUrl(b.url); return u ? <Text key={i} style={{ color: color.link, fontSize: 15 }} onPress={() => Linking.openURL(u)}>{b.label}</Text> : null; }
            case 'image': { const u = safeUrl(b.url, true); return u ? <Image key={i} source={{ uri: u }} accessibilityLabel={b.alt} style={{ width: '100%', height: 180, borderRadius: 10 }} resizeMode="contain" /> : null; }
            case 'progress': return (
              <View key={i} style={{ gap: 4 }}>
                <Text style={[type.caption, { fontSize: 13 }]}>{b.label}</Text>
                <View style={{ height: 6, borderRadius: 3, backgroundColor: color.fill }}><View style={{ height: 6, borderRadius: 3, backgroundColor: color.link, width: `${Math.max(0, Math.min(100, (b.value / (b.max || 1)) * 100))}%` }} /></View>
              </View>
            );
            case 'badge': return <Text key={i} style={{ alignSelf: 'flex-start', fontSize: 12, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: 'hidden', backgroundColor: color.fill, color: b.tone === 'bad' ? color.problemInk : b.tone === 'good' ? color.goodInk : b.tone === 'warn' ? color.warnInk : color.inkMuted }}>{b.text}</Text>;
            default: return null;
          }
        })}
      </View>
    </CardShell>
  );
}

/** Grok Bot's action card: a grey card with a small title, a white inner panel and full-width buttons. */
/** The line under an approval card's title: the app's name, else what kind of action it is. */
const appLine = (body: any): string => body.toolkitName || cardIcon(body).label;

function CardShell({ title, icon, sub, children }: { title?: string; icon?: IconData; sub?: string; children: React.ReactNode }) {
  return (
    <View style={{ alignSelf: 'flex-start', width: '86%', backgroundColor: color.fill, borderRadius: 20, padding: 14, gap: 12 }}>
      {icon ? (
        // Approval cards: the app's logo or a glyph for the action, so the card says at a glance what it is about.
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <IconTile icon={icon} size={40} />
          <View style={{ flex: 1, gap: 2 }}>
            {!!title && <Text style={{ fontSize: 15, fontWeight: '500', color: color.ink }}>{title}</Text>}
            {!!sub && <Text style={[type.caption, { color: color.inkMuted }]} numberOfLines={1}>{sub}</Text>}
          </View>
        </View>
      ) : !!title && <Text style={{ fontSize: 15, fontWeight: '500', color: color.ink }}>{title}</Text>}
      {children}
    </View>
  );
}

const INTENT: Record<string, string> = { tweak: 'Changing my current look', new: 'A whole new look', default: 'Back to my plain shape' };

/**
 * A bot's offer of new looks (server/src/avatars.ts): pictures to pick from, "Use this one", and
 * More options (keep or start over, style, how many). Nothing changes until the owner picks.
 */
function LookCard({ api, bot, row }: { api: Client; bot: Bot; row: Row }) {
  const revealOnFocus = useRevealOnFocus();
  const b = row.body;
  const [picked, setPicked] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [desc, setDesc] = useState<string>(b.description ?? '');
  const [intent, setIntent] = useState<'tweak' | 'new'>(b.intent === 'tweak' ? 'tweak' : 'new');
  const [style, setStyle] = useState<string | null>(b.style ?? null);
  const count = 3; // always 3 (server LOOK_COUNT)
  const [styles, setStyles] = useState<[string, string][]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const open = b.status === 'pending' || b.status === 'failed';
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setNote(null);
    try { await fn(); } catch (e: any) { setNote(e?.message ?? 'Something went wrong.'); } finally { setBusy(false); }
  };
  const showMore = () => { setMore(true); if (!styles.length) Promise.resolve().then(() => api.looksOptions()).then((o) => setStyles(o.styles.map((x) => [x.id, x.label]))).catch(() => {}); };

  if (b.intent === 'default') {
    return (
      <CardShell title={`Go back to ${bot.name}'s plain shape?`}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <BotAvatar bot={bot} size={56} server={api.server} auth={api.authHeader} still />
          <Icon name="arrow" size={18} color={color.inkMuted} />
          <BotShape shape={bot.avatarShape} color={bot.avatarColor} size={56} />
        </View>
        {open ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <PillButton title="Use the shape" disabled={busy} onPress={() => run(() => api.chooseLook(bot.id, row.seq, null))} style={{ flex: 1 }} />
            <PillButton title="Keep picture" kind="secondary" disabled={busy} onPress={() => run(() => api.dismiss(bot.id, row))} style={{ flex: 1 }} />
          </View>
        ) : <Text style={type.caption}>{b.status === 'applied' ? 'Back to the shape' : 'Kept the picture'}</Text>}
        {note && <Text style={type.caption}>{note}</Text>}
      </CardShell>
    );
  }

  const ids: string[] = b.status === 'applied' && b.chosen ? [b.chosen] : b.candidates ?? [];
  // What "Use this one" acts on: the picture tapped, or the first one until one is tapped.
  const sel = open ? (picked && ids.includes(picked) ? picked : ids[0] ?? null) : null;
  const making = b.status === 'making';
  const retry = () => run(() => api.moreLooks(bot.id, row.seq, { description: b.description ?? '', intent: b.intent === 'tweak' ? 'tweak' : 'new', style: b.style ?? null, count, reference: null }));
  return (
    <CardShell title={b.status === 'applied' ? `${bot.name}'s new look` : `New looks for ${bot.name}`}>
      <Text style={type.caption}>{INTENT[b.intent] ?? ''}{b.description ? ` · “${b.description}”` : ''}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {ids.map((id, i) => (
          <Pressable key={id} accessibilityLabel={`Option ${i + 1}`} accessibilityRole="radio" accessibilityState={{ checked: sel === id }} disabled={!open || busy} onPress={() => setPicked(id)}
            style={{ padding: 2, borderRadius: 17, borderWidth: 3, borderColor: sel === id || b.chosen === id ? color.link : 'transparent', transform: [{ scale: sel === id && ids.length > 1 ? 1.04 : 1 }] }}>
            <Image source={{ uri: api.lookUrl(bot.id, id), headers: api.authHeader }} style={{ width: 90, height: 90, borderRadius: 13, backgroundColor: color.surface, opacity: sel && sel !== id && ids.length > 1 ? 0.45 : 1 }} />
            <View style={{ position: 'absolute', left: 8, top: 8, minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, backgroundColor: '#0000005C', alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '600' }}>{i + 1}</Text>
            </View>
            {(sel === id || b.chosen === id) && <CheckBadge />}
          </Pressable>
        ))}
        {b.status === 'making' && Array.from({ length: b.count ?? 4 }, (_, i) => (
          <View key={`m${i}`} style={{ margin: 2, width: 92, height: 92, borderRadius: 13, backgroundColor: color.surface, alignItems: 'center', justifyContent: 'center' }}>
            {i === 0 ? <ActivityIndicator color={color.timestamp} /> : null}
          </View>
        ))}
      </View>
      {b.status === 'making' && <Text style={type.caption}>Drawing {b.count} options… this can take a minute or two.</Text>}
      {!!b.error && !making && (
        <View style={{ gap: 8, borderRadius: 12, padding: 10, backgroundColor: color.problemFill }}>
          <Text style={[type.caption, { color: color.problemInk }]}>{ids.length ? 'The last pictures could not be drawn: ' : 'The pictures could not be drawn: '}{b.error}</Text>
          {open && <PillButton title={busy ? 'Starting…' : 'Try again'} kind="secondary" disabled={busy} onPress={retry} />}
        </View>
      )}
      {open && !more && (
        <View style={{ gap: 8 }}>
          {ids.length > 0 && <PillButton title={ids.length > 1 && sel ? `Use option ${ids.indexOf(sel) + 1}` : 'Use this one'} disabled={!sel || busy} onPress={() => sel && run(async () => { await api.chooseLook(bot.id, row.seq, sel); celebrate(bot.id); })} />}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <PillButton title="More options" kind="secondary" disabled={busy} onPress={showMore} style={{ flex: 1 }} />
            <PillButton title="Keep mine" kind="secondary" disabled={busy} onPress={() => run(() => api.dismiss(bot.id, row))} style={{ flex: 1 }} />
          </View>
        </View>
      )}
      {open && more && (
        <View style={{ gap: 10 }}>
          {!!bot.avatarImageUrl && (
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Chip onCard title="Change this look" selected={intent === 'tweak'} onPress={() => setIntent('tweak')} />
              <Chip onCard title="A whole new look" selected={intent === 'new'} onPress={() => setIntent('new')} />
            </View>
          )}
          <TextInput value={desc} onChangeText={setDesc} onFocus={revealOnFocus} multiline placeholder="What should it look like?" placeholderTextColor={color.timestamp}
            style={{ minHeight: 60, borderRadius: 14, backgroundColor: color.surface, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: color.ink, textAlignVertical: 'top' }} />
          <ScrollRow>
            <Chip onCard title={intent === 'tweak' ? 'Keep style' : 'Any style'} selected={style === null} onPress={() => setStyle(null)} />
            {styles.map(([k, label]) => <Chip onCard key={k} title={label} selected={style === k} onPress={() => setStyle(k)} />)}
          </ScrollRow>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <PillButton title="Make more" disabled={busy || !desc.trim()} onPress={() => run(async () => { await api.moreLooks(bot.id, row.seq, { description: desc.trim(), intent, style, count, reference: null }); setMore(false); })} style={{ flex: 1 }} />
            <PillButton title="Cancel" kind="secondary" onPress={() => setMore(false)} style={{ flex: 1 }} />
          </View>
        </View>
      )}
      {b.status === 'dismissed' && <Text style={type.caption}>Kept the current look</Text>}
      {note && <Text style={type.caption}>{note}</Text>}
    </CardShell>
  );
}

function ScrollRow({ children }: { children: React.ReactNode }) {
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }}>{children}</ScrollView>;
}

/** The chosen look, big, with a few ideas for what to change next. */
function LookReveal({ api, bot, row }: { api: Client; bot: Bot; row: Row }) {
  const b = row.body;
  const job = bot.avatarPoseJob;
  return (
    <CardShell>
      <View style={{ alignItems: 'center', gap: 10, paddingTop: 6 }}>
        <Image source={{ uri: api.lookUrl(bot.id, b.candidateId), headers: api.authHeader }} style={{ width: 150, height: 150, borderRadius: 75, backgroundColor: color.surface }} />
        <Text style={{ fontSize: 16, fontWeight: '600', color: color.ink }}>Ta-da! This is me now.</Text>
        {!!bot.avatarImageUrl && job && (
          <Text style={[type.caption, { textAlign: 'center' }]}>
            {job.state === 'making' ? `Making my poses: ${job.done} of ${job.total}` : job.state === 'ready' ? `${job.done} poses ready. I'll switch between them as I work.` : `Poses stopped at ${job.done} of ${job.total}.`}
          </Text>
        )}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
        {(b.suggestions ?? []).map((t: string) => <Chip onCard key={t} title={t} onPress={() => { (bot.outside ? api.askLooks(bot.id, { description: t, intent: 'tweak' }) : api.send(bot.id, `Change your look: ${t.charAt(0).toLowerCase()}${t.slice(1)}`)).catch((e: any) => toast(e?.message ?? 'Could not ask for that look.')); }} />)}
      </View>
    </CardShell>
  );
}

/** What the bot is doing now, in the words of its pose (matches the picture beside it). */
function PoseLabel({ bot }: { bot: Bot }) {
  const pose = useBotPose(bot.id, bot.lastActivityAt);
  const simple = useSimple();
  // The simple view says "Here for you" where the full app says "Idle", which reads like a machine's state.
  const label = simple && pose === 'idle' ? 'Here for you' : POSE_LABELS.find(([id]) => id === pose)?.[1];
  return label ? <Text numberOfLines={1} style={{ fontSize: 13, color: color.inkMuted }}>{label}</Text> : null;
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/** Whether the person last chose to see the whole thought in the thinking bubble; sticks while the app runs. */
let thinkingOpen = false;

/**
 * Under the newest message while the bot works: what it is doing, for how long, and how many steps so far.
 * If no answer comes, it says so and offers to check again or send the message again, instead of
 * showing "Thinking" forever.
 */
function Working({ api, bot, rows, onRefresh }: { api: Client; bot: Bot; rows: Row[]; onRefresh: () => void }) {
  const live = useLive(bot.id);
  const [now, setNow] = useState(Date.now());
  const [resent, setResent] = useState<number | null>(null);
  // When "Check again" last ran for this message, so the box can say it looked and found nothing new.
  const [checked, setChecked] = useState<{ seq: number; at: number } | null>(null);
  const [open, setOpen] = useState(thinkingOpen);
  const lastMsg = [...rows].reverse().find((r) => r.body.type === 'message');
  // A steering note already taken into a reply (server steer-mode.ts) gets no reply of its own.
  const asked = lastMsg && lastMsg.body.role === 'user' && isMine(lastMsg) && lastMsg.body.steer !== 'read' ? lastMsg : null;
  const running = !!live?.isRunning;
  // A card that was waiting a moment ago and is now answered, or a turn that just ended: rows don't date
  // either change, so the "No answer yet" clock starts from when the phone saw it.
  const pendingSeq = pendingCard(rows, now)?.seq ?? null;
  const [touchedAt, setTouchedAt] = useState<number | null>(null);
  // Not on opening the chat: an old unanswered message shows "No answer yet" right away, as before.
  const seen = useRef({ pendingSeq, running });
  useEffect(() => {
    const was = seen.current;
    if ((was.pendingSeq !== null && pendingSeq === null) || (was.running && !running)) setTouchedAt(Date.now());
    seen.current = { pendingSeq, running };
  }, [pendingSeq, running]);
  // Shared rule (server/src/reply-wait.ts): while a card waits on the person, never "No answer yet" or "Taking a while".
  const wait = replyWait({ live, rows, asked, startedAt: live?.startedAt ?? null, touchedAt, now });
  const since = wait.state === 'none' ? null : wait.since;
  // The bubble's widest size so far this turn (see the bubble below); a new turn starts small again.
  const [minWidth, setMinWidth] = useState(0);
  useEffect(() => { setMinWidth(0); }, [live?.startedAt ?? asked?.createdAt ?? null]);
  const show = wait.state !== 'none';
  const ticking = running || !!asked || !!live?.awaiting;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  if (!show || since === null) return null;

  const elapsed = now - since;
  const stalled = wait.state === 'stalled';
  const slow = wait.state === 'working' && wait.slow;
  if (wait.state === 'waiting') {
    return (
      <View style={{ marginTop: 12, alignSelf: 'flex-start', maxWidth: '86%', flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: color.fill, borderRadius: 20, paddingVertical: 11, paddingHorizontal: 15 }}>
        <Text numberOfLines={2} style={{ fontSize: 15, color: color.ink, flexShrink: 1 }}>
          {bot.name} is waiting for your answer above
          {elapsed >= 60_000 ? <Text style={{ color: color.inkMuted }}> · {ago(elapsed)}</Text> : null}
        </Text>
      </View>
    );
  }
  const kind = live?.activity?.kind;
  let label = running ? (kind ? ACTIVITY_LABEL[kind] ?? 'Working' : 'Thinking') : 'Sending to ' + bot.name;
  if (kind === 'messaging_named' && live?.activity?.detail) label = `Messaging ${live.activity.detail}`;
  const caption = running ? (live?.caption || (kind !== 'messaging_named' ? live?.activity?.detail : null)) : null;
  // The whole thought behind the short recap (server/src/caption.ts); only then can the bubble expand.
  const full = running && live?.caption ? live?.captionFull || null : null;
  const steps = live?.steps ? ` · ${live.steps} step${live.steps === 1 ? '' : 's'}` : '';

  if (stalled) {
    return (
      <View>
        <View style={{ marginTop: 12, alignSelf: 'flex-start', maxWidth: '86%', backgroundColor: color.fill, borderRadius: 20, padding: 14, gap: 10 }}>
          <Text style={[type.body, { fontSize: 15 }]}>No answer from {bot.name} yet.</Text>
          <Text style={type.caption}>
            {checked?.seq === asked!.seq
              ? `Checked ${new Date(checked.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: still no answer, and ${bot.name} isn't working on it. Tap Send again to ask once more.`
              : "It may have answered while the phone wasn't listening, or the message didn't get through."}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <PillButton title="Check again" kind="secondary" onPress={() => { onRefresh(); setChecked({ seq: asked!.seq, at: Date.now() }); }} style={{ flex: 1 }} />
            <PillButton title="Send again" kind="secondary" disabled={resent === asked!.seq}
              onPress={() => {
                setResent(asked!.seq);
                // Ask the server first: if the bot did answer (or is working on it), nothing is sent twice.
                api.rows(bot.id).then(async (r) => {
                  const answered = r.rows.some((x) => x.seq > asked!.seq && x.body.type === 'message' && x.body.role === 'assistant');
                  const working = (await api.bots().catch(() => null))?.live?.some((l) => l.botId === bot.id && l.isRunning);
                  if (!answered && !working) await api.send(bot.id, asked!.body.text);
                  onRefresh();
                }).catch(() => setResent(null));
              }} style={{ flex: 1 }} />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View>
      {/* Grows (smoothly) to fit a longer status, never shrinks back during the turn: no jumping as the timer and status change. */}
      <View onLayout={(e) => { const w = Math.ceil(e.nativeEvent.layout.width); if (w > minWidth + 1) { LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity')); setMinWidth(w); } }}
        style={{ marginTop: 12, alignSelf: 'flex-start', maxWidth: '86%', minWidth, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: color.fill, borderRadius: 20, paddingVertical: 11, paddingHorizontal: 15 }}>
        <Dots />
        <View style={{ flexShrink: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 15, color: color.ink }}>{label}… <Text style={{ color: color.inkMuted }}>{ago(elapsed)}{steps}</Text></Text>
          {!!caption && (full ? (
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityHint={open ? 'Shows the short version' : 'Shows the whole thought'}
              onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); thinkingOpen = !open; setOpen(!open); }} hitSlop={8}
              style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 4, marginTop: 2 }}>
              <Text selectable={open} style={[type.caption, { fontSize: 13, lineHeight: 18, flexShrink: 1 }]}>{open ? full : caption}</Text>
              <View style={{ marginTop: 2, transform: [{ rotate: open ? '-90deg' : '90deg' }] }}><Icon name="chevron" size={13} color={color.inkMuted} /></View>
            </Pressable>
          ) : <Text style={[type.caption, { fontSize: 13, lineHeight: 18, marginTop: 2 }]}>{caption}</Text>)}
          {slow && (
            <Pressable accessibilityRole="button" onPress={onRefresh} hitSlop={8}>
              <Text style={{ fontSize: 13, color: color.link, marginTop: 4 }}>Taking a while. Check again</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const MEMBER_STATE = { queued: 'Up next', working: 'Working', waiting: 'Needs you' } as const;

/**
 * A group chat's live block: one line per member answering the group right now
 * (server/src/agent/room-runs.ts), each with its own Stop. The composer's Stop stops them all.
 */
function GroupWorking({ api, bot, bots }: { api: Client; bot: Bot; bots?: Bot[] }) {
  const live = useLive(bot.id);
  const [now, setNow] = useState(Date.now());
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const members = live?.isRunning ? live.members ?? [] : [];
  useEffect(() => {
    if (!members.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [members.length]);
  if (!members.length) return null;
  const stop = (id: string) => {
    setStopping((s) => ({ ...s, [id]: true }));
    api.interrupt(bot.id, id).catch((e) => toast(`Couldn't stop them: ${e?.message ?? 'the server did not answer'}`)).finally(() => setStopping((s) => ({ ...s, [id]: false })));
  };
  return (
    <View style={{ marginTop: 12, alignSelf: 'stretch', backgroundColor: color.fill, borderRadius: 20, paddingVertical: 8, paddingHorizontal: 14, gap: 4 }}>
      {members.map((m) => (
        <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
          {m.state === 'queued' ? <View style={{ width: 7 * 3 + 8 }} /> : <Dots />}
          <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 15, color: m.state === 'queued' ? color.inkMuted : color.ink }}>
            <Text style={{ fontWeight: '700', color: chatInk(bots?.find((x) => x.id === m.id)?.chatColor ?? chatColorForUnseen(m.id), currentScheme()).ink }}>{m.name}</Text> <Text style={{ color: m.state === 'waiting' ? color.warnInk : color.inkMuted }}>{MEMBER_STATE[m.state]}{m.state !== 'queued' && now - m.since >= 1000 ? ` · ${ago(now - m.since)}` : ''}</Text>
          </Text>
          {m.model && m.state === 'working' && <ModelBadge model={m.model} inline />}
          <View style={{ flex: 1 }} />
          <Pressable accessibilityRole="button" accessibilityLabel={`Stop ${m.name}`} accessibilityState={{ busy: !!stopping[m.id] }} disabled={!!stopping[m.id]} onPress={() => stop(m.id)} hitSlop={6}
            style={({ pressed }) => ({ minHeight: 36, paddingHorizontal: 14, borderRadius: 18, borderWidth: 1, borderColor: color.inkMuted, alignItems: 'center', justifyContent: 'center', opacity: stopping[m.id] ? 0.5 : pressed ? 0.7 : 1 })}>
            <Text style={{ fontSize: 14, color: color.ink }}>{stopping[m.id] ? 'Stopping…' : 'Stop'}</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

/** Three dots that pulse in turn, like someone typing. */
function Dots() {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.timing(v, { toValue: 3, duration: 1200, easing: Easing.linear, useNativeDriver: true }));
    a.start();
    return () => a.stop();
  }, [v]);
  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {[0, 1, 2].map((i) => (
        <Animated.View key={i} style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: color.inkMuted,
          opacity: v.interpolate({ inputRange: [0, i, i + 0.5, i + 1, 3], outputRange: [0.3, 0.3, 1, 0.3, 0.3], extrapolate: 'clamp' }) }} />
      ))}
    </View>
  );
}

/** What a step did, in a few words: the command it ran, the page it opened, the file it touched. */
function stepDetail(b: any): string | null {
  const a = b.args ?? {};
  const v = a.command ?? a.query ?? a.url ?? a.path ?? a.file ?? a.name ?? a.code;
  if (typeof v !== 'string' || !v.trim()) return null;
  return v.trim().split('\n').find((l: string) => l.trim() && !l.trim().startsWith('#'))?.trim() ?? v.trim().split('\n')[0];
}

/**
 * A run of the bot's steps (tool calls) between messages, as one compact row: the step running now, or how
 * many it took. Tap to see each step with what it did; running steps show live as they happen.
 *
 * The list opens upward, as on the web: it sits above the row, oldest at the top and newest next to the row,
 * so the newest steps show first and the row (the collapse control) stays where it was. The chat is an
 * inverted list, so anything that grows above the row leaves the row in place. A long list scrolls inside a
 * capped box that keeps the newest step in view while steps stream in, unless you scrolled up inside it.
 */
function Steps({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState(false);
  const simple = useSimple();
  const { height: winH } = useWindowDimensions();
  const listRef = useRef<ScrollViewInstance>(null);
  const listStick = useRef(true);
  const running = rows.filter((r) => stepState(r.body.status) === 'running');
  const failed = rows.filter((r) => stepState(r.body.status) === 'failed').length;
  const denied = rows.filter((r) => stepState(r.body.status) === 'denied').length;
  const waiting = rows.filter((r) => stepState(r.body.status) === 'waiting').length;
  const current = running[running.length - 1] ?? rows[rows.length - 1];
  const head = running.length
    ? `${simple ? plainStep(current.body.label ?? current.body.title, current.body.name) : current.body.label ?? current.body.title ?? 'Working'}…`
    : `${rows.length} step${rows.length === 1 ? '' : 's'}${failed ? ` · ${failed} didn't work` : ''}${denied ? ` · ${denied} not allowed` : ''}${waiting ? ` · ${waiting} waiting for you` : ''}`;
  const headIcon = running.length ? null : waiting ? 'tasks' : failed || denied ? 'close' : 'check';
  const detail = running.length && !simple ? stepDetail(current.body) : null;
  return (
    <View style={{ alignSelf: 'flex-start', maxWidth: '92%' }}>
      {open && (
        <ScrollView ref={listRef} nestedScrollEnabled style={{ maxHeight: Math.round(winH * 0.5) }}
          onContentSizeChange={() => { if (listStick.current) listRef.current?.scrollToEnd({ animated: false }); }}
          onScroll={(e) => { const n = e.nativeEvent; listStick.current = n.contentSize.height - n.contentOffset.y - n.layoutMeasurement.height < 24; }}
          scrollEventThrottle={100}>
          <View style={{ marginLeft: 17, paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: color.hairline, gap: 8, paddingVertical: 4 }}>
            {rows.map((r) => <StepRow key={r.seq} row={r} />)}
          </View>
        </ScrollView>
      )}
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityHint={open ? 'Hides the steps above' : 'Shows the steps above'} onPress={() => { listStick.current = true; setOpen(!open); }} hitSlop={6}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 14, backgroundColor: pressed ? color.pressed : 'transparent' })}>
        {running.length ? <ActivityIndicator size="small" color={color.inkMuted} /> : <Icon name={headIcon as any} size={15} color={failed || denied ? color.problemInk : color.inkMuted} />}
        <View style={{ flexShrink: 1 }}>
          <Text numberOfLines={1} style={[type.caption, { color: color.inkSecondary }]}>{head}</Text>
          {!open && !!detail && <Text numberOfLines={1} style={{ fontSize: 12, color: color.timestamp, fontFamily: 'monospace' }}>{detail}</Text>}
        </View>
        <Text style={{ fontSize: 12, color: color.timestamp }}>{open ? '▴' : '▸'}</Text>
      </Pressable>
    </View>
  );
}

/** One step, as on the web: its state (running, done, didn't work, not allowed, waiting for you), what it did, and its details. */
function StepRow({ row }: { row: Row }) {
  const b = row.body;
  const [more, setMore] = useState(false);
  // Sam's view: the step in plain words only (no commands, raw arguments, output or screenshots).
  const simple = useSimple();
  const st = stepState(b.status);
  const d = simple ? null : stepDetail(b);
  const args = !simple && b.args && typeof b.args === 'object' && Object.keys(b.args).length ? JSON.stringify(b.args, null, 2) : '';
  const shot = !simple && typeof b.screenshot === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(b.screenshot) ? b.screenshot : null;
  const bad = st === 'failed' || st === 'denied';
  return (
    <View style={{ gap: 2 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} accessibilityLabel={`${b.label ?? b.name}: ${STEP_LABEL[st]}`} onPress={() => setMore(!more)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {st === 'running' ? <ActivityIndicator size="small" color={color.inkMuted} />
          : <Icon name={st === 'waiting' ? 'tasks' : bad ? 'close' : 'check'} size={13} color={bad ? color.problemInk : color.inkMuted} />}
        <Text style={[type.caption, { fontSize: 13, color: color.inkSecondary, flexShrink: 1 }]}>{simple ? plainStep(b.label ?? b.title, b.name) : b.label ?? b.title ?? b.name}</Text>
        {st !== 'done' && st !== 'running' && <Text style={{ fontSize: 12, color: bad ? color.problemInk : color.inkMuted }}>{STEP_LABEL[st]}</Text>}
        <Text style={{ fontSize: 12, color: color.timestamp }}>{time(row.createdAt)}</Text>
      </Pressable>
      {!!b.summary && !simple && <Text numberOfLines={more ? undefined : 2} selectable style={[type.caption, { fontSize: 12 }]}>{b.summary}</Text>}
      {!more && !!d && <Text numberOfLines={2} selectable style={{ fontSize: 12, color: color.timestamp, fontFamily: 'monospace' }}>{d}</Text>}
      {more && !!args && <Text selectable style={{ fontSize: 12, color: color.timestamp, fontFamily: 'monospace' }}>{args.length > 4000 ? `${args.slice(0, 4000)}\n…` : args}</Text>}
      {more && !!shot && <Image source={{ uri: shot }} accessibilityLabel="Screenshot from this step" style={{ width: 220, height: 140, borderRadius: 8 }} resizeMode="contain" />}
    </View>
  );
}

/** A row is drawn again only when its own row (or who it is shown to, or the look) changes. `look` is light/dark + text size. */
const RowMemo = memo(RowView as (p: Parameters<typeof RowView>[0] & { look: string }) => React.JSX.Element | null);
/** A step list is drawn again only when one of its steps changed. */
const StepsMemo = memo(Steps as (p: { rows: Row[]; look: string }) => React.JSX.Element | null,
  (a, b) => a.look === b.look && a.rows.length === b.rows.length && a.rows.every((r, i) => r === b.rows[i]));
