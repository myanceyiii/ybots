import { db, now } from './db.js';
import { hub } from './lib/hub.js';
import type { AvatarPose } from './avatar-poses.js';
import type { AvatarPoseJob, Bot, LiveState, Row, RowBody, RowKind, Routine, Task } from './types.js';
import { Cron } from 'croner';
import { cleanTiers } from './model-router.js';
import { outsideFor } from './outside.js';
import { linkStatus, waitingCount, waitingFor } from './slack-link.js';
import { plainText, splitReply } from './message-text.js';
import { listPreview } from './list-preview.js';
import { getSummaryPrefs, savedSummary } from './list-summary-store.js';
import { assignChatColors, isChatColor } from './chat-colors.js';
import { visualsOf } from './visuals-level.js';
import { busySendOf } from './steer-mode.js';

// ---------- bots ----------

/** One line for the chat list about a row, or null when the row says nothing on its own. */
export function previewOf(b: RowBody): string | null {
  // A bot's Markdown shows as plain words in the list (no ** or #), as on every app.
  if (b.type === 'message') return b.role === 'user' ? splitReply(b.text).body : plainText(b.text).replace(/\s*\n+\s*/g, ' ');
  if (b.type === 'event') return b.text;
  if (b.type !== 'card') return null;
  switch (b.card) {
    case 'approval': return b.status === 'pending' ? `Waiting for you: ${b.title}` : b.title;
    case 'question': return b.question;
    case 'connect': return `Connect ${b.toolkitName}`;
    case 'look': return 'New looks to pick from';
    case 'look-reveal': return 'A new look';
    case 'skill-proposal': return `Proposed skill: ${b.name}`;
    // Choice buttons say nothing on their own: the bot's question above them is the line.
    case 'view': return b.quick ? null : (b.title || plainText(b.text.split('\n')[0])).slice(0, 120);
    case 'plugin': return b.view.title || b.pluginName;
    case 'plugin-plan': return `Plugin plan: ${b.title}`;
    case 'plugin-review': return `Plugin ready to review: ${b.title}`;
    case 'draft': return b.subject ? `Draft: ${b.subject}` : 'Draft';
    case 'files': return null;
  }
}

export function toBot(r: any): Bot {
  // The newest rows give the list's line (list-preview.ts): the bot's own last words, or who posted last.
  const recent = db
    .prepare("SELECT body, created_at FROM rows WHERE bot_id=? AND generation=? AND kind IN ('message','card','event') ORDER BY seq DESC LIMIT 20")
    .all(r.id, r.generation) as { body: string; created_at: number }[];
  const last = recent[0];
  const bodies: RowBody[] = [];
  for (const row of recent) { try { bodies.push(JSON.parse(row.body) as RowBody); } catch { /* skip a bad row */ } }
  let p = listPreview(bodies, r.kind === 'room');
  // With AI summaries on (Settings › General), the bot's own words give way to the saved summary.
  if (p && (p.by === 'bot' || p.by === 'member') && getSummaryPrefs(r.user_id).on) {
    const s = savedSummary(r.id, r.generation);
    if (s) p = { text: s, short: s, forms: [s], by: 'summary' };
  }
  return {
    id: r.id,
    name: r.name,
    label: r.label,
    description: r.description,
    instructions: r.instructions,
    avatarShape: r.avatar_shape,
    avatarColor: r.avatar_color,
    ...chatColorOf(r),
    // `g=1` on a group's picture: a new address, so apps drop the face crop they cached before groups stopped using it.
    avatarImageUrl: r.avatar_image ? `/api/bots/${r.id}/avatar?v=${r.updated_at}${r.kind === 'room' ? '&g=1' : ''}` : null,
    // A group shows its picture as is: poses redraw one character, so they would show a single member.
    avatarPoses: r.avatar_image && r.kind !== 'room' ? posesOf(r.id) : {},
    avatarPoseJob: r.avatar_image && r.kind !== 'room' ? poseJobOf(r.avatar_pose_job) : null,
    mode: r.mode,
    isPrimary: !!r.is_primary,
    kind: r.kind === 'room' ? 'room' : 'agent',
    ...outsideInfo(r),
    pinned: !!r.pinned,
    ownerHidden: !!r.owner_hidden,
    effort: r.effort,
    ...(r.kind === 'room' ? {} : { visuals: visualsOf(r.visuals) }),
    ...(r.kind === 'room' ? {} : { webSearch: r.web_search !== 0 }),
    // Phone timers and alarms (phone.ts): NULL = on for Leonard only.
    ...(r.kind === 'room' ? {} : { phoneActions: r.phone_actions === 1 || (r.phone_actions == null && String(r.name).trim().toLowerCase() === 'leonard') }),
    busySend: busySendOf(r.busy_send),
    voice: r.voice ?? 'luna',
    voiceSpeed: r.voice_speed ?? 1,
    voiceLanguage: r.voice_language ?? 'auto',
    model: r.model ?? null,
    provider: r.provider ?? null,
    modelMode: r.model_mode === 'auto' ? 'auto' : 'manual',
    modelTiers: cleanTiers(r.model_tiers),
    providerLock: r.provider_lock ?? null,
    generation: r.generation,
    unread: r.unread,
    ...sideSummary(r),
    lastPreview: p?.text ?? null,
    previewShort: p?.short ?? null,
    previewForms: p ? (p.forms ?? [p.text, p.short].filter((x, i, a) => a.indexOf(x) === i)) : null,
    previewBy: p?.by ?? null,
    lastActivityAt: last?.created_at ?? r.updated_at,
    createdAt: r.created_at,
  };
}

/** A bot's colour in chats: the one set in its settings, or one picked apart from its account's other bots. */
function chatColorOf(r: any): Pick<Bot, 'chatColor' | 'chatColorAuto'> {
  if (r.kind === 'room') return { chatColor: null, chatColorAuto: false };
  const id = r.side_of || r.id;
  // The colours depend on all of the account's bots: worked out once for a whole list, not once per bot.
  const memo = listColors && listColors.userId === r.user_id ? listColors : null;
  let picked = memo?.picked ?? null;
  if (!picked) {
    const all = db.prepare("SELECT id, chat_color, avatar_color, created_at FROM bots WHERE user_id=? AND side_of IS NULL AND COALESCE(kind,'agent')<>'room'").all(r.user_id) as any[];
    picked = assignChatColors(all.map((b) => ({ id: b.id, chatColor: b.chat_color, avatarColor: b.avatar_color, createdAt: b.created_at })));
    if (memo) memo.picked = picked;
  }
  return { chatColor: picked[id] ?? null, chatColorAuto: !isChatColor(r.chat_color) };
}

/** Unread replies and running work in a bot's side chats, for its row in the list. */
function sideSummary(r: any): Pick<Bot, 'sideChats'> | {} {
  if (r.kind === 'room' || r.side_of) return {};
  const s = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(unread),0) unread FROM bots WHERE side_of=? AND chat_deleted_at IS NULL').get(r.id) as { n: number; unread: number };
  if (!s.n) return {};
  const ids = (db.prepare('SELECT id FROM bots WHERE side_of=? AND chat_deleted_at IS NULL').all(r.id) as { id: string }[]).map((x) => x.id);
  return { sideChats: { count: s.n, unread: s.unread, running: ids.filter((id) => getLive(id).isRunning).length } };
}

function posesOf(botId: string): Bot['avatarPoses'] {
  const out: Bot['avatarPoses'] = {};
  for (const p of db.prepare('SELECT pose, made_at FROM avatar_poses WHERE bot_id=?').all(botId) as { pose: AvatarPose; made_at: number }[]) {
    out[p.pose] = `/api/bots/${botId}/avatar/poses/${p.pose}?v=${p.made_at}`;
  }
  return out;
}

function poseJobOf(raw: string | null): AvatarPoseJob | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as AvatarPoseJob; } catch { return null; }
}

function outsideInfo(r: any): Pick<Bot, 'outside' | 'waitingFor'> {
  const o = r.kind === 'room' ? null : outsideFor(r.id);
  if (o) return { outside: { via: o.via, channelName: o.channelName, status: linkStatus(r.id), waiting: waitingCount(r.id), callUrl: o.callUrl } };
  const w = waitingFor(r.id);
  return w.length ? { waitingFor: w } : {};
}

/**
 * A side chat's own columns: its conversation and its place in the list. Everything else (name, look,
 * instructions, model, engine, voice...) comes from the bot it belongs to, so a side chat is always the
 * same bot as its main chat and settings changed there apply to every chat at once.
 */
const SIDE_OWN = ['id', 'generation', 'next_seq', 'rev', 'unread', 'created_at', 'updated_at', 'hidden', 'side_of', 'chat_title', 'chat_titled', 'chat_deleted_at', 'pending_feedback', 'handback_at', 'auto_state'];

const rawBot = (id: string) => db.prepare('SELECT * FROM bots WHERE id=?').get(id) as any;

/** The bot's row; for a side chat, its bot's row with the side chat's own columns (SIDE_OWN) on top. */
export const getBotRow = (id: string) => {
  const r = rawBot(id);
  if (!r?.side_of) return r;
  const owner = rawBot(r.side_of);
  if (!owner) return r;
  const merged = { ...owner };
  for (const k of SIDE_OWN) merged[k] = r[k];
  return merged;
};

/** The bot a chat belongs to: itself, or for a side chat the bot it is a side chat of. */
export const chatOwner = (id: string): string => (db.prepare('SELECT side_of FROM bots WHERE id=?').get(id) as any)?.side_of ?? id;
export const getBot = (id: string) => {
  const r = getBotRow(id);
  return r ? toBot(r) : null;
};
/** Set while a whole list is being made (listBots), so chatColorOf asks the database once for all of it. */
let listColors: { userId: string; picked: ReturnType<typeof assignChatColors> | null } | null = null;
export const listBots = (userId: string) => {
  const rows = db.prepare('SELECT * FROM bots WHERE user_id=? AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at ASC').all(userId) as any[];
  listColors = { userId, picked: null };
  try { return rows.map(toBot); } finally { listColors = null; }
};

const sideEmitters: ((ownerId: string) => void)[] = [];
/** side-chats.ts tells the apps about a changed side chat this way (store.ts cannot import it). */
export const onSideChatChange = (fn: (ownerId: string) => void) => { sideEmitters.push(fn); };

export function emitBot(botId: string) {
  const r = getBotRow(botId);
  if (!r) return;
  // A side chat is not a bot of its own in the apps' lists: its bot's side chat list changes instead.
  if (r.side_of) {
    for (const fn of sideEmitters) { try { fn(r.side_of); } catch (e) { console.warn('[side-chats] emit failed', e); } }
    const owner = rawBot(r.side_of);
    if (owner) hub.emit(owner.user_id, { type: 'bot', bot: toBot(owner) });
    return;
  }
  hub.emit(r.user_id, { type: 'bot', bot: toBot(r) });
}

// ---------- rows ----------

function toRow(r: any): Row {
  return { botId: r.bot_id, generation: r.generation, seq: r.seq, updatedSeq: r.updated_seq, kind: r.kind, body: JSON.parse(r.body), createdAt: r.created_at };
}

function bumpRev(botId: string): number {
  db.prepare('UPDATE bots SET rev = rev + 1, updated_at=? WHERE id=?').run(now(), botId);
  return (db.prepare('SELECT rev FROM bots WHERE id=?').get(botId) as any).rev;
}

/** Append a new row. Returns its seq. */
/** A chat deleted while something was still writing to it: a plain error rather than a TypeError. */
function needBot<T>(b: T | undefined | null, botId: string): T {
  if (!b) throw new Error(`No chat ${botId} (it was deleted)`);
  return b;
}

export function appendRow(botId: string, kind: RowKind, body: RowBody): Row {
  const tx = db.transaction(() => {
    const b = needBot(db.prepare('SELECT user_id, generation, next_seq FROM bots WHERE id=?').get(botId) as any, botId);
    const seq = b.next_seq;
    db.prepare('UPDATE bots SET next_seq = next_seq + 1 WHERE id=?').run(botId);
    const rev = bumpRev(botId);
    const t = now();
    db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)').run(botId, b.generation, seq, rev, kind, JSON.stringify(body), t);
    return { userId: b.user_id as string, row: { botId, generation: b.generation, seq, updatedSeq: rev, kind, body, createdAt: t } as Row };
  });
  const { userId, row } = tx();
  hub.emit(userId, { type: 'rows', botId, generation: row.generation, rows: [row] });
  return row;
}

/** Rewrite an existing row's body (e.g. streaming text, card status). */
export function updateRow(botId: string, seq: number, body: RowBody): Row | null {
  const tx = db.transaction(() => {
    const b = db.prepare('SELECT user_id, generation FROM bots WHERE id=?').get(botId) as any;
    if (!b) return null;
    const existing = db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq=?').get(botId, b.generation, seq) as any;
    if (!existing) return null;
    const rev = bumpRev(botId);
    db.prepare('UPDATE rows SET body=?, updated_seq=? WHERE bot_id=? AND generation=? AND seq=?').run(JSON.stringify(body), rev, botId, b.generation, seq);
    return { userId: b.user_id as string, row: { ...toRow(existing), body, updatedSeq: rev } as Row };
  });
  const res = tx();
  if (!res) return null;
  hub.emit(res.userId, { type: 'rows', botId, generation: res.row.generation, rows: [res.row] });
  return res.row;
}

export function getRow(botId: string, seq: number): Row | null {
  const b = getBotRow(botId);
  if (!b) return null;
  const r = db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq=?').get(botId, b.generation, seq);
  return r ? toRow(r) : null;
}

export function listRows(botId: string, opts: { beforeSeq?: number; limit?: number; afterRev?: number } = {}): Row[] {
  const b = getBotRow(botId);
  if (!b) return [];
  if (opts.afterRev !== undefined) {
    return (db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND updated_seq>? ORDER BY seq ASC').all(botId, b.generation, opts.afterRev) as any[]).map(toRow);
  }
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 200) || 200, 500));
  const rows = (opts.beforeSeq
    ? db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq<? ORDER BY seq DESC LIMIT ?').all(botId, b.generation, opts.beforeSeq, limit)
    : db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? ORDER BY seq DESC LIMIT ?').all(botId, b.generation, limit)) as any[];
  return rows.reverse().map(toRow);
}

/** When each bot's chat was last cleared, and the conversation it replaced, so "New conversation" can be undone for a while (memory only). */
const lastCleared = new Map<string, { generation: number; prev: number; at: number }>();
/** How long "New conversation" can be undone, as long as nothing has been said in the new chat. */
export const UNDO_FRESH_MS = 10 * 60_000;

/**
 * The number a new conversation gets: one past every conversation the chat has ever had. After an earlier
 * conversation was reopened (openConversation) the chat's own number is no longer its highest.
 */
function nextGeneration(botId: string, current: number): number {
  const rows = (db.prepare('SELECT MAX(generation) m FROM rows WHERE bot_id=?').get(botId) as any).m ?? 0;
  const items = (db.prepare('SELECT MAX(generation) m FROM llm_items WHERE bot_id=?').get(botId) as any).m ?? 0;
  return Math.max(current, rows, items) + 1;
}

export function clearConversation(botId: string) {
  // Read and move the generation in one step, so two clears at once never land on the same one.
  const { b, next } = db.transaction(() => {
    const b = needBot(getBotRow(botId), botId);
    const next = nextGeneration(botId, b.generation);
    db.prepare('UPDATE bots SET generation = ?, next_seq = 1 WHERE id=?').run(next, botId);
    db.prepare('DELETE FROM pending_turns WHERE bot_id=?').run(botId);
    return { b, next };
  })();
  lastCleared.set(botId, { generation: next, prev: b.generation, at: now() });
  hub.emit(b.user_id, { type: 'cleared', botId, generation: next });
}

/** Put the chat on one of its conversations: its rows, model history and engine thread are keyed by generation. */
function switchGeneration(botId: string, generation: number) {
  const max = (db.prepare('SELECT MAX(seq) m FROM rows WHERE bot_id=? AND generation=?').get(botId, generation) as any).m ?? 0;
  db.prepare('UPDATE bots SET generation = ?, next_seq = ? WHERE id=?').run(generation, max + 1, botId);
  db.prepare('DELETE FROM pending_turns WHERE bot_id=?').run(botId);
  bumpRev(botId);
}

/**
 * Undo "New conversation": the chat goes back to the conversation it replaced, rows, model history and
 * the engine's thread (keyed by generation) included. Only while the new chat is still empty and for
 * UNDO_FRESH_MS after the clear; otherwise the reason is returned and nothing changes.
 */
export function restoreConversation(botId: string): { ok: true; generation: number } | { ok: false; reason: string } {
  const b = getBotRow(botId);
  if (!b) return { ok: false, reason: 'not found' };
  const last = lastCleared.get(botId);
  if (!last || last.generation !== b.generation) return { ok: false, reason: 'There is no new conversation to undo.' };
  if (now() - last.at > UNDO_FRESH_MS) return { ok: false, reason: 'Too late to undo: that was more than 10 minutes ago.' };
  const res = db.transaction(() => {
    const said = (db.prepare('SELECT COUNT(*) n FROM rows WHERE bot_id=? AND generation=?').get(botId, b.generation) as any).n
      + (db.prepare('SELECT COUNT(*) n FROM llm_items WHERE bot_id=? AND generation=?').get(botId, b.generation) as any).n;
    if (said > 0) return { ok: false as const, reason: 'Something was already said in the new conversation, so it can no longer be undone.' };
    switchGeneration(botId, last.prev);
    return { ok: true as const, generation: last.prev };
  })();
  if (res.ok) {
    lastCleared.delete(botId);
    hub.emit(b.user_id, { type: 'restored', botId, generation: res.generation });
  }
  return res;
}

// ---------- earlier conversations ----------

export interface ConversationInfo { generation: number; current: boolean; title: string; messages: number; startedAt: number; lastAt: number }

/** Every conversation this chat has had that still has something in it, newest first. */
export function listConversations(botId: string): ConversationInfo[] {
  const b = getBotRow(botId);
  if (!b) return [];
  const gens = db.prepare("SELECT generation, COUNT(*) n, MIN(created_at) first, MAX(created_at) last FROM rows WHERE bot_id=? AND kind='message' GROUP BY generation ORDER BY generation DESC").all(botId) as { generation: number; n: number; first: number; last: number }[];
  const firstUser = db.prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq ASC LIMIT 12");
  return gens.map((g) => {
    let title = '';
    for (const r of firstUser.all(botId, g.generation) as { body: string }[]) {
      try {
        const body = JSON.parse(r.body) as RowBody;
        if (body.type !== 'message' || !body.text?.trim()) continue;
        const text = body.role === 'user' ? splitReply(body.text).body : plainText(body.text);
        if (!title || body.role === 'user') title = text.replace(/\s+/g, ' ').trim().slice(0, 90);
        if (body.role === 'user') break;
      } catch { /* skip a bad row */ }
    }
    return { generation: g.generation, current: g.generation === b.generation, title: title || 'Conversation', messages: g.n, startedAt: g.first, lastAt: g.last };
  });
}

/** Rows of one conversation of a chat (the current one or an earlier one), newest `limit` before `beforeSeq`. */
export function listRowsOf(botId: string, generation: number, opts: { beforeSeq?: number; limit?: number } = {}): Row[] {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 200) || 200, 500));
  const rows = (opts.beforeSeq
    ? db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? AND seq<? ORDER BY seq DESC LIMIT ?').all(botId, generation, opts.beforeSeq, limit)
    : db.prepare('SELECT * FROM rows WHERE bot_id=? AND generation=? ORDER BY seq DESC LIMIT ?').all(botId, generation, limit)) as any[];
  return rows.reverse().map(toRow);
}

/**
 * Delete one earlier conversation for good: its messages, cards and the model's record of it. The
 * conversation that is open cannot be deleted this way. Returns how many rows went.
 */
export function deleteConversation(botId: string, generation: number): { ok: true; rows: number } | { ok: false; reason: string } {
  const b = getBotRow(botId);
  if (!b) return { ok: false, reason: 'not found' };
  if (generation === b.generation) return { ok: false, reason: 'That is the conversation open now. Start a new conversation first, then delete this one.' };
  let rows = 0;
  db.transaction(() => {
    rows = db.prepare('DELETE FROM rows WHERE bot_id=? AND generation=?').run(botId, generation).changes;
    db.prepare('DELETE FROM llm_items WHERE bot_id=? AND generation=?').run(botId, generation);
    try { db.prepare('DELETE FROM compactions WHERE bot_id=? AND generation=?').run(botId, generation); } catch { /* table made later */ }
  })();
  if (!rows) return { ok: false, reason: 'That conversation is no longer there.' };
  return { ok: true, rows };
}

/**
 * Reopen an earlier conversation: the chat continues it (its rows, model history and engine thread come back),
 * and the conversation that was open stays in the list of earlier ones. Nothing is deleted either way.
 */
export function openConversation(botId: string, generation: number): { ok: true; generation: number } | { ok: false; reason: string } {
  const b = getBotRow(botId);
  if (!b) return { ok: false, reason: 'not found' };
  if (generation === b.generation) return { ok: true, generation };
  const has = (db.prepare('SELECT COUNT(*) n FROM rows WHERE bot_id=? AND generation=?').get(botId, generation) as any).n;
  if (!has) return { ok: false, reason: 'That conversation is no longer there.' };
  db.transaction(() => switchGeneration(botId, generation))();
  lastCleared.delete(botId);
  hub.emit(b.user_id, { type: 'restored', botId, generation });
  return { ok: true, generation };
}

// ---------- LLM history (Responses API input items) ----------

export function loadHistory(botId: string): any[] {
  const b = getBotRow(botId);
  if (!b) return [];
  return (db.prepare('SELECT item FROM llm_items WHERE bot_id=? AND generation=? ORDER BY idx ASC').all(botId, b.generation) as any[]).map((r) => JSON.parse(r.item));
}

export function appendHistory(botId: string, items: any[]) {
  if (!items.length) return;
  const ins = db.prepare('INSERT INTO llm_items(bot_id,generation,idx,item) VALUES (?,?,?,?)');
  // The next index is read inside the same transaction as the inserts, so two writers never collide.
  db.transaction(() => {
    const b = needBot(getBotRow(botId), botId);
    const start = ((db.prepare('SELECT MAX(idx) m FROM llm_items WHERE bot_id=? AND generation=?').get(botId, b.generation) as any).m ?? -1) + 1;
    items.forEach((it, i) => ins.run(botId, b.generation, start + i, JSON.stringify(it)));
  })();
}

// ---------- live state ----------

const live = new Map<string, LiveState>();

export function getLive(botId: string): LiveState {
  return live.get(botId) ?? { botId, isRunning: false, activity: null, awaiting: null, startedAt: null };
}

const liveListeners: ((botId: string) => void)[] = [];
/** Called after any bot's live state changes (room-runs.ts follows its members this way). */
export const onLive = (fn: (botId: string) => void) => { liveListeners.push(fn); };

export function setLive(botId: string, patch: Partial<LiveState>) {
  const next = { ...getLive(botId), ...patch, botId };
  live.set(botId, next);
  const b = getBotRow(botId);
  if (b) hub.emit(b.user_id, { type: 'live', state: next });
  for (const fn of liveListeners) { try { fn(botId); } catch (e) { console.warn('[live] listener failed', e); } }
}

export const allLive = (userId: string) => listBots(userId).map((b) => getLive(b.id));

// ---------- routines / tasks ----------

export function describeCron(expr: string): string {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return expr;
  const [m, h, dom, mon, dow] = p;
  const time = /^\d+$/.test(m) && /^\d+$/.test(h) ? new Date(2000, 0, 1, +h, +m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
  if (time && dom === '*' && mon === '*' && dow === '*') return `Every day at ${time}`;
  if (time && dom === '*' && mon === '*' && dow === '1-5') return `Weekdays at ${time}`;
  if (time && dom === '*' && mon === '*' && /^[0-6]$/.test(dow)) return `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][+dow]} at ${time}`;
  if (m === '0' && h === '*') return 'Every hour';
  if (/^\*\/\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${m.slice(2)} minutes`;
  if (m === '0' && /^\*\/\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') return `Every ${h.slice(2)} hours`;
  return expr;
}

function describeEventSlug(schedule: string) {
  const words = schedule.slice(6).split('_');
  const app = words.shift() ?? '';
  return `When ${app.charAt(0) + app.slice(1).toLowerCase()}: ${words.join(' ').toLowerCase()}`;
}

export function toRoutine(r: any): Routine {
  let nextRunAt: number | null = null;
  try {
    nextRunAt = r.enabled ? new Cron(r.schedule, { timezone: r.timezone, paused: true }).nextRun()?.getTime() ?? null : null;
  } catch { /* invalid cron */ }
  return {
    id: r.id, botId: r.bot_id, name: r.name, prompt: r.prompt, schedule: r.schedule, timezone: r.timezone,
    enabled: !!r.enabled, nextRunAt, lastRunAt: r.last_run_at, description: r.schedule.startsWith('event:') ? describeEventSlug(r.schedule) : describeCron(r.schedule),
    quiet: r.quiet === undefined ? true : !!r.quiet,
    failCount: r.fail_count ?? 0, lastError: r.last_error ?? null, autoOffAt: r.auto_off_at ?? null,
  };
}

export const listRoutines = (botId: string) => (db.prepare('SELECT * FROM routines WHERE bot_id=? ORDER BY created_at').all(botId) as any[]).map(toRoutine);

/** A task still marked "working" that its bot has not touched for this long while idle is shown as stalled. */
export const TASK_STALE_MS = 6 * 60 * 60 * 1000;
/**
 * Whether a task looks abandoned: the bot said "working" but has not updated it in hours and is not running now
 * (a turn cut off, a restart, or work finished some other way). The apps say so and offer Done or Delete.
 */
export const taskStale = (r: { bot_id: string; state: string; updated_at: number }, at = Date.now()) =>
  r.state === 'working' && at - r.updated_at > TASK_STALE_MS && !getLive(r.bot_id).isRunning;
export const toTask = (r: any): Task => ({ id: r.id, botId: r.bot_id, title: r.title, state: r.state, note: r.note, updatedAt: r.updated_at, ...(taskStale(r) ? { stale: true } : {}) });
export const listTasks = (botId: string) => (db.prepare('SELECT * FROM tasks WHERE bot_id=? ORDER BY updated_at DESC').all(botId) as any[]).map(toTask);
